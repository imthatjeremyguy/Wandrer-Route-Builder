/* Route solver: shortest legal loop from a start point that rides every new
 * road inside an area. Port of prototype/solve_route.py (mixed Rural Postman
 * heuristic), tuned for the browser.
 *
 * Messages in:
 *   {type:"network", nodes, edges}            once, after the network is built
 *   {type:"solve", start:[lon,lat], ring:[[lon,lat], ...]}   area polygon
 * Messages out:
 *   {progress: "..."}
 *   {result: {coords, totalM, newM, newAvailM, wrongWay, ms, startLonLat, dropped}}
 *   {error: "..."}
 *
 * Steps:
 *   1. Cut a subgraph around the start + area, snap the start to it.
 *   2. Undirected pass: join new-road clusters (greedy MST of shortest paths),
 *      pair odd-degree nodes (greedy + 2-opt matching), walk an Euler circuit.
 *      Its travel direction orients each two-way new road.
 *   3. Directed pass: join clusters with legal round trips, balance in/out
 *      degree with a min-cost transportation over legal shortest paths.
 *   4. Walk the directed Euler circuit from the start.
 */
const MIN_NEW_M = 5;           // ignore slivers shorter than this
const MARGIN_DEG = 0.02;       // ~2 km of extra roads around the area for detours

let NET = null;

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "network") { NET = { nodes: m.nodes, edges: m.edges }; return; }
  if (m.type === "solve") {
    try { self.postMessage({ result: solve(m.start, m.ring) }); }
    catch (err) { console.error(err); self.postMessage({ error: err.message || String(err) }); }
  }
};
const say = (msg) => self.postMessage({ progress: msg });

