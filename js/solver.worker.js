/* Route solver: a legal loop from a start point that rides every new road
 * inside an area, with as few wasted and repeated miles as possible.
 * Mixed Rural Postman heuristic (port of prototype/solve_route.py, reworked
 * for speed and for repeated randomized attempts).
 *
 * Messages in:
 *   {type:"network", nodes, edges}                         once per network
 *   {type:"solve", start:[lon,lat], ring:[[lon,lat],...], penalty}   first pass
 *   {type:"optimize", seconds}                             improve the last solve
 *   {type:"stop"}                                          end optimizing early
 * Messages out:
 *   {progress:"..."}  {result:{...}, final:true|false}  {error:"..."}
 *
 * penalty: extra cost per metre of riding a road a second time (0 = pure
 * distance). It steers return trips around the block instead of back down
 * the street just ridden.
 */
const MIN_NEW_M = 5;       // ignore new-road slivers shorter than this
const MARGIN_DEG = 0.02;   // ~2 km of extra roads around the area for detours
const K_NEAR = 16;         // nearest candidates kept per junction
const NEAR_CAP_M = 10000;  // stop a nearest-candidate search past this distance

let NET = null, CTX = null, OPT = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "network") { NET = { nodes: m.nodes, edges: m.edges }; CTX = null; }
    else if (m.type === "solve") {
      if (OPT) OPT.stop = true;
      const t0 = performance.now();
      CTX = prepare(m.start, m.ring, m.penalty ?? 0.5);
      const r = attempt(CTX, null);
      CTX.best = r;
      self.postMessage({ result: pack(CTX, r, performance.now() - t0, 1), final: true });
    } else if (m.type === "optimize") optimize(m.seconds || 20);
    else if (m.type === "stop") { if (OPT) OPT.stop = true; }
  } catch (err) {
    console.error(err);
    self.postMessage({ error: err.message || String(err) });
  }
};
const say = (msg) => self.postMessage({ progress: msg });

// ---------- helpers ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, topV = v[0], lastK = k.pop(), lastV = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return topV;
  }
  topKey() { return this.k[0]; }
}

/** Reusable Dijkstra over a CSR adjacency; arrays are stamped so each run is O(visited). */
class Searcher {
  constructor(adj, n) {
    this.adj = adj; this.n = n;
    this.dist = new Float64Array(n); this.prevE = new Int32Array(n); this.prevN = new Int32Array(n);
    this.stamp = new Int32Array(n); this.cur = 0; this.heap = new Heap();
  }
  d(x) { return this.stamp[x] === this.cur ? this.dist[x] : Infinity; }
  /** onSettle(x, d) returns true to stop. */
  run(sources, onSettle) {
    const { adj, dist, prevE, prevN, stamp, heap } = this; const cur = ++this.cur;
    heap.clear();
    for (const s of sources) { stamp[s] = cur; dist[s] = 0; prevE[s] = -1; prevN[s] = -1; heap.push(0, s); }
    while (heap.size) {
      const dx = heap.topKey(), x = heap.pop();
      if (dx > dist[x]) continue;
      if (onSettle && onSettle(x, dx)) return x;
      for (let p = adj.start[x]; p < adj.start[x + 1]; p++) {
        const y = adj.to[p], nd = dx + adj.w[p];
        if (stamp[y] !== cur || nd < dist[y]) { stamp[y] = cur; dist[y] = nd; prevE[y] = adj.eid[p]; prevN[y] = x; heap.push(nd, y); }
      }
    }
    return -1;
  }
  /** steps [from, to, edge] from the run's source to target */
  path(target) {
    const steps = [];
    for (let x = target; this.prevN[x] !== -1; x = this.prevN[x]) steps.push([this.prevN[x], x, this.prevE[x]]);
    return steps.reverse();
  }
}

