/* A to B routing. Its own logic, separate from the loop solver (solver.worker.js).
 *
 * Plain route: the best way from A to B (route).
 * Route builder: ride a chosen set of new roads between A and B (cover); choosing the roads comes next.
 *   - one-way streets ridden legally
 *   - Smooth riding: turns and U-turns cost extra distance while planning (style.turn / style.uturn)
 *   - Skip unpaved: unpaved roads count as UNPAVED_W times their length
 * The search runs on arcs (a road ridden in one direction), so the cost of each turn is exact.
 *
 * in:  {type:"network", nodes, edges}
 *      {type:"route", start:[lon,lat], end:[lon,lat], style:{turn, uturn, skipUnpaved}, distanceM?}
 *      distanceM: ride distance (0 or missing = most direct route)
 *      {type:"cover", start, end, req:[edge ids], style}   (route builder, used for testing so far)
 * out: {progress} | {error} | {result, final:true}
 */
const UNPAVED_W = 5;                    // same weighting as Loop
const TURN = 35 * Math.PI / 180;        // sharper than this counts as a turn
const UTURN = 150 * Math.PI / 180;      // sharper than this counts as a U-turn
const MPD = 111195.08;                  // metres per degree of latitude

let NET = null;   // { nodes, edges, outArcs, hStart, hEnd }
const say = msg => self.postMessage({ progress: msg });
const mi = m => (Math.ceil(m / 160.9344) / 10).toFixed(1);   // rounded up, so "at least" is honest

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === "network") NET = index(m.nodes, m.edges);
    else if (m.type === "route") {
      const t0 = performance.now();
      const r = route(m.start, m.end, m.style || {});
      if (m.distanceM > 0 && m.distanceM < r.totalM - 1)
        throw new Error(`The most direct route from A to B is ${mi(r.totalM)} mi. Set Ride distance to at least that, or leave it blank.`);
      r.distanceM = m.distanceM > 0 ? m.distanceM : 0;
      r.ms = Math.round(performance.now() - t0);
      self.postMessage({ result: r, final: true });
    } else if (m.type === "cover") {
      const t0 = performance.now(), st = m.style || {};
      const A = snap(m.start, "the start (A)"), B = snap(m.end, "the end (B)");
      const r = measure(cover(A.node, B.node, m.req, st), A, B);
      r.ms = Math.round(performance.now() - t0);
      self.postMessage({ result: r, final: true });
    }
  } catch (err) {
    console.error(err);
    self.postMessage({ error: err.message || String(err) });
  }
};

/* ---------- network: arcs and headings ---------- */
// arc a = 2*edge + dir; dir 0 rides u -> v, dir 1 rides v -> u
const edgeOf = a => a >> 1;
const fromOf = (E, a) => (a & 1 ? E[a >> 1].v : E[a >> 1].u);
const toOf = (E, a) => (a & 1 ? E[a >> 1].u : E[a >> 1].v);
const legal = (ed, dir) => ed.oneway === 0 || (ed.oneway === 1 ? dir === 0 : dir === 1);

