/* Rideable OSM roads in 0.1-degree tiles.
 * 1. The site's own tiles (data/roads/, built monthly by the GitHub Action
 *    from Geofabrik's Indiana extract) are used wherever they exist.
 * 2. Tiles outside that coverage fall back to the Overpass API; those are
 *    saved in this browser so a retry only fetches what's missing. */
(function () {
  const SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  const TILE = 0.1;          // degrees (~11 km N-S, ~8.5 km E-W at Indy)
  const BUFFER_DEG = 0.015;  // ~1.5 km around the KMZ so loops can leave and come back
  const PARALLEL = 2;        // Overpass allows about 2 concurrent requests per user
  const TRIES = 3;           // passes over the server list per tile

  function query([w, s, e, n]) {
    const bb = `${s},${w},${n},${e}`;
    return `[out:json][timeout:90];
(
  way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|cycleway|path|track|busway)$"](${bb});
  way["highway"~"^(footway|pedestrian|bridleway)$"]["bicycle"~"^(yes|designated|permissive)$"](${bb});
);
out body geom qt;`;
  }

  function tilesFor(bbox) {
    const [w, s, e, n] = [bbox[0] - BUFFER_DEG, bbox[1] - BUFFER_DEG, bbox[2] + BUFFER_DEG, bbox[3] + BUFFER_DEG];
    const tiles = [];
    for (let x = Math.floor(w / TILE); x * TILE < e; x++) {
      for (let y = Math.floor(s / TILE); y * TILE < n; y++) {
        const box = [x * TILE, y * TILE, (x + 1) * TILE, (y + 1) * TILE].map(v => +v.toFixed(4));
        tiles.push({ key: `tile:${x},${y}`, id: `${x}_${y}`, box });
      }
    }
    return tiles;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // ---------- the site's own road tiles ----------
  const LOCAL = "data/roads/";
  let indexPromise = null;
  function localIndex() {
    // index.json is tiny and changes monthly: revalidate it every visit
    indexPromise ??= fetch(LOCAL + "index.json", { cache: "no-cache" })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    return indexPromise;
  }
  const undelta = d => { let v = 0; return d.map(x => (v += x)); };
  function decodeTile(doc, fetchedAt) {
    const elements = doc.ways.map(([id, ti, n, lo, la]) => {
      const lons = undelta(lo), lats = undelta(la);
      return { type: "way", id, nodes: undelta(n), tags: doc.tags[ti],
               geometry: lons.map((x, i) => ({ lon: x / 1e6, lat: lats[i] / 1e6 })) };
    });
    return { elements, signals: doc.sig || [], fetchedAt };
  }
  async function fetchLocal(tile, index) {
    // URL carries the build date, so the browser can cache it until next month's build
    const res = await fetch(`${LOCAL}${tile.id}.json?b=${encodeURIComponent(index.built)}`);
    if (!res.ok) throw new Error(`site tile ${tile.id} answered ${res.status}`);
    return decodeTile(await res.json(), index.osm_date || index.built);
  }

  const TIMEOUT_MS = 75000;  // give up on a server after this and try the next one
  const host = url => new URL(url).host;

  /** Fetch one tile, trying each server in turn. status(text) reports live progress. */
  async function fetchTile(tile, status) {
    const body = "data=" + encodeURIComponent(query(tile.box));
    const log = [];
    let lastErr, attempt = 0;
    for (let pass = 0; pass < TRIES; pass++) {
      for (const url of SERVERS) {
        attempt++;
        const ctrl = new AbortController();
        const started = performance.now();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const tick = setInterval(() =>
          status(`${host(url)}, try ${attempt}, ${Math.round((performance.now() - started) / 1000)} s`), 1000);
        status(`${host(url)}, try ${attempt}, 0 s`);
        try {
          const res = await fetch(url, { method: "POST", body, signal: ctrl.signal,
            headers: { "Content-Type": "application/x-www-form-urlencoded" } });
          if (res.status === 429) throw new Error("busy (429)");
          if (!res.ok) throw new Error(`answered ${res.status}`);
          const text = await res.text();
          const json = JSON.parse(text);
          if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error(json.remark);
          const secs = (performance.now() - started) / 1000;
          log.push({ server: host(url), result: "ok", seconds: +secs.toFixed(1), MB: +(text.length / 1e6).toFixed(2) });
          console.table(log.map(r => ({ tile: tile.key, ...r })));
          return { elements: json.elements || [], fetchedAt: new Date().toISOString() };
        } catch (err) {
          const secs = (performance.now() - started) / 1000;
          const why = err.name === "AbortError" ? `no answer in ${TIMEOUT_MS / 1000} s` : err.message;
          log.push({ server: host(url), result: why, seconds: +secs.toFixed(1) });
          lastErr = new Error(`${host(url)}: ${why}`);
          console.warn("Overpass tile failed:", tile.key, lastErr.message);
        } finally {
          clearTimeout(timer); clearInterval(tick);
        }
      }
      status(`all servers failed, waiting before round ${pass + 2}`);
      await sleep(3000 * (pass + 1));
    }
    console.table(log.map(r => ({ tile: tile.key, ...r })));
    throw lastErr;
  }

  function merge(tileData, tiles) {
    const seen = new Set(), elements = [];
    let oldest = null;
    for (const t of tileData) {
      if (!oldest || t.fetchedAt < oldest) oldest = t.fetchedAt;
      for (const el of t.elements) if (!seen.has(el.id)) { seen.add(el.id); elements.push(el); }
    }
    const box = [
      Math.min(...tiles.map(t => t.box[0])), Math.min(...tiles.map(t => t.box[1])),
      Math.max(...tiles.map(t => t.box[2])), Math.max(...tiles.map(t => t.box[3])),
    ];
    const signals = [...new Set(tileData.flatMap(t => t.signals || []))];
    return { box, elements, signals, fetchedAt: oldest, tiles: tiles.length };
  }

  /** True when every tile is on the site or saved in this browser (no Overpass needed). */
  async function available(bbox) {
    const index = await localIndex();
    for (const t of tilesFor(bbox)) {
      if (index?.tiles?.[t.id] !== undefined) continue;
      if (!(await Store.get(t.key))) return false;
    }
    return true;
  }

  /** Download missing tiles (all tiles when force), then return merged roads. */
  async function fetchRoads(bbox, onProgress, force = false) {
    const tiles = tilesFor(bbox);
    const data = new Array(tiles.length);
    const index = await localIndex();
    const t0 = performance.now();

    // 1. site tiles, several at a time (static files, fast)
    const local = tiles.map((t, i) => i).filter(i => index?.tiles?.[tiles[i].id] !== undefined);
    let loaded = 0, q = 0;
    const localLane = async () => {
      while (q < local.length) {
        const i = local[q++];
        data[i] = await fetchLocal(tiles[i], index);
        onProgress?.(`Loading roads: ${++loaded} of ${local.length} tiles`);
      }
    };
    if (local.length) {
      onProgress?.(`Loading roads: 0 of ${local.length} tiles`);
      await Promise.all(Array.from({ length: Math.min(6, local.length) }, localLane));
    }

    // 2. anything outside the site's coverage: browser cache, then Overpass
    const todo = [];
    for (let i = 0; i < tiles.length; i++) {
      if (data[i]) continue;
      const d = force ? null : await Store.get(tiles[i].key);
      if (d) data[i] = d; else todo.push(i);
    }
    let done = tiles.length - todo.length, failed = 0;
    const active = new Map(); // tile index -> live status text
    const report = () => {
      const head = `Downloading roads: ${done} of ${tiles.length} tiles done` + (failed ? `, ${failed} failed` : "");
      const lines = [...active].map(([i, txt]) => `Tile ${i + 1}: ${txt}`);
      onProgress?.([head, ...lines].join("\n"));
    };
    if (todo.length) report();

    let next = 0;
    async function lane() {
      while (next < todo.length) {
        const i = todo[next++];
        active.set(i, "starting");
        try {
          data[i] = await fetchTile(tiles[i], txt => { active.set(i, txt); report(); });
          await Store.set(tiles[i].key, data[i]);
          done++;
        } catch (err) {
          failed++;
          console.error("Tile gave up:", tiles[i].key, err);
        }
        active.delete(i);
        report();
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, lane));
    const downloadMs = performance.now() - t0;

    if (failed) {
      throw new Error(`${failed} of ${tiles.length} road tiles couldn't be downloaded; the OpenStreetMap servers are busy. ` +
        (done ? `The other ${done} are saved, so ` : "") + `${done ? "click" : "Click"} Get roads again in a minute to fetch the missing ones.`);
    }
    return { ...merge(data, tiles), downloadMs };
  }

  window.Osm = { fetchRoads, available, tilesFor, localIndex };
})();