// ---------- preparation (once per solve) ----------
function prepare(startLonLat, ring, penalty) {
  if (!NET) throw new Error("The road network isn't loaded yet.");
  say("Preparing roads...");
  const xs = ring.map(p => p[0]), ys = ring.map(p => p[1]);
  const W = Math.min(...xs, startLonLat[0]) - MARGIN_DEG, E = Math.max(...xs, startLonLat[0]) + MARGIN_DEG;
  const S = Math.min(...ys, startLonLat[1]) - MARGIN_DEG, N = Math.max(...ys, startLonLat[1]) + MARGIN_DEG;
  const inSub = ([x, y]) => x >= W && x <= E && y >= S && y <= N;
  const local = new Map(), lonlat = [];
  const L = g => { let i = local.get(g); if (i === undefined) { i = lonlat.length; local.set(g, i); lonlat.push(NET.nodes[g]); } return i; };
  const edges = [];
  for (const ed of NET.edges) {
    if (!inSub(NET.nodes[ed.u]) || !inSub(NET.nodes[ed.v])) continue;
    const mid = ed.coords[ed.coords.length >> 1];
    const req = ed.newM >= MIN_NEW_M && pointInRing(mid, ring);
    edges.push({ u: L(ed.u), v: L(ed.v), len: ed.len, newM: ed.newM, oneway: ed.oneway, coords: ed.coords, req,
                 w: ed.len * (req ? 1 + penalty : 1) });
  }
  const n = lonlat.length;
  if (!n) throw new Error("No roads near that start point and area.");
  const allowed = (ed, from) => ed.oneway === 0 || (ed.oneway === 1 ? from === ed.u : from === ed.v);

  function buildAdj(mode) { // "u" undirected, "d" legal directed, "r" reverse of legal directed
    const arcs = [];
    edges.forEach((ed, i) => {
      for (const [a, b] of [[ed.u, ed.v], [ed.v, ed.u]]) {
        if (mode === "u" || allowed(ed, a)) arcs.push(mode === "r" ? [b, a, i] : [a, b, i]);
      }
    });
    const start = new Int32Array(n + 1);
    for (const [a] of arcs) start[a + 1]++;
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const fill = start.slice(0, n), to = new Int32Array(arcs.length), eid = new Int32Array(arcs.length), w = new Float64Array(arcs.length);
    for (const [a, b, i] of arcs) { const p = fill[a]++; to[p] = b; eid[p] = i; w[p] = edges[i].w; }
    return { start, to, eid, w };
  }
  const UA = buildAdj("u"), DA = buildAdj("d"), RA = buildAdj("r");
  const SU = new Searcher(UA, n), SD = new Searcher(DA, n), SR = new Searcher(RA, n);

  // snap start: nearest node with a legal way out
  let start = -1, best = Infinity;
  const cos = Math.cos(startLonLat[1] * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    if (DA.start[i + 1] === DA.start[i]) continue;
    const dx = (lonlat[i][0] - startLonLat[0]) * cos, dy = lonlat[i][1] - startLonLat[1], d = dx * dx + dy * dy;
    if (d < best) { best = d; start = i; }
  }

  const reqAll = edges.map((ed, i) => (ed.req ? i : -1)).filter(i => i >= 0);
  if (!reqAll.length) throw new Error("No new roads inside that area. Draw around some red roads.");
  // keep new roads the start can reach and return from
  SD.run([start]); const fwd = Float64Array.from({ length: n }, (_, x) => SD.d(x));
  SR.run([start]); const back = Float64Array.from({ length: n }, (_, x) => SR.d(x));
  const req = reqAll.filter(i => [edges[i].u, edges[i].v].every(x => fwd[x] < Infinity && back[x] < Infinity));
  const dropped = reqAll.length - req.length;
  if (!req.length) throw new Error("The new roads in that area can't be reached from the start.");
  const newAvail = req.reduce((s, i) => s + edges[i].newM, 0);

  // undirected joins (greedy Prim over clusters of new road, from the start's cluster)
  say("Joining clusters of new road...");
  const base = req.map(i => [edges[i].u, edges[i].v, i]);
  {
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    for (const [a, b] of base) parent[find(a)] = find(b);
    const touched = new Set([start]); base.forEach(([a, b]) => { touched.add(a); touched.add(b); });
    const compNodes = new Map();
    for (const x of touched) { const r = find(x); if (!compNodes.has(r)) compNodes.set(r, []); compNodes.get(r).push(x); }
    const inJoined = new Uint8Array(n), compJoined = new Set([find(start)]);
    for (const x of compNodes.get(find(start))) inJoined[x] = 1;
    let joinedList = [...compNodes.get(find(start))];
    while (compJoined.size < compNodes.size) {
      const hit = SU.run(joinedList, x => !inJoined[x] && touched.has(x));
      if (hit < 0) break;
      for (const st of SU.path(hit)) { base.push(st); if (!inJoined[st[1]]) { inJoined[st[1]] = 1; joinedList.push(st[1]); } }
      const r = find(hit); compJoined.add(r);
      for (const x of compNodes.get(r)) if (!inJoined[x]) { inJoined[x] = 1; joinedList.push(x); }
    }
  }

  // odd-degree junctions and their nearest odd neighbours (undirected, penalized)
  const deg = new Int32Array(n);
  for (const [a, b] of base) { deg[a]++; deg[b]++; }
  const odd = []; for (let x = 0; x < n; x++) if (deg[x] % 2) odd.push(x);
  const isOdd = new Uint8Array(n); odd.forEach(x => (isOdd[x] = 1));
  const oddIdx = new Map(odd.map((x, i) => [x, i]));
  say(`Measuring ${odd.length} dead ends and junctions...`);
  const uDist = new Map(); // key i*M+j -> distance (both orders)
  const M = odd.length + 1;
  const uCand = odd.map((s, i) => {
    const list = [];
    SU.run([s], (x, d) => {
      if (x !== s && isOdd[x]) list.push([oddIdx.get(x), d]);
      return list.length >= K_NEAR || d > NEAR_CAP_M;
    });
    for (const [j, d] of list) { uDist.set(i * M + j, d); uDist.set(j * M + i, d); }
    return list;
  });

  // directed nearest neighbours among endpoints of new roads (for balancing)
  const ends = new Set([start]); req.forEach(i => { ends.add(edges[i].u); ends.add(edges[i].v); });
  const isEnd = new Uint8Array(n); ends.forEach(x => (isEnd[x] = 1));
  const dCand = new Map(); // node -> [[node, dist], ...]
  for (const s of ends) {
    const list = [];
    SD.run([s], (x, d) => {
      if (x !== s && isEnd[x]) list.push([x, d]);
      return list.length >= K_NEAR || d > NEAR_CAP_M;
    });
    dCand.set(s, list);
  }

  return { n, edges, lonlat, allowed, UA, DA, SU, SD, start, req, base, odd, uCand, uDist, M, dCand, penalty,
           dropped, newAvail, pathU: new Map(), pathD: new Map() };
}