function index(nodes, edges) {
  const n = nodes.length;
  // outgoing legal arcs per node (CSR)
  const count = new Int32Array(n + 1);
  edges.forEach((ed, i) => { if (legal(ed, 0)) count[ed.u + 1]++; if (legal(ed, 1)) count[ed.v + 1]++; });
  for (let i = 0; i < n; i++) count[i + 1] += count[i];
  const fill = count.slice(0, n), arcs = new Int32Array(count[n]);
  edges.forEach((ed, i) => {
    if (legal(ed, 0)) arcs[fill[ed.u]++] = 2 * i;
    if (legal(ed, 1)) arcs[fill[ed.v]++] = 2 * i + 1;
  });
  // heading leaving each end of a road, taken ~15 m in so a kink at the corner doesn't count
  const heading = (c, from, dir) => {
    const [x0, y0] = c[from], k0 = Math.cos(y0 * Math.PI / 180);
    let k = from;
    for (;;) {
      const nk = k + dir; if (nk < 0 || nk >= c.length) break; k = nk;
      const dx = (c[k][0] - x0) * k0 * MPD, dy = (c[k][1] - y0) * MPD;
      if (dx * dx + dy * dy > 225) break;
    }
    return Math.atan2(c[k][1] - y0, (c[k][0] - x0) * k0);
  };
  const hStart = new Float64Array(2 * edges.length);   // heading as the arc sets off
  const hEnd = new Float64Array(2 * edges.length);     // heading as the arc arrives
  edges.forEach((ed, i) => {
    const leaveU = heading(ed.coords, 0, 1), leaveV = heading(ed.coords, ed.coords.length - 1, -1);
    hStart[2 * i] = leaveU; hEnd[2 * i] = leaveV + Math.PI;
    hStart[2 * i + 1] = leaveV; hEnd[2 * i + 1] = leaveU + Math.PI;
  });
  // every arc, legal or not (for undirected joining and pairing)
  const ucount = new Int32Array(n + 1);
  edges.forEach(ed => { ucount[ed.u + 1]++; ucount[ed.v + 1]++; });
  for (let i = 0; i < n; i++) ucount[i + 1] += ucount[i];
  const ufill = ucount.slice(0, n), uarcs = new Int32Array(ucount[n]);
  edges.forEach((ed, i) => { uarcs[ufill[ed.u]++] = 2 * i; uarcs[ufill[ed.v]++] = 2 * i + 1; });
  return { nodes, edges, outStart: count, outArcs: arcs, allStart: ucount, allArcs: uarcs, hStart, hEnd };
}

