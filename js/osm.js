/* Fetch rideable OSM roads for a bounding box from the Overpass API. */
(function () {
  const SERVERS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  const BUFFER_DEG = 0.015; // ~1.5 km around the KMZ so loops can leave and come back

  function query([w, s, e, n]) {
    const bb = `${s},${w},${n},${e}`;
    return `[out:json][timeout:180];
(
  way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|cycleway|path|track|busway)$"](${bb});
  way["highway"~"^(footway|pedestrian|bridleway)$"]["bicycle"~"^(yes|designated|permissive)$"](${bb});
);
out body geom qt;`;
  }

  function padded(bbox) {
    const [w, s, e, n] = bbox;
    return [w - BUFFER_DEG, s - BUFFER_DEG, e + BUFFER_DEG, n + BUFFER_DEG].map(v => +v.toFixed(4));
  }

  async function fetchRoads(bbox, onProgress) {
    const box = padded(bbox);
    const body = "data=" + encodeURIComponent(query(box));
    let lastErr;
    for (const url of SERVERS) {
      try {
        onProgress?.(`Downloading roads from ${new URL(url).host}...`);
        const res = await fetch(url, { method: "POST", body,
          headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
        // stream so we can show download progress for big areas
        const reader = res.body.getReader(); const chunks = []; let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); got += value.length;
          onProgress?.(`Downloading roads... ${(got / 1e6).toFixed(1)} MB`);
        }
        const text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
        const json = JSON.parse(text);
        if (json.remark && !json.elements?.length) throw new Error(json.remark);
        return { box, elements: json.elements, fetchedAt: new Date().toISOString(), server: new URL(url).host };
      } catch (err) {
        console.warn("Overpass failed:", url, err);
        lastErr = err;
      }
    }
    throw new Error("Couldn't download roads from OpenStreetMap. " + (lastErr?.message || "") + " Try again in a minute.");
  }

  window.Osm = { fetchRoads, padded };
})();