// ---------- small binary heap keyed by distance ----------
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
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

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function solve(startLonLat, ring) {
  const t0 = performance.now();
  if (!NET) throw new Error("The road network isn't loaded yet.");
  const bw = Math.min(...ring.map(p => p[0])), be = Math.max(...ring.map(p => p[0]));
  const bs = Math.min(...ring.map(p => p[1])), bn = Math.max(...ring.map(p => p[1]));
  const inBox = p => pointInRing(p, ring);

  // ---------- 1. subgraph ----------
  say("Preparing roads...");
  const W = Math.min(bw, startLonLat[0]) - MARGIN_DEG, E = Math.max(be, startLonLat[0]) + MARGIN_DEG;
  const S = Math.min(bs, startLonLat[1]) - MARGIN_DEG, N = Math.max(bn, startLonLat[1]) + MARGIN_DEG;
  const inSub = ([x, y]) => x >= W && x <= E && y >= S && y <= N;
  const local = new Map(), lonlat = [];
  const L = (g) => { let i = local.get(g); if (i === undefined) { i = lonlat.length; local.set(g, i); lonlat.push(NET.nodes[g]); } return i; };
  const edges = []; // {u, v, len, newM, oneway, coords, req}
  for (const ed of NET.edges) {
    if (!inSub(NET.nodes[ed.u]) || !inSub(NET.nodes[ed.v])) continue;
    const mid = ed.coords[ed.coords.length >> 1];
    edges.push({ u: L(ed.u), v: L(ed.v), len: ed.len, newM: ed.newM, oneway: ed.oneway, coords: ed.coords,
                 req: ed.newM >= MIN_NEW_M && inBox(mid) });
  }
  const n = lonlat.length;
  if (!n) throw new Error("No roads near that start point and area.");

  // legal travel: edge coords run u -> v
  const allowed = (ed, from) => ed.oneway === 0 || (ed.oneway === 1 ? from === ed.u : from === ed.v);

  // CSR adjacency: undirected (every edge both ways) and directed (legal only)
  function buildAdj(directed) {
    const deg = new Int32Array(n + 1);
    edges.forEach(ed => {
      if (!directed || allowed(ed, ed.u)) deg[ed.u]++;
      if (!directed || allowed(ed, ed.v)) deg[ed.v]++;
    });
    const start = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) start[i + 1] = start[i] + deg[i];
    const fill = start.slice(0, n), to = new Int32Array(start[n]), eid = new Int32Array(start[n]), w = new Float64Array(start[n]);
    edges.forEach((ed, i) => {
      if (!directed || allowed(ed, ed.u)) { const p = fill[ed.u]++; to[p] = ed.v; eid[p] = i; w[p] = ed.len; }
      if (!directed || allowed(ed, ed.v)) { const p = fill[ed.v]++; to[p] = ed.u; eid[p] = i; w[p] = ed.len; }
    });
    return { start, to, eid, w };
  }
  const UA = buildAdj(false), DA = buildAdj(true);

  /** Dijkstra from sources; stops early when stopAt(node) returns true. */
  function dijkstra(adj, sources, stopAt) {
    const dist = new Float64Array(n).fill(Infinity), prevE = new Int32Array(n).fill(-1), prevN = new Int32Array(n).fill(-1);
    const h = new Heap();
    for (const s of sources) { dist[s] = 0; h.push(0, s); }
    let hit = -1;
    while (h.size) {
      const d = h.topKey(), x = h.pop();
      if (d > dist[x]) continue;
      if (stopAt && stopAt(x)) { hit = x; break; }
      for (let p = adj.start[x]; p < adj.start[x + 1]; p++) {
        const y = adj.to[p], nd = d + adj.w[p];
        if (nd < dist[y]) { dist[y] = nd; prevE[y] = adj.eid[p]; prevN[y] = x; h.push(nd, y); }
      }
    }
    return { dist, prevE, prevN, hit };
  }
  /** Steps [from, to, edge] from the Dijkstra source to target, in travel order. */
  function pathTo(r, target) {
    const steps = [];
    for (let x = target; r.prevN[x] !== -1; x = r.prevN[x]) steps.push([r.prevN[x], x, r.prevE[x]]);
    return steps.reverse();
  }

  // snap start: nearest node that has a legal way out
  let start = -1, best = Infinity;
  const cos = Math.cos(startLonLat[1] * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    if (DA.start[i + 1] === DA.start[i]) continue;
    const dx = (lonlat[i][0] - startLonLat[0]) * cos, dy = lonlat[i][1] - startLonLat[1], d = dx * dx + dy * dy;
    if (d < best) { best = d; start = i; }
  }

  const reqIdx = edges.map((ed, i) => (ed.req ? i : -1)).filter(i => i >= 0);
  if (!reqIdx.length) throw new Error("No new roads inside that area. Draw an area around some red roads.");
  const newAvail = reqIdx.reduce((s, i) => s + edges[i].newM, 0);

  // drop new roads the start can't reach and return from (one-way traps at the edge of the subgraph)
  const fwd = dijkstra(DA, [start]);
  const revAdj = (() => { // reverse of the directed graph
    const deg = new Int32Array(n + 1);
    for (let x = 0; x < n; x++) for (let p = DA.start[x]; p < DA.start[x + 1]; p++) deg[DA.to[p]]++;
    const st = new Int32Array(n + 1); for (let i = 0; i < n; i++) st[i + 1] = st[i] + deg[i];
    const fill = st.slice(0, n), to = new Int32Array(st[n]), eid = new Int32Array(st[n]), w = new Float64Array(st[n]);
    for (let x = 0; x < n; x++) for (let p = DA.start[x]; p < DA.start[x + 1]; p++) {
      const q = fill[DA.to[p]]++; to[q] = x; eid[q] = DA.eid[p]; w[q] = DA.w[p];
    }
    return { start: st, to, eid, w };
  })();
  const back = dijkstra(revAdj, [start]);
  const reachable = i => { const ed = edges[i]; return [ed.u, ed.v].every(x => fwd.dist[x] < Infinity && back.dist[x] < Infinity); };
  const req = reqIdx.filter(reachable);
  const dropped = reqIdx.length - req.length;
  if (!req.length) throw new Error("The new roads in that area can't be reached from the start.");

  // ---------- 2. undirected pass: orient two-way new roads ----------
  say("Planning the order of roads...");
  const uItems = req.map(i => [edges[i].u, edges[i].v, i]); // [a, b, edge]
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const [a, b] of uItems) parent[find(a)] = find(b);
  const touched = new Set([start]); uItems.forEach(([a, b]) => { touched.add(a); touched.add(b); });
  const compOf = new Map(); for (const x of touched) compOf.set(x, find(x));

  // greedy Prim: grow from the start's cluster, always adding the nearest other cluster
  const joined = new Set([compOf.get(start)]);
  const inJoined = new Uint8Array(n);
  for (const x of touched) if (joined.has(compOf.get(x))) inJoined[x] = 1;
  let remaining = new Set([...compOf.values()].filter(c => !joined.has(c))).size;
  while (remaining > 0) {
    const srcs = []; for (let x = 0; x < n; x++) if (inJoined[x]) srcs.push(x);
    const r = dijkstra(UA, srcs, x => !inJoined[x] && touched.has(x) && !joined.has(compOf.get(x)));
    if (r.hit < 0) break;
    for (const [a, b, e] of pathTo(r, r.hit)) { uItems.push([a, b, e]); inJoined[a] = inJoined[b] = 1; }
    const c = compOf.get(r.hit); joined.add(c);
    for (const x of touched) if (compOf.get(x) === c) inJoined[x] = 1;
    remaining--;
  }

  // pair up odd-degree nodes
  const deg = new Int32Array(n);
  for (const [a, b] of uItems) { deg[a]++; deg[b]++; }
  const odd = []; for (let x = 0; x < n; x++) if (deg[x] % 2) odd.push(x);
  if (odd.length) {
    say(`Pairing ${odd.length} dead ends and junctions...`);
    const oddPos = new Map(odd.map((x, i) => [x, i]));
    const D = odd.map(s => {
      const r = dijkstra(UA, [s]); const row = new Float64Array(odd.length);
      odd.forEach((t, j) => (row[j] = r.dist[t])); return row;
    });
    // greedy: closest pairs first
    const pairs = [];
    for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++) if (D[i][j] < Infinity) pairs.push([D[i][j], i, j]);
    pairs.sort((a, b) => a[0] - b[0]);
    const mate = new Int32Array(odd.length).fill(-1);
    for (const [, i, j] of pairs) if (mate[i] < 0 && mate[j] < 0) { mate[i] = j; mate[j] = i; }
    // 2-opt: swap partners between two pairs when it shortens the total
    let improved = true, passes = 0;
    while (improved && passes++ < 50) {
      improved = false;
      for (let a = 0; a < odd.length; a++) {
        const b = mate[a]; if (b < a) continue;
        for (let c = a + 1; c < odd.length; c++) {
          const d = mate[c]; if (d < c || c === b) continue;
          const cur = D[a][b] + D[c][d];
          if (D[a][c] + D[b][d] < cur - 1e-6) { mate[a] = c; mate[c] = a; mate[b] = d; mate[d] = b; improved = true; break; }
          if (D[a][d] + D[b][c] < cur - 1e-6) { mate[a] = d; mate[d] = a; mate[b] = c; mate[c] = b; improved = true; break; }
        }
      }
    }
    for (let i = 0; i < odd.length; i++) {
      const j = mate[i]; if (j < i) continue;
      const r = dijkstra(UA, [odd[i]], x => x === odd[j]);
      for (const step of pathTo(r, odd[j])) uItems.push(step);
    }
    void oddPos;
  }
  // undirected Euler circuit -> orientation of each new road
  const orient = new Map(); // edge index -> from node
  {
    const adj = Array.from({ length: n }, () => []);
    uItems.forEach(([a, b], k) => { adj[a].push(k); adj[b].push(k); });
    const used = new Uint8Array(uItems.length), ptr = new Int32Array(n);
    const stack = [[start, -1]];
    const circuit = [];
    while (stack.length) {
      const [x] = stack[stack.length - 1];
      while (ptr[x] < adj[x].length && used[adj[x][ptr[x]]]) ptr[x]++;
      if (ptr[x] === adj[x].length) { circuit.push(stack.pop()); continue; }
      const k = adj[x][ptr[x]]; used[k] = 1;
      const [a, b] = uItems[k]; stack.push([a === x ? b : a, k, x]);
    }
    // circuit is reversed; walk it forward
    for (let i = circuit.length - 1; i >= 0; i--) {
      const item = circuit[i]; if (item[1] < 0) continue;
      const e = uItems[item[1]][2];
      if (edges[e].req && !orient.has(e)) orient.set(e, item[2]);
    }
  }

  // ---------- 3. directed pass ----------
  say("Fitting the loop to one-way streets...");
  const arcs = []; // [from, to, edge]
  for (const e of req) {
    const ed = edges[e];
    let a = orient.get(e) ?? ed.u; let b = a === ed.u ? ed.v : ed.u;
    if (!allowed(ed, a)) { const t = a; a = b; b = t; }
    arcs.push([a, b, e]);
  }
  // join weakly connected clusters with legal round trips
  {
    const par = Int32Array.from({ length: n }, (_, i) => i);
    const f2 = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
    for (const [a, b] of arcs) par[f2(a)] = f2(b);
    const nodesIn = new Set([start]); arcs.forEach(([a, b]) => { nodesIn.add(a); nodesIn.add(b); });
    const inSet = new Uint8Array(n); const startRoot = f2(start);
    for (const x of nodesIn) if (f2(x) === startRoot) inSet[x] = 1;
    for (;;) {
      const srcs = []; for (let x = 0; x < n; x++) if (inSet[x]) srcs.push(x);
      const go = dijkstra(DA, srcs, x => !inSet[x] && nodesIn.has(x));
      if (go.hit < 0) break;
      const target = go.hit, root = f2(target);
      for (const s of pathTo(go, target)) arcs.push(s);
      const ret = dijkstra(DA, [target], x => inSet[x]);
      if (ret.hit >= 0) for (const s of pathTo(ret, ret.hit)) arcs.push(s);
      for (const x of nodesIn) if (f2(x) === root) inSet[x] = 1;
      for (const [a, b] of arcs) { if (inSet[a] || inSet[b]) { inSet[a] = inSet[b] = 1; } }
    }
  }
  // balance: every node needs as many ways in as out
  {
    const imb = new Int32Array(n); // out - in
    for (const [a, b] of arcs) { imb[a]++; imb[b]--; }
    const sources = [], sinks = [];
    for (let x = 0; x < n; x++) { if (imb[x] < 0) sources.push([x, -imb[x]]); else if (imb[x] > 0) sinks.push([x, imb[x]]); }
    if (sources.length) {
      say(`Balancing ${sources.length} junctions...`);
      const runs = sources.map(([s]) => dijkstra(DA, [s]));
      // transportation problem via successive shortest paths on a small bipartite graph
      const nS = sources.length, nT = sinks.length;
      const cost = runs.map(r => sinks.map(([t]) => r.dist[t]));
      const supply = sources.map(s => s[1]), demand = sinks.map(t => t[1]);
      const flow = Array.from({ length: nS }, () => new Int32Array(nT));
      // potentials-free SPFA over residual graph: S -> src -> sink -> T
      for (;;) {
        const V = nS + nT, dist = new Float64Array(V).fill(Infinity), prev = new Int32Array(V).fill(-1), inQ = new Uint8Array(V);
        const q = [];
        for (let i = 0; i < nS; i++) if (supply[i] > 0) { dist[i] = 0; q.push(i); inQ[i] = 1; }
        while (q.length) {
          const x = q.shift(); inQ[x] = 0;
          if (x < nS) {
            for (let j = 0; j < nT; j++) {
              const c = cost[x][j]; if (c === Infinity) continue;
              const y = nS + j, nd = dist[x] + c;
              if (nd < dist[y] - 1e-9) { dist[y] = nd; prev[y] = x; if (!inQ[y]) { q.push(y); inQ[y] = 1; } }
            }
          } else {
            const j = x - nS;
            for (let i = 0; i < nS; i++) if (flow[i][j] > 0) {
              const nd = dist[x] - cost[i][j];
              if (nd < dist[i] - 1e-9) { dist[i] = nd; prev[i] = x; if (!inQ[i]) { q.push(i); inQ[i] = 1; } }
            }
          }
        }
        let bestT = -1;
        for (let j = 0; j < nT; j++) if (demand[j] > 0 && dist[nS + j] < Infinity && (bestT < 0 || dist[nS + j] < dist[nS + bestT])) bestT = j;
        if (bestT < 0) break;
        // find path back to a source with supply, and the bottleneck
        const path = []; let x = nS + bestT;
        while (prev[x] !== -1) { path.push([prev[x], x]); x = prev[x]; }
        let amt = Math.min(demand[bestT], supply[x]);
        for (const [a, b] of path) if (a >= nS) amt = Math.min(amt, flow[b][a - nS]);
        for (const [a, b] of path) { if (a < nS) flow[a][b - nS] += amt; else flow[b][a - nS] -= amt; }
        supply[x] -= amt; demand[bestT] -= amt;
      }
      for (let i = 0; i < nS; i++) for (let j = 0; j < nT; j++) {
        for (let f = 0; f < flow[i][j]; f++) for (const s of pathTo(runs[i], sinks[j][0])) arcs.push(s);
      }
    }
  }

  // ---------- 4. directed Euler circuit ----------
  say("Writing the route...");
  const out = Array.from({ length: n }, () => []);
  arcs.forEach(([a], k) => out[a].push(k));
  const ptr = new Int32Array(n), stack = [[start, -1]], seq = [];
  while (stack.length) {
    const [x] = stack[stack.length - 1];
    if (ptr[x] < out[x].length) { const k = out[x][ptr[x]++]; stack.push([arcs[k][1], k]); }
    else seq.push(stack.pop()[1]);
  }
  seq.reverse(); // arc indices in travel order (first entry is the -1 start marker)
  const steps = seq.filter(k => k >= 0);
  if (steps.length !== arcs.length) throw new Error("Couldn't join every road into one loop. Try a smaller area.");

  const coords = []; let totalM = 0, newM = 0, wrongWay = 0;
  const seen = new Set();
  for (const k of steps) {
    const [a, , e] = arcs[k], ed = edges[e];
    if (!allowed(ed, a)) wrongWay++;
    const seg = a === ed.u ? ed.coords : ed.coords.slice().reverse();
    for (let i = coords.length ? 1 : 0; i < seg.length; i++) coords.push(seg[i]);
    totalM += ed.len;
    if (!seen.has(e)) { seen.add(e); newM += ed.newM; } // includes bonus new road ridden outside the area
  }
  return { coords, totalM, newM, newAvailM: newAvail, wrongWay, dropped,
           startLonLat: lonlat[start], ms: Math.round(performance.now() - t0) };
}