/** angle (0..PI) between arriving on arc a and leaving on arc b; PI = U-turn */
function turnAngle(a, b) {
  if (edgeOf(a) === edgeOf(b)) return Math.PI;
  let d = Math.abs(NET.hStart[b] - NET.hEnd[a]) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/* ---------- snapping: nearest junction or road end that has a legal way in and out ---------- */
function snap([lon, lat], label) {
  const { nodes, outStart } = NET, k0 = Math.cos(lat * Math.PI / 180);
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    if (outStart[i + 1] === outStart[i]) continue;   // no legal way out
    const dx = (nodes[i][0] - lon) * k0 * MPD, dy = (nodes[i][1] - lat) * MPD, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  if (best < 0) throw new Error(`No rideable road near ${label}.`);
  return { node: best, offM: Math.sqrt(bd) };
}

/* ---------- the route ---------- */
function route(startLL, endLL, style) {
  if (!NET) throw new Error("The road network isn't loaded yet.");
  say("Finding the route from A to B...");
  const { edges, outStart, outArcs } = NET;
  const A = snap(startLL, "the start (A)"), B = snap(endLL, "the end (B)");
  if (A.node === B.node) throw new Error("A and B are at the same spot. Move one of them.");

  const turnW = style.turn || 0, uturnW = style.uturn || 0, skip = !!style.skipUnpaved;
  const w = a => { const ed = edges[edgeOf(a)]; return ed.len * (skip && ed.unpaved ? UNPAVED_W : 1); };
  const tcost = (a, b) => {
    if (!turnW && !uturnW) return 0;
    const t = turnAngle(a, b);
    return t > UTURN ? uturnW : t > TURN ? turnW : 0;
  };

  // Dijkstra over arcs: dist[a] = cost once arc a has been ridden
  const nA = 2 * edges.length;
  const dist = new Float64Array(nA).fill(Infinity), prev = new Int32Array(nA).fill(-1);
  const heap = new Heap();
  for (let p = outStart[A.node]; p < outStart[A.node + 1]; p++) {
    const a = outArcs[p]; dist[a] = w(a); heap.push(dist[a], a);
  }
  let goal = -1;
  while (heap.size) {
    const d = heap.topKey(), a = heap.pop();
    if (d > dist[a]) continue;
    const x = toOf(edges, a);
    if (x === B.node) { goal = a; break; }
    for (let p = outStart[x]; p < outStart[x + 1]; p++) {
      const b = outArcs[p], nd = d + w(b) + tcost(a, b);
      if (nd < dist[b]) { dist[b] = nd; prev[b] = a; heap.push(nd, b); }
    }
  }
  if (goal < 0) throw new Error("No legal way from A to B on the road network.");

  const path = [];
  for (let a = goal; a >= 0; a = prev[a]) path.push(a);
  path.reverse();
  return measure(path, A, B);
}

/** Turn a list of arcs into the result the page shows. */
function measure(path, A, B) {
  const { edges } = NET;
  const coords = [], seen = new Map();
  let total = 0, turns = 0, uturns = 0, unpavedM = 0;
  path.forEach((a, k) => {
    const ed = edges[edgeOf(a)], seg = a & 1 ? ed.coords.slice().reverse() : ed.coords;
    for (let i = coords.length ? 1 : 0; i < seg.length; i++) coords.push(seg[i]);
    total += ed.len;
    if (ed.unpaved) unpavedM += ed.len;
    seen.set(edgeOf(a), (seen.get(edgeOf(a)) || 0) + 1);
    if (k) { const t = turnAngle(path[k - 1], a); if (t > UTURN) uturns++; else if (t > TURN) turns++; }
  });
  let newM = 0, repeat = 0;
  for (const [e, c] of seen) { newM += edges[e].newM; repeat += (c - 1) * edges[e].len; }

  return { mode: "ab", coords, totalM: total, newM, repeatM: repeat, turns, uturns, unpavedM,
           snapAM: A.offM, snapBM: B.offM, tries: 1 };
}

/* ---------- route builder: ride every road in req, starting at A and ending at B ----------
 * 1. join: connect every chosen road (and B) to A's piece with the shortest connecting roads
 * 2. odd junctions: a ride from A to B leaves A once more than it enters, enters B once more than it
 *    leaves, and everywhere else enters as often as it leaves; add the cheapest extra connectors so the
 *    junction counts allow that
 * 3. directions: a ride through the result sets a direction for each two-way road; one-way streets
 *    keep their legal direction; legal connectors are added wherever ins and outs still don't match
 * 4. string it into one ride from A to B, going straight through junctions where it can */
const K_NEAR = 12;
const TRIES = 30;   // stringings tried per road set

/** Dijkstra on nodes. arcsOf: "all" (ignore one-ways) or "legal". Returns a small search object. */
function makeSearch(n) {
  const dist = new Float64Array(n), prevArc = new Int32Array(n), stamp = new Int32Array(n), heap = new Heap();
  let cur = 0;
  return {
    d: x => (stamp[x] === cur ? dist[x] : Infinity),
    run(sources, mode, w, onSettle) {
      const S = mode === "all" ? NET.allStart : NET.outStart, Ar = mode === "all" ? NET.allArcs : NET.outArcs, E = NET.edges;
      cur++; heap.k.length = 0; heap.v.length = 0;
      for (const s of sources) { stamp[s] = cur; dist[s] = 0; prevArc[s] = -1; heap.push(0, s); }
      while (heap.size) {
        const dx = heap.topKey(), x = heap.pop();
        if (dx > dist[x]) continue;
        if (onSettle && onSettle(x, dx)) return x;
        for (let p = S[x]; p < S[x + 1]; p++) {
          const a = Ar[p], y = toOf(E, a), nd = dx + w(a);
          if (stamp[y] !== cur || nd < dist[y]) { stamp[y] = cur; dist[y] = nd; prevArc[y] = a; heap.push(nd, y); }
        }
      }
      return -1;
    },
    /** arcs from the run's sources to x */
    path(x) { const out = []; for (; prevArc[x] >= 0; x = fromOf(NET.edges, prevArc[x])) out.push(prevArc[x]); return out.reverse(); },
  };
}

function cover(A, B, req, style, tries = TRIES) {
  const { edges, nodes } = NET, n = nodes.length;
  const skip = !!style.skipUnpaved;
  const w = a => { const ed = edges[edgeOf(a)]; return ed.len * (skip && ed.unpaved ? UNPAVED_W : 1); };
  if (!cover.S || cover.n !== n) { cover.S = makeSearch(n); cover.n = n; }   // reused between calls
  const SS = cover.S;

  // ---- 1. join ----
  const uses = req.map(e => 2 * e);           // undirected uses, stored as arcs (direction fixed later)
  const parent = new Int32Array(n).map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const touched = new Set([A, B]);
  for (const e of req) { parent[find(edges[e].u)] = find(edges[e].v); touched.add(edges[e].u); touched.add(edges[e].v); }
  const members = new Map();
  for (const x of touched) { const r = find(x); if (!members.has(r)) members.set(r, []); members.get(r).push(x); }
  const joined = new Uint8Array(n), joinedList = [];
  const absorb = r => { for (const x of members.get(r)) if (!joined[x]) { joined[x] = 1; joinedList.push(x); } members.delete(r); };
  absorb(find(A));
  while (members.size) {
    const hit = SS.run(joinedList, "all", w, x => !joined[x] && touched.has(x));
    if (hit < 0) throw new Error("Some of the chosen roads can't be reached from A.");
    for (const a of SS.path(hit)) {
      uses.push(a);
      const y = toOf(edges, a); if (!joined[y]) { joined[y] = 1; joinedList.push(y); }
    }
    absorb(find(hit));
  }

  // ---- 2. odd junctions ----
  const deg = new Map();
  const bump = x => deg.set(x, (deg.get(x) || 0) + 1);
  for (const a of uses) { bump(edges[edgeOf(a)].u); bump(edges[edgeOf(a)].v); }
  const want = x => (x === A || x === B ? 1 : 0);
  const odd = [...new Set([...deg.keys(), A, B])].filter(x => ((deg.get(x) || 0) & 1) !== want(x));
  const isOdd = new Set(odd), dist = new Map();
  const cand = odd.map(s => {
    const list = [];
    SS.run([s], "all", w, (x, d) => {
      if (x !== s && isOdd.has(x)) { list.push([x, d]); dist.set(s + ":" + x, d); }
      return list.length >= K_NEAR;
    });
    return list;
  });
  // greedy pairing, shortest first
  const all = [];
  odd.forEach((s, i) => cand[i].forEach(([t, d]) => all.push([d, s, t])));
  all.sort((p, q) => p[0] - q[0]);
  const mate = new Map();
  for (const [, s, t] of all) if (!mate.has(s) && !mate.has(t)) { mate.set(s, t); mate.set(t, s); }
  for (const s of odd) {   // anyone left: nearest unpaired
    if (mate.has(s)) continue;
    const t = SS.run([s], "all", w, x => x !== s && isOdd.has(x) && !mate.has(x));
    if (t < 0) throw new Error("Couldn't pair up the junctions.");
    mate.set(s, t); mate.set(t, s); dist.set(s + ":" + t, SS.d(t));
  }
  // improve: swap partners between two pairs when that's shorter (2-opt on known distances)
  const D = (a, b) => dist.get(a + ":" + b) ?? dist.get(b + ":" + a) ?? Infinity;
  const pairs = []; for (const [s, t] of mate) if (s < t) pairs.push([s, t]);
  for (let pass = 0, better = true; better && pass < 4; pass++) {
    better = false;
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const [a, b] = pairs[i], [c, d] = pairs[j], now = D(a, b) + D(c, d);
      if (D(a, c) + D(b, d) < now - 1) { pairs[i] = [a, c]; pairs[j] = [b, d]; better = true; }
      else if (D(a, d) + D(b, c) < now - 1) { pairs[i] = [a, d]; pairs[j] = [b, c]; better = true; }
    }
  }
  for (const [s, t] of pairs) { SS.run([s], "all", w, x => x === t); uses.push(...SS.path(t)); }

  // steps 3 and 4 decide where the ride turns around, and take milliseconds, so try several
  // stringings (different direction choices and tie-breaks) and keep the best by Smooth riding cost
  const build = rng => {
    // ---- 3. directions ----
    // a ride through the undirected result (A to B) gives each two-way road a direction
    const trail = eulerPath(uses, A, B, false, rng);
    const arcs = trail.map(a => (legal(edges[edgeOf(a)], a & 1) ? a : a ^ 1));
    const bal = new Map();
    const add = (x, v) => bal.set(x, (bal.get(x) || 0) + v);
    for (const a of arcs) { add(fromOf(edges, a), 1); add(toOf(edges, a), -1); }
    add(A, -1); add(B, 1);      // A should end +1, B -1
    // nodes with bal < 0 need extra ways out; bal > 0 need extra ways in
    const needOut = [], needIn = new Map();
    for (const [x, v] of bal) { if (v < 0) for (let k = 0; k < -v; k++) needOut.push(x); else if (v > 0) needIn.set(x, v); }
    const options = [];
    for (const s of new Set(needOut)) {
      let found = 0;
      SS.run([s], "legal", w, (x, d) => { if (x !== s && needIn.has(x)) { options.push([d, s, x]); found++; } return found >= K_NEAR; });
    }
    options.sort((p, q) => p[0] - q[0]);
    const outLeft = new Map(); for (const s of needOut) outLeft.set(s, (outLeft.get(s) || 0) + 1);
    const inLeft = new Map(needIn);
    const link = (s, t) => { SS.run([s], "legal", w, x => x === t); arcs.push(...SS.path(t)); };
    for (const [, s, t] of options) {
      while ((outLeft.get(s) || 0) > 0 && (inLeft.get(t) || 0) > 0) {
        link(s, t); outLeft.set(s, outLeft.get(s) - 1); inLeft.set(t, inLeft.get(t) - 1);
      }
    }
    for (const [s, k] of outLeft) for (let i = 0; i < k; i++) {   // leftovers: nearest one still needing a way in
      const t = SS.run([s], "legal", w, x => x !== s && (inLeft.get(x) || 0) > 0);
      if (t < 0) throw new Error("Couldn't balance one-way streets.");
      arcs.push(...SS.path(t)); inLeft.set(t, inLeft.get(t) - 1);
    }

    // ---- 4. one ride, A to B, then swap avoidable U-turns for a loop round the block ----
    return cleanupUturns(eulerPath(arcs, A, B, true, rng), style);
  };
  let best = null, bestCost = Infinity;
  for (let t = 0; t < tries; t++) {
    const walk = build(t ? mulberry32(t) : null), c = rideCost(walk, style);
    if (c < bestCost) { best = walk; bestCost = c; }
  }
  return best;
}