// ---------- one attempt (deterministic when rng is null) ----------
function attempt(C, rng) {
  const { n, edges, allowed, SU, SD, start, req, base, odd, uCand, uDist, M } = C;
  const rand = rng || (() => 0.5);

  // 1. pair odd junctions: greedy on (optionally jittered) distances, then 2-opt
  const mate = new Int32Array(odd.length).fill(-1);
  if (odd.length) {
    const pairs = [];
    const seenPair = new Set();
    uCand.forEach((list, i) => {
      for (const [j, d] of list) {
        const key = Math.min(i, j) * M + Math.max(i, j);
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        pairs.push([rng ? d * (1 + 0.4 * rand()) : d, i, j]);
      }
    });
    pairs.sort((a, b) => a[0] - b[0]);
    for (const [, i, j] of pairs) if (mate[i] < 0 && mate[j] < 0) { mate[i] = j; mate[j] = i; }
    // anything left without a nearby partner: full search among the leftovers
    const left = []; for (let i = 0; i < odd.length; i++) if (mate[i] < 0) left.push(i);
    while (left.length > 1) {
      const i = left.shift(); const targets = new Set(left.map(j => odd[j]));
      const hit = SU.run([odd[i]], x => targets.has(x));
      if (hit < 0) continue;
      const j = left.indexOf(odd.indexOf(hit)); const jj = left[j]; left.splice(j, 1);
      const d = SU.d(hit); uDist.set(i * M + jj, d); uDist.set(jj * M + i, d);
      mate[i] = jj; mate[jj] = i;
    }
    const D = (a, b) => uDist.get(a * M + b) ?? Infinity;
    // 2-opt over neighbouring pairs: swap partners when it shortens the total
    for (let pass = 0, improved = true; improved && pass < 30; pass++) {
      improved = false;
      for (let a = 0; a < odd.length; a++) {
        const b = mate[a]; if (b < 0) continue;
        for (const [c] of uCand[a]) {
          const d = mate[c]; if (d < 0 || c === b || d === a) continue;
          const cur = D(a, b) + D(c, d);
          if (D(a, c) + D(b, d) < cur - 1e-6) { mate[a] = c; mate[c] = a; mate[b] = d; mate[d] = b; improved = true; break; }
          if (D(a, d) + D(b, c) < cur - 1e-6) { mate[a] = d; mate[d] = a; mate[b] = c; mate[c] = b; improved = true; break; }
        }
      }
    }
  }
  const items = base.slice();
  for (let i = 0; i < odd.length; i++) {
    const j = mate[i]; if (j < i) continue; // each pair once, smaller index first
    const key = i * M + j;
    let p = C.pathU.get(key);
    if (!p) { SU.run([odd[i]], x => x === odd[j]); p = SU.path(odd[j]); C.pathU.set(key, p); }
    for (const st of p) items.push(st);
  }

  // 2. undirected Euler circuit (random branch order when optimizing) -> direction of each new road
  const orient = new Map();
  {
    const adj = Array.from({ length: n }, () => []);
    items.forEach(([a, b], k) => { adj[a].push(k); adj[b].push(k); });
    if (rng) for (const l of adj) for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
    const used = new Uint8Array(items.length), ptr = new Int32Array(n), stack = [[start, -1, -1]], circuit = [];
    while (stack.length) {
      const [x] = stack[stack.length - 1];
      while (ptr[x] < adj[x].length && used[adj[x][ptr[x]]]) ptr[x]++;
      if (ptr[x] === adj[x].length) { circuit.push(stack.pop()); continue; }
      const k = adj[x][ptr[x]]; used[k] = 1;
      const [a, b] = items[k]; stack.push([a === x ? b : a, k, x]);
    }
    for (let i = circuit.length - 1; i >= 0; i--) {
      const [, k, from] = circuit[i]; if (k < 0) continue;
      const e = items[k][2];
      if (edges[e].req && !orient.has(e)) orient.set(e, from);
    }
  }

  // 3. directed: new roads in their chosen (legal) direction, then balance in/out
  const arcs = [];
  for (const e of req) {
    const ed = edges[e];
    let a = orient.get(e) ?? ed.u; let b = a === ed.u ? ed.v : ed.u;
    if (!allowed(ed, a)) [a, b] = [b, a];
    arcs.push([a, b, e]);
  }
  balance(C, arcs, false);
  joinDirected(C, arcs);

  // 4. directed Euler circuit from the start, preferring not to double straight back
  const out = Array.from({ length: n }, () => []);
  arcs.forEach(([a], k) => out[a].push(k));
  if (rng) for (const l of out) for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  const stack = [[start, -1]], seq = [];
  while (stack.length) {
    const [x, inK] = stack[stack.length - 1];
    const l = out[x];
    if (l.length) {
      // pick an outgoing arc that isn't the same street we came in on, if there is one
      let pick = l.length - 1;
      if (inK >= 0) {
        const inE = arcs[inK][2];
        for (let i = l.length - 1; i >= 0; i--) if (arcs[l[i]][2] !== inE) { pick = i; break; }
      }
      const k = l[pick]; l[pick] = l[l.length - 1]; l.pop();
      stack.push([arcs[k][1], k]);
    } else seq.push(stack.pop()[1]);
  }
  seq.reverse();
  const steps = seq.filter(k => k >= 0);
  if (steps.length !== arcs.length) throw new Error("Couldn't join every road into one loop. Try a smaller area.");

  // 5. score
  const count = new Map(); let total = 0, uturns = 0;
  for (let i = 0; i < steps.length; i++) {
    const [, , e] = arcs[steps[i]];
    total += edges[e].len; count.set(e, (count.get(e) || 0) + 1);
    if (i && arcs[steps[i - 1]][2] === e) uturns++;
  }
  let repeat = 0, newM = 0;
  for (const [e, c] of count) { repeat += (c - 1) * edges[e].len; newM += edges[e].newM; }
  return { arcs, steps, total, repeat, newM, uturns, cost: total + C.penalty * repeat };
}

