/* Milestone 1: load a Wandrer KMZ, draw untraveled roads, show mileage. */
(function () {
  const $ = id => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const UNTRAVELED = css.getPropertyValue("--untraveled").trim() || "#e0362c";

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true }).setView([39.7684, -86.1581], 11); // Indianapolis
  // Standard OSM tiles (no key needed); shown in grayscale via CSS so Wandrer red stands out
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    className: "base-tiles",
  }).addTo(map);
  let untraveledLayer = null;

  function drawUntraveled(data) {
    if (untraveledLayer) map.removeLayer(untraveledLayer);
    untraveledLayer = L.layerGroup(data.lines.map(l =>
      L.polyline(l.coords.map(([x, y]) => [y, x]), {
        color: UNTRAVELED, weight: 3.5, opacity: 0.9,
        dashArray: l.unpaved ? "6 6" : null,
      })
    )).addTo(map);
    const [w, s, e, n] = data.bbox;
    map.fitBounds([[s, w], [n, e]], { padding: [24, 24] });
  }

  // ---------- panel ----------
  function showStats(data) {
    $("empty-state").hidden = true;
    $("loaded-state").hidden = false;
    $("stat-miles").textContent = data.miles.toFixed(2);
    $("stat-pieces").textContent = data.pieces.toLocaleString();
    $("stat-date").textContent = data.exportedAt
      ? new Date(data.exportedAt + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
      : "Unknown";
  }

  function say(text, isError) {
    $("msg").textContent = text || "";
    $("msg").classList.toggle("error", !!isError);
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(kmz|kml)$/i.test(file.name)) {
      say("That file isn't a KMZ or KML. Export the Bike map from Wandrer as KML/KMZ.", true);
      return;
    }
    say("Reading " + file.name + "...");
    try {
      const data = await WandrerKmz.load(file);
      drawUntraveled(data);
      showStats(data);
      say("Loaded " + file.name + ".");
      await Store.set("wandrer", data);
    } catch (err) {
      console.error(err);
      say(err.message || "Couldn't read that file.", true);
    }
  }

  $("kmz-input").addEventListener("change", e => {
    handleFile(e.target.files[0]);
    e.target.value = "";
  });

  // drag and drop anywhere on the page
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("drop-hint").hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; $("drop-hint").hidden = true;
    handleFile(e.dataTransfer.files[0]);
  });

  // restore the last KMZ from this browser
  Store.get("wandrer").then(data => {
    if (data?.lines?.length) { drawUntraveled(data); showStats(data); }
  });
})();