/** What the ride costs by Smooth riding: distance plus the planning cost of its turns and U-turns. */
function rideCost(walk, style) {
  const { edges } = NET;
  let c = 0;
  for (let k = 0; k < walk.length; k++) {
    c += edges[edgeOf(walk[k])].len;
    if (k) { const t = turnAngle(walk[k - 1], walk[k]); c += t > UTURN ? (style.uturn || 0) : t > TURN ? (style.turn || 0) : 0; }
  }
  return c;
}
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** For each U-turn that isn't at a dead end, look for a loop that leaves the junction another way and
 *  comes back pointing on, and use it when it's shorter than what a U-turn is worth (Smooth riding). */
function cleanupUturns(walk, style) {
  const limit = style.uturn || 0;
  if (!limit) return walk;
  const { edges } = NET, skip = !!style.skipUnpaved;
  const w = a => { const ed = edges[edgeOf(a)]; return ed.len * (skip && ed.unpaved ? UNPAVED_W : 1); };
  const tc = (a, b) => { const t = turnAngle(a, b); return t > UTURN ? Infinity : t > TURN ? (style.turn || 0) : 0; };
  const out = [];
  for (let k = 0; k < walk.length; k++) {
    const a = out.length ? out[out.length - 1] : -1, b = walk[k];
    if (a >= 0 && turnAngle(a, b) > UTURN) {
      const x = toOf(edges, a);
      const loop = arcLoop(x, a, b, w, tc, limit);
      if (loop) out.push(...loop);
    }
    out.push(b);
  }
  return out;
}