/** Make in-degree equal out-degree at every node by adding the cheapest legal paths
 *  (transportation problem over nearest candidates, widening to a full search if needed). */
function balance(C, arcs, full) {
  const { n, SD, dCand } = C;
  const imb = new Int32Array(n);
  for (const [a, b] of arcs) { imb[a]++; imb[b]--; }
  const sources = [], sinks = [], sinkIdx = new Map();
  for (let x = 0; x < n; x++) {
    if (imb[x] < 0) sources.push([x, -imb[x]]);
    else if (imb[x] > 0) { sinkIdx.set(x, sinks.length); sinks.push([x, imb[x]]); }
  }
  if (!sources.length) return;
  const nS = sources.length, nT = sinks.length;
  // sparse cost rows: source i -> [[sink j, cost], ...]
  const rows = sources.map(([s]) => {
    const r = [];
    if (!full) for (const [x, d] of dCand.get(s) || []) { const j = sinkIdx.get(x); if (j !== undefined) r.push([j, d]); }
    return r;
  });
  if (full) rows.forEach((_, i) => { // full search from every source to every sink
    SD.run([sources[i][0]]); rows[i] = [];
    sinks.forEach(([t], j) => { const d = SD.d(t); if (d < Infinity) rows[i].push([j, d]); });
  });
  const supply = sources.map(s => s[1]), demand = sinks.map(t => t[1]);
  const flow = new Map(); // i*nT+j -> units
  for (let guard = 0; guard < 100000; guard++) {
    // shortest augmenting path S -> source -> sink (-> back over reverse flow -> sink ...) via SPFA
    const V = nS + nT, dist = new Float64Array(V).fill(Infinity), prev = new Int32Array(V).fill(-1), inQ = new Uint8Array(V), q = [];
    for (let i = 0; i < nS; i++) if (supply[i] > 0) { dist[i] = 0; q.push(i); inQ[i] = 1; }
    const back = Array.from({ length: nT }, () => []);
    for (const [key, f] of flow) if (f > 0) back[key % nT].push(Math.floor(key / nT));
    const relax = new Int32Array(V);
    for (let qi = 0; qi < q.length; qi++) {
      const x = q[qi]; inQ[x] = 0;
      if (++relax[x] > V + 1) throw new Error("balancing hit a negative cycle"); // never loop forever
      if (x < nS) {
        for (const [j, c] of rows[x]) {
          const y = nS + j, nd = dist[x] + c;
          if (nd < dist[y] - 1e-9) { dist[y] = nd; prev[y] = x; if (!inQ[y]) { q.push(y); inQ[y] = 1; } }
        }
      } else {
        const j = x - nS;
        for (const i of back[j]) {
          const c = rows[i].find(r => r[0] === j)[1], nd = dist[x] - c;
          if (nd < dist[i] - 1e-9) { dist[i] = nd; prev[i] = x; if (!inQ[i]) { q.push(i); inQ[i] = 1; } }
        }
      }
    }
    let bestT = -1;
    for (let j = 0; j < nT; j++) if (demand[j] > 0 && dist[nS + j] < Infinity && (bestT < 0 || dist[nS + j] < dist[nS + bestT])) bestT = j;
    if (bestT < 0) {
      // nearby candidates weren't enough: start over with full searches (keeps the flow optimal)
      if (!full) return balance(C, arcs, true);
      break;
    }
    const path = []; let x = nS + bestT;
    while (prev[x] !== -1) { path.push([prev[x], x]); x = prev[x]; }
    let amt = Math.min(demand[bestT], supply[x]);
    for (const [a, b] of path) if (a >= nS) amt = Math.min(amt, flow.get(b * nT + (a - nS)) || 0);
    for (const [a, b] of path) {
      if (a < nS) { const k = a * nT + (b - nS); flow.set(k, (flow.get(k) || 0) + amt); }
      else { const k = b * nT + (a - nS); flow.set(k, flow.get(k) - amt); }
    }
    supply[x] -= amt; demand[bestT] -= amt;
  }
  for (const [key, f] of flow) {
    if (f <= 0) continue;
    const s = sources[Math.floor(key / nT)][0], t = sinks[key % nT][0];
    const pk = s * n + t;
    let p = C.pathD.get(pk);
    if (!p) { SD.run([s], x => x === t); p = SD.path(t); C.pathD.set(pk, p); }
    for (let r = 0; r < f; r++) for (const st of p) arcs.push(st);
  }
}

