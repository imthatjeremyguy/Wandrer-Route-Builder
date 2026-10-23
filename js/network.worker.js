/* Build a routable bike network from Overpass JSON and tag each edge with
 * Wandrer "new" metres. Port of prototype/build_network.py.
 *
 * in:  { elements, lines: [{coords:[[lon,lat],...]}] }
 * out: { nodes: [[lon,lat],...], edges: [...], stats }
 *   edge = { u, v, len, newM, oneway: 0|1|-1, coords:[[lon,lat],...] (u -> v), name, hw, way }
 */
const MATCH_DIST = 6;          // m: untraveled line must be this close...
const MATCH_ANGLE = 25 * Math.PI / 180; // ...and this parallel
const SAMPLE = 3;              // m between samples along a road
const CELL = 25;               // m grid cell for the spatial index

const RIDEABLE = new Set(["trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service",
  "cycleway", "path", "track", "busway"]);
const NO_SERVICE = new Set(["driveway", "parking_aisle", "drive-through"]);
const BLOCK = new Set(["no", "private", "customers", "delivery"]);
const BIKE_OK = new Set(["yes", "designated", "permissive"]);

function rideable(t) {
  const h = t.highway;
  if (BIKE_OK.has(t.bicycle)) return !["motorway", "motorway_link", "steps"].includes(h);
  if (!RIDEABLE.has(h)) return false;
  if (BLOCK.has(t.access) || ["no", "private", "dismount"].includes(t.bicycle)) return false;
  if (h === "service" && NO_SERVICE.has(t.service)) return false;
  if (h === "path" && !t.bicycle && t.foot === "designated") return false;
  if (t.area === "yes") return false;
  return true;
}

function onewayOf(t) {
  if (t["oneway:bicycle"] === "no") return 0;
  if (["cycleway", "path"].includes(t.highway)) return 0;
  if (t.oneway === "-1") return -1;
  if (t.oneway === "yes" || t.oneway === "1") return 1;
  return 0;
}