/** Cheapest ride that leaves x after arriving on arc `inArc`, and arrives back at x so that it can carry
 *  on along `next`, with no U-turns on the way; null if none costs less than `limit`. */
function arcLoop(x, inArc, next, w, tc, limit) {
  const { edges, outStart, outArcs } = NET;
  const dist = arcLoop.dist || (arcLoop.dist = new Map()), prev = new Map();
  dist.clear();
  const heap = new Heap();
  for (let p = outStart[x]; p < outStart[x + 1]; p++) {
    const b = outArcs[p], c = w(b) + tc(inArc, b);
    if (c < limit && c < (dist.get(b) ?? Infinity)) { dist.set(b, c); prev.set(b, -1); heap.push(c, b); }
  }
  while (heap.size) {
    const d = heap.topKey(), a = heap.pop();
    if (d > (dist.get(a) ?? Infinity)) continue;
    const y = toOf(edges, a);
    if (y === x && d + tc(a, next) < limit) {
      const path = []; for (let c = a; c >= 0; c = prev.get(c)) path.push(c);
      return path.reverse();
    }
    for (let p = outStart[y]; p < outStart[y + 1]; p++) {
      const b = outArcs[p], nd = d + w(b) + tc(a, b);
      if (nd < limit && nd < (dist.get(b) ?? Infinity)) { dist.set(b, nd); prev.set(b, a); heap.push(nd, b); }
    }
  }
  return null;
}

