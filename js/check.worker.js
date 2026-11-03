/* Check a route you made yourself (GPX): match it to the road network and measure it the same way as
 * a built route. Separate from both solvers.
 *
 * in:  {type:"network", nodes, edges}
 *      {type:"check", coords:[[lon,lat],...], skipUnpaved}
 * out: {progress} | {error} | {result, final:true}
 */
const MPD = 111195.08;
const MATCH_M = 15;                    // a track point matches a road within this distance...
const MATCH_ANGLE = 35 * Math.PI / 180; // ...running in (either) direction within this angle
const STEP = 5;                        // resample the track every 5 m
const NEAR_MISS_M = 120;               // "missed nearby": new road within this distance of the track
const MIN_NEW_M = 15;                  // same minimum as the solvers
const say = msg => self.postMessage({ progress: msg });

let NET = null;

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === "network") NET = prepare(m.nodes, m.edges);
    else if (m.type === "check") {
      const t0 = performance.now();
      const r = check(m.coords, !!m.skipUnpaved);
      r.ms = Math.round(performance.now() - t0);
      self.postMessage({ result: r, final: true });
    }
  } catch (err) {
    console.error(err);
    self.postMessage({ error: err.message || String(err) });
  }
};

/* ---------- network in metres, with a grid of road pieces ---------- */
function prepare(nodes, edges) {
  let lat = 0; for (const p of nodes) lat += p[1]; lat /= nodes.length || 1;
  const kx = MPD * Math.cos(lat * Math.PI / 180);
  const P = ([lon, lat]) => [lon * kx, lat * MPD];
  const CELL = 30, grid = new Map(), key = (x, y) => x * 1e6 + y;
  const segs = [];   // [ax, ay, bx, by, edge]
  edges.forEach((ed, i) => {
    for (let k = 1; k < ed.coords.length; k++) {
      const [ax, ay] = P(ed.coords[k - 1]), [bx, by] = P(ed.coords[k]);
      if (ax === bx && ay === by) continue;
      const s = segs.length; segs.push([ax, ay, bx, by, i]);
      for (let gx = Math.floor((Math.min(ax, bx) - MATCH_M) / CELL); gx <= Math.floor((Math.max(ax, bx) + MATCH_M) / CELL); gx++)
        for (let gy = Math.floor((Math.min(ay, by) - MATCH_M) / CELL); gy <= Math.floor((Math.max(ay, by) + MATCH_M) / CELL); gy++) {
          const k2 = key(gx, gy); let l = grid.get(k2); if (!l) grid.set(k2, l = []); l.push(s);
        }
    }
  });
  const degree = new Int32Array(nodes.length);
  for (const ed of edges) { degree[ed.u]++; degree[ed.v]++; }
  return { nodes, edges, P, kx, segs, grid, CELL, key, degree };
}

