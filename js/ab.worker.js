/* A to B routing. Its own logic, separate from the loop solver (solver.worker.js).
 *
 * Step 2: the best plain route from A to B.
 *   - one-way streets ridden legally
 *   - Smooth riding: turns and U-turns cost extra distance while planning (style.turn / style.uturn)
 *   - Skip unpaved: unpaved roads count as UNPAVED_W times their length
 * The search runs on arcs (a road ridden in one direction), so the cost of each turn is exact.
 *
 * in:  {type:"network", nodes, edges}
 *      {type:"route", start:[lon,lat], end:[lon,lat], style:{turn, uturn, skipUnpaved}}
 * out: {progress} | {error} | {result, final:true}
 */
const UNPAVED_W = 5;                    // same weighting as Loop
const TURN = 35 * Math.PI / 180;        // sharper than this counts as a turn
const UTURN = 150 * Math.PI / 180;      // sharper than this counts as a U-turn
const MPD = 111195.08;                  // metres per degree of latitude

let NET = null;   // { nodes, edges, outArcs, hStart, hEnd }
const say = msg => self.postMessage({ progress: msg });

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === "network") NET = index(m.nodes, m.edges);
    else if (m.type === "route") {
      const t0 = performance.now();
      const r = route(m.start, m.end, m.style || {});
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
  return { nodes, edges, outStart: count, outArcs: arcs, hStart, hEnd };
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

  // walk back and measure
  const path = [];
  for (let a = goal; a >= 0; a = prev[a]) path.push(a);
  path.reverse();
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
