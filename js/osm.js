/* Fetch rideable OSM roads from the Overpass API in cached tiles.
 * Big areas (a whole county) are split into ~0.1 degree tiles so each request
 * stays small; every tile is saved as it arrives, so a retry only fetches
 * what's missing. */
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
        tiles.push({ key: `tile:${x},${y}`, box });
      }
    }
    return tiles;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchTile(tile) {
    const body = "data=" + encodeURIComponent(query(tile.box));
    let lastErr;
    for (let pass = 0; pass < TRIES; pass++) {
      for (const url of SERVERS) {
        try {
          const res = await fetch(url, { method: "POST", body,
            headers: { "Content-Type": "application/x-www-form-urlencoded" } });
          if (res.status === 429) { await sleep(5000); throw new Error("busy (429)"); }
          if (!res.ok) throw new Error(`answered ${res.status}`);
          const json = await res.json();
          if (json.remark && /error|timed out|runtime/i.test(json.remark)) throw new Error(json.remark);
          return { elements: json.elements || [], fetchedAt: new Date().toISOString() };
        } catch (err) {
          lastErr = new Error(`${new URL(url).host} ${err.message}`);
          console.warn("Overpass tile failed:", tile.key, lastErr.message);
        }
      }
      await sleep(3000 * (pass + 1));
    }
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
    return { box, elements, fetchedAt: oldest, tiles: tiles.length };
  }

  /** Roads for bbox from the browser cache only; null if any tile is missing. */
  async function cached(bbox) {
    const tiles = tilesFor(bbox);
    const data = [];
    for (const t of tiles) {
      const d = await Store.get(t.key);
      if (!d) return null;
      data.push(d);
    }
    return merge(data, tiles);
  }

  /** Download missing tiles (all tiles when force), then return merged roads. */
  async function fetchRoads(bbox, onProgress, force = false) {
    const tiles = tilesFor(bbox);
    const data = new Array(tiles.length);
    const todo = [];
    for (let i = 0; i < tiles.length; i++) {
      const d = force ? null : await Store.get(tiles[i].key);
      if (d) data[i] = d; else todo.push(i);
    }
    let done = tiles.length - todo.length, failed = 0;
    const report = () => onProgress?.(`Downloading roads: ${done} of ${tiles.length} tiles` + (failed ? `, ${failed} failed` : ""));
    report();

    let next = 0;
    async function lane() {
      while (next < todo.length) {
        const i = todo[next++];
        try {
          data[i] = await fetchTile(tiles[i]);
          await Store.set(tiles[i].key, data[i]);
          done++;
        } catch (err) {
          failed++;
          console.error("Tile gave up:", tiles[i].key, err);
        }
        report();
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, lane));

    if (failed) {
      throw new Error(`${failed} of ${tiles.length} road tiles couldn't be downloaded; the OpenStreetMap servers are busy. ` +
        (done ? `The other ${done} are saved, so ` : "") + `${done ? "click" : "Click"} Get roads again in a minute to fetch the missing ones.`);
    }
    return merge(data, tiles);
  }

  window.Osm = { fetchRoads, cached, tilesFor };
})();