/** Join weakly separate clusters with legal round trips, then re-balance (rarely needed). */
function joinDirected(C, arcs) {
  const { n, SD, start } = C;
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const f = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  const touch = () => { for (const [a, b] of arcs) par[f(a)] = f(b); };
  touch();
  const nodesIn = new Set([start]); arcs.forEach(([a, b]) => { nodesIn.add(a); nodesIn.add(b); });
  let joined = false;
  for (let guard = 0; guard < 10000; guard++) {
    const root = f(start), srcs = [...nodesIn].filter(x => f(x) === root);
    const inSet = new Set(srcs);
    const hit = SD.run(srcs, x => !inSet.has(x) && nodesIn.has(x));
    if (hit < 0) break;
    for (const st of SD.path(hit)) arcs.push(st);
    const ret = SD.run([hit], x => inSet.has(x));
    if (ret >= 0) for (const st of SD.path(ret)) arcs.push(st);
    arcs.forEach(([a, b]) => { nodesIn.add(a); nodesIn.add(b); });
    touch(); joined = true;
  }
  if (joined) balance(C, arcs, true);
}

// ---------- results ----------
function pack(C, r, ms, tries) {
  const { edges, lonlat, start } = C;
  const coords = [];
  for (const k of r.steps) {
    const [a, , e] = r.arcs[k], ed = edges[e];
    const seg = a === ed.u ? ed.coords : ed.coords.slice().reverse();
    for (let i = coords.length ? 1 : 0; i < seg.length; i++) coords.push(seg[i]);
  }
  let wrongWay = 0;
  for (const k of r.steps) { const [a, , e] = r.arcs[k]; if (!C.allowed(edges[e], a)) wrongWay++; }
  return { coords, totalM: r.total, newM: r.newM, repeatM: r.repeat, uturns: r.uturns, newAvailM: C.newAvail,
           wrongWay, dropped: C.dropped, startLonLat: lonlat[start], ms: Math.round(ms), tries };
}

