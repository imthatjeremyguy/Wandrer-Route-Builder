/* Wandrer Route Builder: page wiring.
 * Milestone 1: load a Wandrer KMZ, draw untraveled roads.
 * Milestone 2: fetch OSM roads, build the tagged network in a worker. */
(function () {
  const $ = id => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const UNTRAVELED = css.getPropertyValue("--untraveled").trim() || "#e0362c";
  const M2MI = 1 / 1609.344;
  const V = window.APP_VERSION || "0";

  let wandrer = null;   // parsed KMZ
  let network = null;   // built graph

  // ---------- map ----------
  const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView([39.7684, -86.1581], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    className: "base-tiles",
  }).addTo(map);
  const layers = { untraveled: null, connectors: null, newRoads: null };
  const clear = name => { if (layers[name]) { map.removeLayer(layers[name]); layers[name] = null; } };
  const ll = coords => coords.map(([x, y]) => [y, x]);

  function drawUntraveled(data) {
    clear("untraveled");
    layers.untraveled = L.layerGroup(data.lines.map(l =>
      L.polyline(ll(l.coords), { color: UNTRAVELED, weight: 3.5, opacity: 0.9, dashArray: l.unpaved ? "6 6" : null })
    )).addTo(map);
    const [w, s, e, n] = data.bbox;
    map.fitBounds([[s, w], [n, e]], { padding: [24, 24] });
  }

  function drawNetwork(net) {
    clear("untraveled"); clear("connectors"); clear("newRoads");
    const conn = [], fresh = [];
    for (const e of net.edges) (e.newM / e.len > 0.05 ? fresh : conn).push(e);
    layers.connectors = L.layerGroup(conn.map(e =>
      L.polyline(ll(e.coords), { color: "#5b6670", weight: 1.5, opacity: 0.55, interactive: false })));
    if ($("show-connectors").checked) layers.connectors.addTo(map);
    layers.newRoads = L.layerGroup(fresh.map(e => {
      const full = e.newM / e.len > 0.9;
      return L.polyline(ll(e.coords), { color: full ? UNTRAVELED : "#f08c00", weight: 4, opacity: 0.95 })
        .bindPopup(`<b>${e.name || "(unnamed)"}</b><br>${e.hw}<br>${(e.len * M2MI).toFixed(2)} mi, ${(e.newM * M2MI).toFixed(2)} new`);
    })).addTo(map);
  }

  // ---------- messages ----------
  function say(el, text, isError) {
    $(el).textContent = text || "";
    $(el).classList.toggle("error", !!isError);
  }

  // ---------- step 1: KMZ ----------
  function showStats(data) {
    $("empty-state").hidden = true;
    $("loaded-state").hidden = false;
    $("step-roads").hidden = false;
    $("stat-miles").textContent = data.miles.toFixed(2);
    $("stat-pieces").textContent = data.pieces.toLocaleString();
    $("stat-date").textContent = data.exportedAt ? fmtDate(data.exportedAt) : "Unknown";
  }
  const fmtDate = d => new Date(d.length === 10 ? d + "T12:00:00" : d)
    .toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(kmz|kml)$/i.test(file.name)) {
      say("msg", "That file isn't a KMZ or KML. Export the Bike map from Wandrer as KML/KMZ.", true);
      return;
    }
    say("msg", "Reading " + file.name + "...");
    try {
      const data = await WandrerKmz.load(file);
      wandrer = data; network = null;
      drawUntraveled(data);
      showStats(data);
      say("msg", "Loaded " + file.name + ".");
      await Store.set("wandrer", data);
      await afterKmz();
    } catch (err) {
      console.error(err);
      say("msg", err.message || "Couldn't read that file.", true);
    }
  }

  // ---------- step 2: roads + network ----------

  async function afterKmz() {
    clear("connectors"); clear("newRoads");
    $("roads-loaded").hidden = true; $("roads-empty").hidden = false;
    const osm = await Osm.cached(wandrer.bbox);
    if (osm) await buildNetwork(osm);
    else say("roads-msg", "");
  }

  async function getRoads(force) {
    if (!wandrer) return;
    setBusy(true);
    try {
      const osm = await Osm.fetchRoads(wandrer.bbox, m => say("roads-msg", m), force);
      await buildNetwork(osm);
    } catch (err) {
      console.error(err);
      say("roads-msg", err.message, true);
    } finally { setBusy(false); }
  }

  function buildNetwork(osm) {
    return new Promise((resolve) => {
      say("roads-msg", "Building road network...");
      const worker = new Worker("js/network.worker.js?v=" + V);
      worker.onmessage = (e) => {
        if (e.data.progress) { say("roads-msg", e.data.progress); return; }
        worker.terminate();
        network = e.data.result;
        network.osmDate = osm.fetchedAt;
        drawNetwork(network);
        showNetStats(network);
        say("roads-msg", "");
        resolve(network);
      };
      worker.onerror = (err) => {
        worker.terminate();
        console.error(err);
        say("roads-msg", "Building the network failed: " + (err.message || "unknown error"), true);
        resolve(null);
      };
      worker.postMessage({ elements: osm.elements, lines: wandrer.lines });
    });
  }

  function showNetStats(net) {
    const s = net.stats;
    $("roads-empty").hidden = true; $("roads-loaded").hidden = false;
    const pct = s.untraveledM ? Math.round(100 * s.newM / s.untraveledM) : 0;
    $("net-new").textContent = `${(s.newM * M2MI).toFixed(2)} mi (${pct}%)`;
    $("net-ride").textContent = `${Math.round(s.rideableM * M2MI).toLocaleString()} mi`;
    $("net-date").textContent = fmtDate(net.osmDate);
    $("net-time").textContent = `${(s.ms / 1000).toFixed(1)} s`;
  }

  function setBusy(b) { $("get-roads").disabled = b; $("refresh-roads").disabled = b; }

  $("get-roads").addEventListener("click", () => getRoads(false));
  $("refresh-roads").addEventListener("click", () => getRoads(true));
  Store.del("osm"); // single-request cache from v2, replaced by tiles
  $("show-connectors").addEventListener("change", e => {
    if (!layers.connectors) return;
    e.target.checked ? layers.connectors.addTo(map) : map.removeLayer(layers.connectors);
  });

  // ---------- file input + drag and drop ----------
  $("kmz-input").addEventListener("change", e => { handleFile(e.target.files[0]); e.target.value = ""; });
  let dragDepth = 0;
  window.addEventListener("dragenter", e => { e.preventDefault(); dragDepth++; $("drop-hint").hidden = false; });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("drop-hint").hidden = true; } });
  window.addEventListener("dragover", e => e.preventDefault());
  window.addEventListener("drop", e => {
    e.preventDefault(); dragDepth = 0; $("drop-hint").hidden = true;
    handleFile(e.dataTransfer.files[0]);
  });

  // ---------- restore from this browser ----------
  Store.get("wandrer").then(async data => {
    if (data?.lines?.length) { wandrer = data; drawUntraveled(data); showStats(data); await afterKmz(); }
  });
})();
