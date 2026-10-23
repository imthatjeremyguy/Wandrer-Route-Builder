/* Parse a Wandrer KMZ/KML export into untraveled road lines.
 * Returns { lines: [[[lon,lat], ...], ...], miles, pieces, exportedAt, bbox }
 */
(function () {
  const R_MI = 3958.8;

  function haversineMi(a, b) {
    const toRad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * toRad, dLon = (b[0] - a[0]) * toRad;
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_MI * Math.asin(Math.sqrt(h));
  }

  async function readKmlText(file) {
    if (/\.kml$/i.test(file.name)) return await file.text();
    const zip = await JSZip.loadAsync(file);
    const kmlName = Object.keys(zip.files).find(n => /\.kml$/i.test(n));
    if (!kmlName) throw new Error("This KMZ has no KML file inside. Re-download it from Wandrer as KML/KMZ.");
    return await zip.file(kmlName).async("string");
  }

  function parseKml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("The KML inside this file could not be read.");

    // Untraveled styles only (Wandrer: #Untraveled, #UntraveledUnpaved). Skip boundaries and traveled.
    const lines = [];
    const seen = new Set();
    let miles = 0;
    for (const pm of doc.getElementsByTagName("Placemark")) {
      const style = (pm.getElementsByTagName("styleUrl")[0]?.textContent || "").trim();
      if (!/^#Untraveled/i.test(style)) continue;
      const unpaved = /Unpaved/i.test(style);
      for (const ls of pm.getElementsByTagName("LineString")) {
        const raw = ls.getElementsByTagName("coordinates")[0]?.textContent.trim() || "";
        const pts = raw.split(/\s+/).map(p => p.split(",").slice(0, 2).map(Number))
          .filter(p => p.length === 2 && p.every(Number.isFinite));
        if (pts.length < 2) continue;
        // Count each sub-segment once; Wandrer repeats some pieces across MultiGeometry parts.
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i].map(v => v.toFixed(6)).join(","), b = pts[i + 1].map(v => v.toFixed(6)).join(",");
          if (a === b) continue;
          const key = a < b ? a + "|" + b : b + "|" + a;
          if (seen.has(key)) continue;
          seen.add(key);
          miles += haversineMi(pts[i], pts[i + 1]);
        }
        lines.push({ coords: pts, unpaved });
      }
    }
    if (!lines.length) throw new Error("No untraveled roads found. Make sure you exported the Bike map as KML/KMZ.");

    let bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const l of lines) for (const [x, y] of l.coords) {
      bbox = [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)];
    }
    const name = doc.getElementsByTagName("name")[0]?.textContent || "";
    const m = name.match(/(\d{4})(\d{2})(\d{2})/);
    const exportedAt = m ? `${m[1]}-${m[2]}-${m[3]}` : null;

    return { lines, miles, pieces: seen.size, exportedAt, bbox };
  }

  window.WandrerKmz = {
    async load(file) { return parseKml(await readKmlText(file)); },
    parseKml,
    haversineMi,
  };
})();