self.onmessage = (e) => {
  const t0 = performance.now();
  const { elements, lines } = e.data;
  const post = msg => self.postMessage({ progress: msg });

  // ---- projection (local equirectangular, metres) ----
  let latSum = 0, latN = 0;
  for (const l of lines) for (const p of l.coords) { latSum += p[1]; latN++; }
  const lat0 = latN ? latSum / latN : 39.8;
  const MY = 111195.08, MX = MY * Math.cos(lat0 * Math.PI / 180); // metres per degree, spherical earth (matches haversine)
  const P = ([lon, lat]) => [lon * MX, lat * MY];

  // ---- spatial index of untraveled pieces ----
  post("Indexing untraveled roads...");
  const segs = []; // [ax, ay, bx, by, angle, len]
  const seen = new Set();
  for (const l of lines) {
    for (let i = 0; i < l.coords.length - 1; i++) {
      const a = l.coords[i], b = l.coords[i + 1];
      const ka = a[0].toFixed(6) + "," + a[1].toFixed(6), kb = b[0].toFixed(6) + "," + b[1].toFixed(6);
      if (ka === kb) continue;
      const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
      if (seen.has(key)) continue;
      seen.add(key);
      const [ax, ay] = P(a), [bx, by] = P(b);
      let ang = Math.atan2(by - ay, bx - ax); ang = ((ang % Math.PI) + Math.PI) % Math.PI;
      segs.push([ax, ay, bx, by, ang, Math.hypot(bx - ax, by - ay)]);
    }
  }
  const untraveledM = segs.reduce((s, g) => s + g[5], 0);
  const grid = new Map();
  const cellKey = (cx, cy) => cx * 1e6 + cy;
  segs.forEach((g, i) => {
    const x0 = Math.floor((Math.min(g[0], g[2]) - MATCH_DIST) / CELL), x1 = Math.floor((Math.max(g[0], g[2]) + MATCH_DIST) / CELL);
    const y0 = Math.floor((Math.min(g[1], g[3]) - MATCH_DIST) / CELL), y1 = Math.floor((Math.max(g[1], g[3]) + MATCH_DIST) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
      const k = cellKey(cx, cy); let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(i);
    }
  });
  function distToSeg(px, py, g) {
    const dx = g[2] - g[0], dy = g[3] - g[1], L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - g[0]) * dx + (py - g[1]) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (g[0] + t * dx), py - (g[1] + t * dy));
  }
  function newFraction(a, b) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let th = Math.atan2(b[1] - a[1], b[0] - a[0]); th = ((th % Math.PI) + Math.PI) % Math.PI;
    const n = Math.max(1, Math.floor(L / SAMPLE));
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n, px = a[0] + f * (b[0] - a[0]), py = a[1] + f * (b[1] - a[1]);
      const cand = grid.get(cellKey(Math.floor(px / CELL), Math.floor(py / CELL)));
      if (!cand) continue;
      for (const j of cand) {
        const g = segs[j];
        let d = Math.abs(g[4] - th); d = Math.min(d, Math.PI - d);
        if ((d < MATCH_ANGLE || g[5] < 3) && distToSeg(px, py, g) <= MATCH_DIST) { hits++; break; }
      }
    }
    return hits / n;
  }

  // ---- ways -> graph split at intersections ----
  post("Building road network...");
  const ways = [];
  for (const el of elements) {
    if (el.type !== "way" || !el.tags || !el.geometry || el.nodes?.length !== el.geometry.length) continue;
    if (!rideable(el.tags)) continue;
    ways.push(el);
  }
  const use = new Map();
  for (const w of ways) {
    for (const id of w.nodes) use.set(id, (use.get(id) || 0) + 1);
    use.set(w.nodes[0], use.get(w.nodes[0]) + 1);
    use.set(w.nodes.at(-1), use.get(w.nodes.at(-1)) + 1);
  }
  const nodeIndex = new Map(), nodes = [];
  const nid = (osmId, lonlat) => {
    let i = nodeIndex.get(osmId);
    if (i === undefined) { i = nodes.length; nodeIndex.set(osmId, i); nodes.push(lonlat); }
    return i;
  };
  const edges = [];
  let done = 0;
  for (const w of ways) {
    const t = w.tags, ow = onewayOf(t);
    let chunk = [0];
    for (let i = 1; i < w.nodes.length; i++) {
      chunk.push(i);
      if (use.get(w.nodes[i]) > 1 || i === w.nodes.length - 1) {
        const ll = chunk.map(k => [w.geometry[k].lon, w.geometry[k].lat]);
        const pp = ll.map(P);
        let len = 0, newM = 0;
        for (let k = 0; k < pp.length - 1; k++) {
          const sl = Math.hypot(pp[k + 1][0] - pp[k][0], pp[k + 1][1] - pp[k][1]);
          len += sl;
          if (sl > 0 && segs.length) newM += sl * newFraction(pp[k], pp[k + 1]);
        }
        if (len > 0) edges.push({
          u: nid(w.nodes[chunk[0]], ll[0]), v: nid(w.nodes[chunk.at(-1)], ll.at(-1)),
          len, newM, oneway: ow, coords: ll, name: t.name || "", hw: t.highway, way: w.id,
        });
        chunk = [i];
      }
    }
    if (++done % 2000 === 0) post(`Building road network... ${Math.round(100 * done / ways.length)}%`);
  }

  // ---- keep the largest connected piece ----
  const parent = nodes.map((_, i) => i);
  const find = x => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const ed of edges) parent[find(ed.u)] = find(ed.v);
  const size = new Map();
  for (let i = 0; i < nodes.length; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
  let bigRoot = -1, bigSize = 0;
  for (const [r, s] of size) if (s > bigSize) { bigRoot = r; bigSize = s; }
  const kept = edges.filter(ed => find(ed.u) === bigRoot);
  const droppedNew = edges.reduce((s, ed) => s + (find(ed.u) === bigRoot ? 0 : ed.newM), 0);

  // reindex nodes compactly
  const remap = new Map(), outNodes = [];
  const rn = i => { let j = remap.get(i); if (j === undefined) { j = outNodes.length; remap.set(i, j); outNodes.push(nodes[i]); } return j; };
  for (const ed of kept) { ed.u = rn(ed.u); ed.v = rn(ed.v); }

  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  self.postMessage({
    result: {
      nodes: outNodes, edges: kept,
      stats: {
        untraveledM, rideableM: sum(kept, x => x.len), newM: sum(kept, x => x.newM),
        newEdges: kept.filter(x => x.newM > 0).length, edges: kept.length, nodes: outNodes.length,
        droppedNewM: droppedNew, ms: Math.round(performance.now() - t0),
      },
    },
  });
};