/* ---------- the check ---------- */
function check(coords, skipUnpaved) {
  if (!NET) throw new Error("The road network isn't loaded yet.");
  if (!coords || coords.length < 2) throw new Error("That GPX file has no track in it.");
  const { edges, nodes, P, segs, grid, CELL, key, degree } = NET;
  say("Matching your route to the roads...");

  // track in metres, duplicates dropped, then resampled every STEP m
  const raw = coords.map(P).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
  let total = 0; for (let i = 1; i < raw.length; i++) total += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
  const pts = [raw[0]];
  let carry = 0;
  for (let i = 1; i < raw.length; i++) {
    const [ax, ay] = raw[i - 1], [bx, by] = raw[i], L = Math.hypot(bx - ax, by - ay);
    let s = STEP - carry;
    while (s <= L) { pts.push([ax + (bx - ax) * s / L, ay + (by - ay) * s / L]); s += STEP; }
    carry = L - (s - STEP);
  }

  // match each point to the nearest road piece running the same way
  const near = (x, y, hd) => {
    const l = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    if (!l) return -1;
    let best = -1, bd = MATCH_M;
    for (const s of l) {
      const [ax, ay, bx, by, e] = segs[s], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
      const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
      if (d >= bd) continue;
      let df = Math.abs(hd - Math.atan2(dy, dx)) % Math.PI; df = Math.min(df, Math.PI - df);
      if (df < MATCH_ANGLE) { bd = d; best = e; }
    }
    return best;
  };
  const metres = new Map(), passes = new Map();
  let last = -1, run = 0;
  const endRun = () => { if (last >= 0 && run * STEP >= Math.min(30, 0.3 * edges[last].len)) passes.set(last, (passes.get(last) || 0) + 1); };
  for (let i = 1; i < pts.length - 1; i++) {
    const hd = Math.atan2(pts[i + 1][1] - pts[i - 1][1], pts[i + 1][0] - pts[i - 1][0]);
    const e = near(pts[i][0], pts[i][1], hd);
    if (e < 0) continue;
    metres.set(e, (metres.get(e) || 0) + STEP);
    if (e !== last) { endRun(); last = e; run = 0; }
    run++;
  }
  endRun();
  const covered = [...metres].filter(([e, m]) => m >= Math.min(edges[e].len - 20, 0.6 * edges[e].len)).map(([e]) => e);
  const isNew = ed => ed.newM >= MIN_NEW_M && !(skipUnpaved && ed.unpaved);
  let newM = 0, repeat = 0;
  for (const e of covered) {
    newM += edges[e].newM;
    repeat += Math.max(0, (passes.get(e) || 1) - 1) * edges[e].len;
  }

  // turns and U-turns from the heading change over +-20 m; a U-turn at a road end is a cul-de-sac
  const nodeGrid = new Map();
  nodes.forEach((p, i) => { const [x, y] = P(p), k2 = key(Math.floor(x / CELL), Math.floor(y / CELL)); let l = nodeGrid.get(k2); if (!l) nodeGrid.set(k2, l = []); l.push(i); });
  const nearestNode = (x, y) => {
    let best = -1, bd = 25;
    for (let gx = Math.floor(x / CELL) - 1; gx <= Math.floor(x / CELL) + 1; gx++) for (let gy = Math.floor(y / CELL) - 1; gy <= Math.floor(y / CELL) + 1; gy++)
      for (const i of nodeGrid.get(key(gx, gy)) || []) { const [nx, ny] = P(nodes[i]), d = Math.hypot(nx - x, ny - y); if (d < bd) { bd = d; best = i; } }
    return best;
  };
  let turns = 0, uturns = 0, culdesacs = 0;
  const W = 4;
  for (let i = W; i < pts.length - W;) {
    const h1 = Math.atan2(pts[i][1] - pts[i - W][1], pts[i][0] - pts[i - W][0]);
    const h2 = Math.atan2(pts[i + W][1] - pts[i][1], pts[i + W][0] - pts[i][0]);
    let d = Math.abs(h2 - h1) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d;
    if (d > 150 * Math.PI / 180) {
      const nd = nearestNode(pts[i][0], pts[i][1]);
      if (nd >= 0 && degree[nd] <= 1) culdesacs++; else uturns++;
      i += 2 * W;
    } else if (d > 55 * Math.PI / 180) { turns++; i += 2 * W; }
    else i++;
  }

  // new roads it passes close to but doesn't ride
  const trackGrid = new Map(), TC = 60;
  for (const [x, y] of pts) trackGrid.set(key(Math.floor(x / TC), Math.floor(y / TC)), 1);
  const nearTrack = (x, y) => {
    const r = Math.ceil(NEAR_MISS_M / TC);
    for (let gx = Math.floor(x / TC) - r; gx <= Math.floor(x / TC) + r; gx++)
      for (let gy = Math.floor(y / TC) - r; gy <= Math.floor(y / TC) + r; gy++) if (trackGrid.has(key(gx, gy))) return true;
    return false;
  };
  const coveredSet = new Set(covered), missed = [];
  let missedM = 0;
  edges.forEach((ed, i) => {
    if (coveredSet.has(i) || !isNew(ed)) return;
    if ((metres.get(i) || 0) > 0.6 * ed.len) return;
    const [x, y] = P(ed.coords[ed.coords.length >> 1]);
    if (nearTrack(x, y)) { missed.push(ed.coords); missedM += ed.newM; }
  });

  return { mode: "check", coords, totalM: total, newM, repeatM: repeat, turns, uturns, culdesacs,
           missed, missedM, matchedShare: covered.reduce((s, e) => s + edges[e].len, 0) / Math.max(1, total), tries: 1 };
}