// ---------- optimizer: randomized attempts within a time budget ----------
function optimize(seconds) {
  if (!CTX || !CTX.best) { self.postMessage({ error: "Build a route first." }); return; }
  if (OPT) OPT.stop = true;
  const opt = OPT = { stop: false, until: performance.now() + seconds * 1000, tries: 0, t0: performance.now(), seed: (Math.random() * 2 ** 31) | 0 };
  const startCost = CTX.best.cost;
  const tick = () => {
    if (opt !== OPT) return;
    const sliceEnd = performance.now() + 150;
    try {
      while (performance.now() < sliceEnd && performance.now() < opt.until && !opt.stop) {
        const r = attempt(CTX, mulberry32(opt.seed + opt.tries++));
        if (r.cost < CTX.best.cost - 1) {
          CTX.best = r;
          self.postMessage({ result: pack(CTX, r, performance.now() - opt.t0, opt.tries), final: false });
        }
      }
    } catch (err) { console.warn("attempt failed", err); }
    const secsLeft = Math.max(0, Math.ceil((opt.until - performance.now()) / 1000));
    const saved = (startCost - CTX.best.cost) / 1609.344;
    if (opt.stop || performance.now() >= opt.until) {
      self.postMessage({ result: pack(CTX, CTX.best, performance.now() - opt.t0, opt.tries), final: true, optimized: true });
      OPT = null;
      return;
    }
    say(`Optimizing: ${opt.tries} tries, ${saved > 0.05 ? saved.toFixed(1) + " mi better so far" : "no improvement yet"}, ${secsLeft} s left`);
    setTimeout(tick, 0);
  };
  tick();
}