/** Euler trail from A to B using every item once. directed=false: items are undirected uses
 *  (an arc's direction is ignored) and the result gives each its direction of travel.
 *  At each junction it prefers the straightest way on. */
function eulerPath(items, A, B, directed, rng = null) {
  const E = NET.edges;
  const out = new Map();   // node -> list of item indexes
  const push = (x, i) => { let l = out.get(x); if (!l) out.set(x, l = []); l.push(i); };
  items.forEach((a, i) => { push(fromOf(E, a), i); if (!directed) push(toOf(E, a), i); });
  const used = new Uint8Array(items.length);
  // arc for item i when leaving x
  const leave = (i, x) => { const a = items[i]; return fromOf(E, a) === x ? a : a ^ 1; };
  const stack = [[A, -1]], result = [];
  while (stack.length) {
    const [x, inArc] = stack[stack.length - 1], l = out.get(x);
    let pick = -1, bestT = Infinity;
    if (l) for (let k = l.length - 1; k >= 0; k--) {
      const i = l[k]; if (used[i]) { l[k] = l[l.length - 1]; l.pop(); continue; }
      const t = (inArc < 0 ? 0 : turnAngle(inArc, leave(i, x))) + (rng ? rng() * 0.8 : 0);
      if (t < bestT) { bestT = t; pick = i; }
    }
    if (pick < 0) { stack.pop(); if (inArc >= 0) result.push(inArc); continue; }
    used[pick] = 1;
    const a = leave(pick, x);
    stack.push([toOf(E, a), a]);
  }
  result.reverse();
  if (result.length !== items.length) throw new Error("Couldn't string the roads into one ride.");
  if (result.length && (fromOf(E, result[0]) !== A || toOf(E, result[result.length - 1]) !== B))
    throw new Error("The ride didn't end at B.");
  return result;
}

/* ---------- binary heap (min) ---------- */
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  topKey() { return this.k[0]; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}
