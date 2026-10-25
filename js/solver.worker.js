/* Route solver: a legal loop from a start point that rides every new road
 * inside an area, with as few wasted and repeated miles as possible.
 * Mixed Rural Postman heuristic (port of prototype/solve_route.py, reworked
 * for speed and for repeated randomized attempts).
 *
 * Messages in:
 *   {type:"network", nodes, edges}                         once per network
 *   {type:"solve", start:[lon,lat], ring:[[lon,lat],...], style}   first pass
 *   {type:"optimize", seconds}                             improve the last solve
 *   {type:"stop"}                                          end optimizing early
 * Messages out:
 *   {progress:"..."}  {result:{...}, final:true|false}  {error:"..."}
 *
 * style: how much distance a smoother ride is worth (all 0 = shortest distance)
 *   repeat  extra cost per metre of riding new road a second time
 *   turn    metres a turn costs (connectors follow straight streets)
 *   uturn   metres a U-turn costs; U-turns at intersections with another way
 *           out are replaced by a loop when the loop is cheaper than this
 */
const MIN_NEW_M = 15;      // a block needs at least this much new road to be worth riding
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
      const goal = m.goal || (m.budgetM > 0 ? { type: "distance", distanceM: m.budgetM } : { type: "all" });
      let area;
      if (m.ring) area = { ring: m.ring };
      else if (goal.type === "distance") area = { radiusM: goal.distanceM / 2 };     // a loop can't reach farther
      else if (goal.type === "newmiles") area = { radiusM: radiusForNew(m.start, goal.newM, goal.capM) };
      else throw new Error("Draw an area, or choose a goal so the route knows how far to go.");
      const G = prepare(m.start, area, m.style || { repeat: m.penalty ?? 0.5, turn: 0, uturn: 0 });
      let r;
      if (goal.type === "distance") ({ C: CTX, r } = solveBudget(G, goal.distanceM));
      else if (goal.type === "newmiles") ({ C: CTX, r } = solveTarget(G, goal.newM, goal.capM || 0));
      else { CTX = withRoads(G, G.reqReach); r = attempt(CTX, null); }
      CTX.goal = { ...goal, ...(CTX.goal || {}) };
      CTX.hasArea = !!m.ring;
      CTX.best = r;
      // goals: keep searching quietly, longer when there's a lot of new road in play
      // (about 12 s for a neighbourhood, up to 30 s for a whole county)
      const poolMi = G.areaNewM / 1609.344;
      const totalMs = Math.min(30, Math.max(12, 10 + poolMi / 50)) * 1000;
      const leftMs = totalMs - (performance.now() - t0);
      if (CTX.sel && leftMs > 1500) optimize(leftMs / 1000, { silent: true, t0 });
      else self.postMessage({ result: pack(CTX, r, performance.now() - t0, 1), final: true });
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
  /** turnCost(x, inEdge, outEdge) adds a cost for the turn at x (null = none) */
  constructor(adj, n, turnCost = null) {
    this.adj = adj; this.n = n; this.turnCost = turnCost; this.ban = -1;
    this.dist = new Float64Array(n); this.prevE = new Int32Array(n); this.prevN = new Int32Array(n);
    this.stamp = new Int32Array(n); this.cur = 0; this.heap = new Heap();
  }
  d(x) { return this.stamp[x] === this.cur ? this.dist[x] : Infinity; }
  /** onSettle(x, d) returns true to stop. inEdge: the edge the (single) source was reached by. */
  run(sources, onSettle, inEdge = -1) {
    const { adj, dist, prevE, prevN, stamp, heap, turnCost, ban } = this; const cur = ++this.cur;
    heap.clear();
    for (const s of sources) { stamp[s] = cur; dist[s] = 0; prevE[s] = inEdge; prevN[s] = -1; heap.push(0, s); }
    while (heap.size) {
      const dx = heap.topKey(), x = heap.pop();
      if (dx > dist[x]) continue;
      if (onSettle && onSettle(x, dx)) return x;
      for (let p = adj.start[x]; p < adj.start[x + 1]; p++) {
        const e = adj.eid[p]; if (e === ban) continue;
        const y = adj.to[p];
        let nd = dx + adj.w[p];
        if (turnCost && prevE[x] >= 0) nd += turnCost(x, prevE[x], e);
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
/** area: {ring:[[lon,lat],...]} or {radiusM} (straight-line reach around the start) */
function prepare(startLonLat, area, style) {
  const penalty = style.repeat || 0;
  if (!NET) throw new Error("The road network isn't loaded yet.");
  say("Preparing roads...");
  const [sx, sy] = startLonLat, cosS = Math.cos(sy * Math.PI / 180), MPD = 111195.08;
  let xs, ys, inArea;
  if (area.ring) {
    const ring = area.ring;
    xs = ring.map(p => p[0]); ys = ring.map(p => p[1]);
    inArea = p => pointInRing(p, ring);
  } else {
    const R = area.radiusM, dLat = R / MPD, dLon = R / (MPD * cosS);
    xs = [sx - dLon, sx + dLon]; ys = [sy - dLat, sy + dLat];
    inArea = ([x, y]) => ((x - sx) * cosS * MPD) ** 2 + ((y - sy) * MPD) ** 2 <= R * R;
  }
  const W = Math.min(...xs, startLonLat[0]) - MARGIN_DEG, E = Math.max(...xs, startLonLat[0]) + MARGIN_DEG;
  const S = Math.min(...ys, startLonLat[1]) - MARGIN_DEG, N = Math.max(...ys, startLonLat[1]) + MARGIN_DEG;
  const inSub = ([x, y]) => x >= W && x <= E && y >= S && y <= N;
  const local = new Map(), lonlat = [];
  const L = g => { let i = local.get(g); if (i === undefined) { i = lonlat.length; local.set(g, i); lonlat.push(NET.nodes[g]); } return i; };
  const edges = [];
  for (const ed of NET.edges) {
    if (!inSub(NET.nodes[ed.u]) || !inSub(NET.nodes[ed.v])) continue;
    const mid = ed.coords[ed.coords.length >> 1];
    const req = ed.newM >= MIN_NEW_M && inArea(mid);
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

  // heading leaving each end of every edge (taken ~15 m in, so a kink at the corner doesn't count)
  const cosL = Math.cos(startLonLat[1] * Math.PI / 180);
  const heading = (c, from, dir) => {
    const [x0, y0] = c[from]; let k = from;
    for (;;) {
      const nk = k + dir; if (nk < 0 || nk >= c.length) break; k = nk;
      const dx = (c[k][0] - x0) * cosL, dy = c[k][1] - y0;
      if ((dx * dx + dy * dy) * 1.2e10 > 225) break; // ~15 m
    }
    return Math.atan2(c[k][1] - y0, (c[k][0] - x0) * cosL);
  };
  const leaveU = new Float64Array(edges.length), leaveV = new Float64Array(edges.length);
  edges.forEach((ed, i) => { leaveU[i] = heading(ed.coords, 0, 1); leaveV[i] = heading(ed.coords, ed.coords.length - 1, -1); });
  /** angle (0..PI) between arriving at x on edge a and leaving x on edge b; PI = U-turn */
  const turnAngle = (x, a, b) => {
    if (a === b) return Math.PI;
    const arrive = (x === edges[a].v ? leaveV[a] : leaveU[a]) + Math.PI;   // heading while arriving
    const leave = x === edges[b].u ? leaveU[b] : leaveV[b];
    let d = Math.abs(leave - arrive) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  };
  const TURN = 35 * Math.PI / 180, UTURN = 150 * Math.PI / 180;
  const turnCost = (x, a, b) => { const t = turnAngle(x, a, b); return t > UTURN ? style.uturn : t > TURN ? style.turn : 0; };
  const tc = style.turn || style.uturn ? turnCost : null;
  const SU = new Searcher(UA, n, tc), SD = new Searcher(DA, n, tc), SR = new Searcher(RA, n);
  const SX = new Searcher(DA, n, tc); // U-turn cleanup searches

  // snap start: nearest node with a legal way out
  let start = -1, best = Infinity;
  const cos = Math.cos(startLonLat[1] * Math.PI / 180);
  for (let i = 0; i < n; i++) {
    if (DA.start[i + 1] === DA.start[i]) continue;
    const dx = (lonlat[i][0] - startLonLat[0]) * cos, dy = lonlat[i][1] - startLonLat[1], d = dx * dx + dy * dy;
    if (d < best) { best = d; start = i; }
  }

  const reqAll = edges.map((ed, i) => (ed.req ? i : -1)).filter(i => i >= 0);
  if (!reqAll.length) throw new Error(area.ring ? "No new roads inside that area. Draw around some red roads."
    : "No new roads within reach of the start. Move the start or raise the distance.");
  // keep new roads the start can reach and return from
  SD.run([start]); const fwd = Float64Array.from({ length: n }, (_, x) => SD.d(x));
  SR.run([start]); const back = Float64Array.from({ length: n }, (_, x) => SR.d(x));
  const req = reqAll.filter(i => [edges[i].u, edges[i].v].every(x => fwd[x] < Infinity && back[x] < Infinity));
  const dropped = reqAll.length - req.length;
  if (!req.length) throw new Error("The new roads there can't be reached from the start.");
  // round-trip cost from the start to reach each new road (orders roads for a distance budget)
  const rt = new Map(req.map(i => {
    const ed = edges[i];
    return [i, Math.min(fwd[ed.u] + back[ed.u], fwd[ed.v] + back[ed.v])];
  }));
  return { n, edges, lonlat, allowed, UA, DA, SU, SD, SX, start, penalty, style, turnAngle, TURN, UTURN,
           dropped, reqReach: req, rt, areaNewM: req.reduce((s, i) => s + edges[i].newM, 0) };
}

/** Context for routing a particular set of new roads (all of them, or a budget's share). */
function withRoads(G, req) {
  const { n, edges, SU, SD, start } = G;
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

  return { ...G, req, base, odd, uCand, uDist, M, dCand, newAvail, pathU: new Map(), pathD: new Map() };
}

// ---------- distance budget: collect the most new road within a ride distance ----------
const CHUNK_DEG = 0.004;     // ~400 m grid: new roads are chosen in chunks of a few blocks
const BUDGET_SECS = 12;      // time allowed to search for the best mix

/** Group new roads into chunks: same connected cluster of new road and same ~400 m cell. */
function chunkify(G) {
  const { edges, reqReach, rt, n } = G;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const i of reqReach) parent[find(edges[i].u)] = find(edges[i].v);
  const byKey = new Map();
  for (const i of reqReach) {
    const ed = edges[i], [x, y] = ed.coords[ed.coords.length >> 1];
    const key = find(ed.u) + ":" + Math.floor(x / CHUNK_DEG) + ":" + Math.floor(y / CHUNK_DEG);
    if (!byKey.has(key)) byKey.set(key, { edges: [], newM: 0, len: 0, rt: Infinity, nodes: new Set(), sx: 0, sy: 0 });
    const c = byKey.get(key);
    c.edges.push(i); c.newM += ed.newM; c.len += ed.len; c.rt = Math.min(c.rt, rt.get(i));
    c.nodes.add(ed.u); c.nodes.add(ed.v);
    c.sx += x * ed.newM; c.sy += y * ed.newM;
  }
  const out = [...byKey.values()];
  const MPD = 111195.08;
  for (const c of out) {   // new-road-weighted centre, in metres
    const lon = c.sx / c.newM, lat = c.sy / c.newM;
    c.cx = lon * MPD * Math.cos(lat * Math.PI / 180); c.cy = lat * MPD;
  }
  return out;
}

/** Candidate "home bases" for a compact ride: chunks with plenty of new road close around
 *  them, weighed against how far they are from the start. Each comes with the order to grow
 *  a region from it (nearest chunks first). Seeds are kept apart so they cover different areas. */
function pickSeeds(chunks, wantNewM, maxSeeds) {
  // how far you must grow from each chunk to hold wantNewM, using a ~300 m grid (fast at county scale)
  const CELL = 300, MAX_RING = 70, grid = new Map();
  const cellOf = c => [Math.floor(c.cx / CELL), Math.floor(c.cy / CELL)];
  chunks.forEach(c => {
    const [gx, gy] = cellOf(c), k = gx + ":" + gy;
    grid.set(k, (grid.get(k) || 0) + c.newM);
  });
  const scored = chunks.map((c, i) => {
    const [gx, gy] = cellOf(c);
    let acc = 0, reach = (MAX_RING + 1) * CELL * 1.5;
    for (let r = 0; r <= MAX_RING; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (const dy of (Math.abs(dx) === r ? range(-r, r) : [-r, r])) acc += grid.get((gx + dx) + ":" + (gy + dy)) || 0;
      }
      if (acc >= wantNewM) { reach = (r + 0.5) * CELL; break; }
    }
    return { i, est: c.rt + 2.2 * reach };
  });
  scored.sort((a, b) => a.est - b.est);
  const seeds = [];
  for (const s of scored) {
    const c = chunks[s.i];
    if (seeds.some(t => Math.hypot(chunks[t.i].cx - c.cx, chunks[t.i].cy - c.cy) < 1200)) continue;
    // growth order (nearest chunks first) only for the seeds actually used
    s.order = chunks.map((o, j) => [Math.hypot(o.cx - c.cx, o.cy - c.cy), j]).sort((a, b) => a[0] - b[0]).map(o => o[1]);
    seeds.push(s);
    if (seeds.length >= maxSeeds) break;
  }
  return seeds;
}
function range(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

function solveBudget(G, budgetM) {
  const mi = m => (m / 1609.344).toFixed(1);
  const t0 = performance.now();
  let deadline = t0 + BUDGET_SECS * 1000;
  // collecting everything only makes sense if the pool could possibly fit (a loop is at least as long as its new road)
  if (G.areaNewM < budgetM) {
    const all = withRoads(G, G.reqReach), rAll = attempt(all, null);
    if (rAll.total <= budgetM) return { C: all, r: rAll };
  }

  const chunks = chunkify(G);
  const evals = new Map();     // chunk-set key -> {C, r} (null when over budget)
  let best = null, tries = 0;
  const keyOf = set => [...set].sort((a, b) => a - b).join(",");
  const better = (a, b) => !b || a.r.newM > b.r.newM + 1 || (Math.abs(a.r.newM - b.r.newM) <= 1 && a.r.total < b.r.total);
  /** Route a set of chunks; remember it; returns the result or null if over budget. */
  function evaluate(set) {
    const k = keyOf(set);
    if (evals.has(k)) return evals.get(k);
    // a loop is at least as long as the roads it rides: reject impossible sets without routing them
    let roads = 0; for (const ci of set) roads += chunks[ci].len;
    if (roads > budgetM) { evals.set(k, null); return null; }
    const req = []; for (const ci of set) req.push(...chunks[ci].edges);
    const C = withRoads(G, req), r = attempt(C, null);
    tries++;
    const res = r.total <= budgetM ? { C, r, set: new Set(set) } : null;
    evals.set(k, res);
    if (res && better(res, best)) best = res;
    say(`Finding the best ${mi(budgetM)} mi loop: ${best ? mi(best.r.newM) + " new mi so far" : "searching"} (${tries} tries)`);
    return res;
  }
  const timeLeft = () => performance.now() < deadline;

  /** Grow a set by adding the chunks with the best new-miles-per-detour, while they fit. */
  function grow(cur) {
    for (let guard = 0; guard < 200 && timeLeft(); guard++) {
      // detour estimate: twice the distance from the current route to the chunk, plus its own length
      const routeNodes = [...new Set(cur.r.walk.flatMap(([a, b]) => [a, b]))];
      G.SU.run(routeNodes);
      const cand = [];
      chunks.forEach((c, ci) => {
        if (cur.set.has(ci)) return;
        let d = Infinity; for (const x of c.nodes) d = Math.min(d, G.SU.d(x));
        if (d === Infinity) return;
        const est = 2 * d + c.len;
        if (cur.r.total + est * 0.6 > budgetM) return;   // clearly won't fit
        cand.push([c.newM / est, ci]);
      });
      cand.sort((a, b) => b[0] - a[0]);
      let added = false;
      for (const [, ci] of cand.slice(0, 6)) {
        if (!timeLeft()) break;
        const res = evaluate(new Set([...cur.set, ci]));
        if (res) { cur = res; added = true; break; }
      }
      if (!added) break;
    }
    return cur;
  }

  // seed 0: compact regions grown around good home bases (largest prefix of each that fits)
  const big = chunks.length > 300;   // county-sized pool: compact regions are what win
  for (const sd of pickSeeds(chunks, budgetM * 0.45, big ? 12 : 8)) {
    if (!timeLeft()) break;
    if (!evaluate(new Set(sd.order.slice(0, 1)))) continue;
    let lo = 1, hi = sd.order.length + 1;
    while (hi - lo > 1 && timeLeft()) {
      const mid = (lo + hi) >> 1;
      if (evaluate(new Set(sd.order.slice(0, mid)))) lo = mid; else hi = mid;
    }
  }

  // seed 1: nearest chunks first (largest prefix that fits, by binary search); for big pools
  // only as a fallback when no region fit at all
  const byRt = chunks.map((_, i) => i).sort((a, b) => chunks[a].rt - chunks[b].rt);
  if (!best || !big) {
  const first = evaluate(new Set(byRt.slice(0, 1)));
  if (!first) {
    const one = withRoads(G, chunks[byRt[0]].edges), r1 = attempt(one, null);
    throw new Error(`Even the nearest new road needs a ${mi(r1.total)} mi loop. Raise the max distance or move the start.`);
  }
  // largest k in [1, n] whose first k chunks fit
  let seed1 = first, lo = 1, hi = byRt.length + 1;
  while (hi - lo > 1 && (timeLeft() || !best)) {
    const mid = (lo + hi) >> 1;
    const res = evaluate(new Set(byRt.slice(0, mid)));
    if (res) { seed1 = res; lo = mid; } else hi = mid;
  }
  if (timeLeft()) grow(seed1);
  }
  if (best && timeLeft()) grow(best);   // fill any room left in the best region

  // seed 2: densest value near the start (new miles per round trip), then grow
  if (!big && timeLeft()) {
    const byRatio = chunks.map((c, i) => [c.newM / (c.rt + c.len), i]).sort((a, b) => b[0] - a[0]);
    for (const [, ci] of byRatio.slice(0, 3)) {
      const s2 = evaluate(new Set([ci]));
      if (s2) { grow(s2); break; }
    }
  }

  // swaps: drop a weak chunk from the best set and regrow into what that frees up
  for (let round = 0; round < 3 && timeLeft(); round++) {
    const base = best;
    const weak = [...base.set].map(ci => [chunks[ci].newM / (chunks[ci].rt + chunks[ci].len), ci])
      .sort((a, b) => a[0] - b[0]).slice(0, 4);
    let improved = false;
    for (const [, ci] of weak) {
      if (!timeLeft() || base.set.size < 2) break;
      const set = new Set(base.set); set.delete(ci);
      const res = evaluate(set);
      if (!res) continue;
      grow(res);
      if (best !== base) { improved = true; break; }
    }
    if (!improved) break;
  }

  /** More of the same search, for Optimize: many more home bases and region sizes, then
   *  grow and swap rounds. Yields after each step so it can run in time slices. */
  function* extra() {
    for (const frac of [0.45, 0.3, 0.6]) {
      for (const sd of pickSeeds(chunks, budgetM * frac, 30)) {
        if (!evaluate(new Set(sd.order.slice(0, 1)))) { yield; continue; }
        let lo = 1, hi = sd.order.length + 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (evaluate(new Set(sd.order.slice(0, mid)))) lo = mid; else hi = mid;
          yield;
        }
      }
    }
    for (let round = 0; round < 50; round++) {
      const before = best;
      grow(best); yield;
      const weak = [...best.set].map(ci => [chunks[ci].newM / (chunks[ci].rt + chunks[ci].len), ci])
        .sort((a, b) => a[0] - b[0]).slice(0, 8);
      for (const [, ci] of weak) {
        if (best.set.size < 2) break;
        const set = new Set(best.set); set.delete(ci);
        const res = evaluate(set); yield;
        if (res) { grow(res); yield; }
      }
      if (best === before) break;
    }
  }
  best.C.budgetM = budgetM;
  best.C.sel = makeSelector(extra(), () => best, () => tries, d => { deadline = d; });
  return { C: best.C, r: best.r };
}

/** Wraps a goal search so Optimize can resume it in time slices. */
function makeSelector(gen, getBest, getTries, setDeadline) {
  const sel = {
    exhausted: false, getBest, tries: getTries,
    step(until) {
      setDeadline(until);
      while (!sel.exhausted && performance.now() < until) if (gen.next().done) sel.exhausted = true;
    },
  };
  return sel;
}

// ---------- new-miles target: the shortest loop that collects at least N new miles ----------
/** Straight-line reach that holds comfortably more new road than the target (no area drawn). */
function radiusForNew(start, targetM, capM) {
  const [sx, sy] = start, cosS = Math.cos(sy * Math.PI / 180), MPD = 111195.08;
  const near = [];
  for (const ed of NET.edges) {
    if (ed.newM < MIN_NEW_M) continue;
    const [x, y] = ed.coords[ed.coords.length >> 1];
    near.push([Math.hypot((x - sx) * cosS * MPD, (y - sy) * MPD), ed.newM]);
  }
  near.sort((a, b) => a[0] - b[0]);
  let acc = 0, r = 1500;
  for (const [d, m] of near) { acc += m; r = d; if (acc >= 2.5 * targetM) break; }
  r = Math.max(1500, r * 1.25);
  if (capM) r = Math.min(r, capM / 2);
  return r;
}

function solveTarget(G, targetM, capM) {
  const mi = m => (m / 1609.344).toFixed(1);
  let deadline = performance.now() + BUDGET_SECS * 1000;
  const timeLeft = () => performance.now() < deadline;
  const chunks = chunkify(G);
  const evals = new Map(); let best = null, closest = null, tries = 0;
  const keyOf = set => [...set].sort((a, b) => a - b).join(",");
  const ok = r => r.newM >= targetM - 1 && (!capM || r.total <= capM);
  function evaluate(set) {
    const k = keyOf(set);
    if (evals.has(k)) return evals.get(k);
    if (capM) {   // a loop is at least as long as its roads: skip sets that can't fit the max ride
      let roads = 0; for (const ci of set) roads += chunks[ci].len;
      if (roads > capM) { const res = { C: null, r: { newM: 0, total: Infinity, walk: [] }, set: new Set(set) }; evals.set(k, res); return res; }
    }
    const req = []; for (const ci of set) req.push(...chunks[ci].edges);
    const C = withRoads(G, req), r = attempt(C, null); tries++;
    const res = { C, r, set: new Set(set) };
    evals.set(k, res);
    if (ok(r) && (!best || r.total < best.r.total)) best = res;
    if ((!capM || r.total <= capM) && (!closest || r.newM > closest.r.newM)) closest = res;
    say(`Finding the shortest loop with ${mi(targetM)} new mi: ${best ? mi(best.r.total) + " mi so far" : "searching"} (${tries} tries)`);
    return res;
  }
  const ratio = ci => chunks[ci].newM / (chunks[ci].rt + chunks[ci].len);
  /** smallest prefix of an ordering that reaches the target */
  function seed(order) {
    let acc = 0, k = 0;
    while (k < order.length && acc < targetM) acc += chunks[order[k++]].newM;
    for (let extra = 0; extra < 8 && timeLeft(); extra++) {
      const res = evaluate(new Set(order.slice(0, k)));
      if (res.r.newM >= targetM - 1 || k >= order.length) return res;
      k++;
    }
    return null;
  }
  const byRt = chunks.map((_, i) => i).sort((a, b) => chunks[a].rt - chunks[b].rt);
  const byRatio = chunks.map((_, i) => i).sort((a, b) => ratio(b) - ratio(a));
  // compact regions grown around good home bases come first; the scattered seeds are fallbacks
  const big = chunks.length > 300;   // county-sized pool: compact regions are what win
  for (const sd of pickSeeds(chunks, targetM, big ? 12 : 8)) {
    if (!timeLeft()) break;
    seed(sd.order);
  }
  if ((!best || !big) && timeLeft()) seed(byRt);
  if ((!best || !big) && timeLeft()) seed(byRatio);

  // improve: drop chunks that aren't needed, or swap a weak one for a better-placed one
  for (let round = 0; round < 40 && timeLeft() && best; round++) {
    const base = best;
    const weak = [...base.set].sort((a, b) => ratio(a) - ratio(b)).slice(0, 6);
    for (const ci of weak) {                              // drop
      if (!timeLeft()) break;
      const set = new Set(base.set); set.delete(ci);
      if (set.size) evaluate(set);
      if (best !== base) break;
    }
    if (best !== base) continue;
    // swap: remove the weakest, add the best-value chunk near the remaining route
    const routeNodes = [...new Set(base.r.walk.flatMap(([a, b]) => [a, b]))];
    G.SU.run(routeNodes);
    const cand = chunks.map((c, i) => {
      if (base.set.has(i)) return null;
      let d = Infinity; for (const x of c.nodes) d = Math.min(d, G.SU.d(x));
      return d === Infinity ? null : [c.newM / (2 * d + c.len), i];
    }).filter(Boolean).sort((a, b) => b[0] - a[0]).slice(0, 4);
    for (const ci of weak.slice(0, 3)) {
      for (const [, add] of cand) {
        if (!timeLeft()) break;
        const set = new Set(base.set); set.delete(ci); set.add(add);
        evaluate(set);
      }
      if (best !== base) break;
    }
    if (best === base) break;
  }

  /** More of the same search, for Optimize: more home bases at a few region sizes, then
   *  drop and swap rounds. Yields after each step so it can run in time slices. */
  function* extra() {
    for (const mult of [1.0, 1.2, 0.85]) {
      for (const sd of pickSeeds(chunks, targetM * mult, 30)) {
        let acc = 0, k = 0;
        while (k < sd.order.length && acc < targetM) acc += chunks[sd.order[k++]].newM;
        for (let x = 0; x < 8; x++) {
          const res = evaluate(new Set(sd.order.slice(0, k))); yield;
          if (res.r.newM >= targetM - 1 || k >= sd.order.length) break;
          k++;
        }
      }
    }
    for (let round = 0; round < 80 && best; round++) {
      const base = best;
      const weak = [...base.set].sort((a, b) => ratio(a) - ratio(b)).slice(0, 10);
      for (const ci of weak) {
        const set = new Set(base.set); set.delete(ci);
        if (set.size) { evaluate(set); yield; }
        if (best !== base) break;
      }
      if (best !== base) continue;
      const routeNodes = [...new Set(base.r.walk.flatMap(([a, b]) => [a, b]))];
      G.SU.run(routeNodes);
      const cand = chunks.map((c, i) => {
        if (base.set.has(i)) return null;
        let d = Infinity; for (const x of c.nodes) d = Math.min(d, G.SU.d(x));
        return d === Infinity ? null : [c.newM / (2 * d + c.len), i];
      }).filter(Boolean).sort((a, b) => b[0] - a[0]).slice(0, 6);
      for (const ci of weak.slice(0, 5)) {
        for (const [, add] of cand) {
          const set = new Set(base.set); set.delete(ci); set.add(add);
          evaluate(set); yield;
        }
        if (best !== base) break;
      }
      if (best === base) break;
    }
  }

  if (best) {
    best.C.goal = { met: true };
    best.C.sel = makeSelector(extra(), () => best, () => tries, d => { deadline = d; });
    return { C: best.C, r: best.r };
  }
  // couldn't reach the target (not enough new road nearby, or not within the max ride)
  if (capM) {
    const res = solveBudget(G, capM);
    res.C.goal = { met: false };
    return res;
  }
  const res = closest || evaluate(new Set(chunks.map((_, i) => i)));
  res.C.goal = { met: false };
  return { C: res.C, r: res.r };
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

  // 4. directed Euler circuit from the start, preferring to go straight through each intersection
  const out = Array.from({ length: n }, () => []);
  arcs.forEach(([a], k) => out[a].push(k));
  if (rng) for (const l of out) for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  const stack = [[start, -1]], seq = [];
  while (stack.length) {
    const [x, inK] = stack[stack.length - 1];
    const l = out[x];
    if (l.length) {
      // take the exit closest to straight ahead (a U-turn is the last resort)
      let pick = l.length - 1;
      if (inK >= 0) {
        const inE = arcs[inK][2]; let best = Infinity;
        for (let i = l.length - 1; i >= 0; i--) {
          const a = C.turnAngle(x, inE, arcs[l[i]][2]) + (rng ? rand() * 0.35 : 0);
          if (a < best) { best = a; pick = i; }
        }
      }
      const k = l[pick]; l[pick] = l[l.length - 1]; l.pop();
      stack.push([arcs[k][1], k]);
    } else seq.push(stack.pop()[1]);
  }
  seq.reverse();
  const steps = seq.filter(k => k >= 0);
  if (steps.length !== arcs.length) throw new Error("Couldn't join every road into one loop. Try a smaller area.");

  let walk = steps.map(k => arcs[k]);
  if (C.style.uturn > 0) walk = cleanupUturns(C, walk);
  return score(C, walk);
}

/** Replace U-turns at intersections that have another way out with a loop back,
 *  when the loop costs less than the style's U-turn allowance. */
function cleanupUturns(C, walk) {
  const { edges, DA, SX, style } = C;
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    let changed = false;
    for (let i = 0; i < walk.length; i++) {
      const cur = walk[i], nxt = walk[i + 1];
      out.push(cur);
      if (!nxt) continue;
      const [a, b, e] = cur;
      if (nxt[2] !== e || nxt[1] !== a) continue;          // not a U-turn at b
      let exit = false;
      for (let p = DA.start[b]; p < DA.start[b + 1]; p++) if (DA.eid[p] !== e) { exit = true; break; }
      if (!exit) continue;                                  // true dead end: nothing to do
      const limit = edges[e].len + style.uturn + 6 * (style.turn || 0);
      SX.ban = e;
      const hit = SX.run([b], (x, d) => x === a || d > limit, e);
      SX.ban = -1;
      if (hit !== a) continue;
      const loop = SX.path(a);
      const extra = loop.reduce((s, st) => s + edges[st[2]].len, 0) - edges[e].len;
      if (extra > style.uturn) continue;
      for (const st of loop) out.push(st);
      i++; changed = true;                                  // the ride back is replaced by the loop
    }
    walk = out;
    if (!changed) break;
  }
  return walk;
}

/** Distance, repeats, turns and U-turns of a walk, and its cost under the style. */
function score(C, walk) {
  const { edges, style, turnAngle, TURN, UTURN } = C;
  const count = new Map(); let total = 0, uturns = 0, turns = 0;
  for (let i = 0; i < walk.length; i++) {
    const [, b, e] = walk[i];
    total += edges[e].len; count.set(e, (count.get(e) || 0) + 1);
    if (i < walk.length - 1) {
      const t = turnAngle(b, e, walk[i + 1][2]);
      if (t > UTURN) uturns++; else if (t > TURN) turns++;
    }
  }
  let repeat = 0, newM = 0;
  for (const [e, c] of count) { repeat += (c - 1) * edges[e].len; newM += edges[e].newM; }
  const cost = total + (style.repeat || 0) * repeat + (style.turn || 0) * turns + (style.uturn || 0) * uturns;
  return { walk, total, repeat, newM, uturns, turns, cost };
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
  for (const [a, , e] of r.walk) {
    const ed = edges[e];
    const seg = a === ed.u ? ed.coords : ed.coords.slice().reverse();
    for (let i = coords.length ? 1 : 0; i < seg.length; i++) coords.push(seg[i]);
  }
  let wrongWay = 0;
  for (const [a, , e] of r.walk) if (!C.allowed(edges[e], a)) wrongWay++;
  let skipped = null;
  if (C.budgetM || (C.goal && C.goal.type !== "all")) {
    const inSet = new Set(C.req);
    skipped = C.reqReach.filter(i => !inSet.has(i)).map(i => edges[i].coords);
  }
  return { coords, totalM: r.total, newM: r.newM, repeatM: r.repeat, uturns: r.uturns, turns: r.turns, newAvailM: C.newAvail,
           areaNewM: C.areaNewM, budgetM: C.budgetM || 0, skipped, goal: C.goal || { type: "all" }, hasArea: !!C.hasArea,
           wrongWay, dropped: C.dropped, startLonLat: lonlat[start], ms: Math.round(ms), tries };
}

// ---------- optimizer: better road selections (goals) and better routes ----------
/** Is result a better than b for this goal? (selection-level comparison) */
function goalBetter(goal, a, b) {
  if (goal && goal.type === "distance") return a.newM > b.newM + 1 || (Math.abs(a.newM - b.newM) <= 1 && a.total < b.total - 1);
  if (goal && goal.type === "newmiles" && goal.met) return a.total < b.total - 1;
  return a.cost < b.cost - 1;
}

/** opts.silent: part of the first pass (no intermediate routes, result reported as the build) */
function optimize(seconds, opts = {}) {
  if (!CTX || !CTX.best) { self.postMessage({ error: "Build a route first." }); return; }
  if (OPT) OPT.stop = true;
  const sel = CTX.sel;
  const opt = OPT = { stop: false, until: performance.now() + seconds * 1000, tries: 0, t0: performance.now(),
                      seed: (Math.random() * 2 ** 31) | 0, phase: 0, selTries0: sel ? sel.tries() : 0 };
  const startTotal = CTX.best.total;
  const carry = (C) => { // keep goal info when switching to a newly found selection
    for (const k of ["goal", "hasArea", "budgetM", "sel"]) if (CTX[k] !== undefined && C[k] === undefined) C[k] = CTX[k];
  };
  const finish = () => {
    const r = pack(CTX, CTX.best, performance.now() - (opts.t0 ?? opt.t0), opt.tries);
    r.selTries = sel ? sel.tries() - opt.selTries0 : 0;
    r.routeTries = opt.tries;
    self.postMessage({ result: r, final: true, optimized: !opts.silent });
    OPT = null;
  };
  const tick = () => {
    if (opt !== OPT) return;
    const sliceEnd = Math.min(opt.until, performance.now() + 150);
    try {
      if (sel && !sel.exhausted && opt.phase++ % 5 < 3) {
        // try other road selections
        sel.step(sliceEnd);
        const b = sel.getBest();
        if (b && b.C !== CTX && goalBetter(CTX.goal, b.r, CTX.best)) {
          carry(b.C); CTX = b.C; CTX.best = b.r;
          if (!opts.silent) self.postMessage({ result: pack(CTX, CTX.best, performance.now() - opt.t0, opt.tries), final: false });
        }
      } else {
        // try better routes for the current selection
        while (performance.now() < sliceEnd && !opt.stop) {
          const r = attempt(CTX, mulberry32(opt.seed + opt.tries++));
          const g = CTX.goal || {};
          const within = !(CTX.budgetM && r.total > CTX.budgetM) && !(g.capM && r.total > g.capM) &&
                         !(g.type === "newmiles" && g.met && r.newM < g.newM - 1);   // keep the goal met
          if (r.cost < CTX.best.cost - 1 && within) {
            CTX.best = r;
            if (!opts.silent) self.postMessage({ result: pack(CTX, r, performance.now() - opt.t0, opt.tries), final: false });
          }
        }
      }
    } catch (err) { console.warn("optimize step failed", err); }
    if (opt.stop || performance.now() >= opt.until) { finish(); return; }
    const secsLeft = Math.max(0, Math.ceil((opt.until - performance.now()) / 1000));
    const diff = (startTotal - CTX.best.total) / 1609.344;
    const selN = sel ? sel.tries() - opt.selTries0 : 0;
    if (opts.silent) {
      const g = CTX.goal || {}, b = CTX.best;
      say(`Searching for the best loop: ${selN} road selections, ${opt.tries} routes tried. Best so far: ` +
          (g.type === "distance" ? `${(b.newM / 1609.344).toFixed(1)} new mi` : `${(b.total / 1609.344).toFixed(1)} mi loop`) + `, ${secsLeft} s left`);
    } else say(`Optimizing: ${sel ? selN + " road selections, " : ""}${opt.tries} routes tried, ` +
        `${Math.abs(diff) > 0.05 ? (diff > 0 ? diff.toFixed(1) + " mi shorter" : "better mix found") : "no improvement yet"}, ${secsLeft} s left`);
    setTimeout(tick, 0);
  };
  tick();
}
