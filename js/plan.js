/* Plan a ride: pick a start, draw an area, build and show the route. */
(function () {
  const $ = id => document.getElementById(id);
  const M2MI = 1 / 1609.344;
  const ROUTE = getComputedStyle(document.documentElement).getPropertyValue("--route").trim() || "#1d5fd1";

  let map, network = null, worker = null, start = null, area = null, route = null;
  let startMarker = null, areaRect = null, routeLine = null, playDot = null, playTimer = null, mode = null;

  function say(text, isError) { $("plan-msg").textContent = text || ""; $("plan-msg").classList.toggle("error", !!isError); }
  const fmtMi = m => (m * M2MI).toFixed(1);

  // ---------- start point ----------
  function setStart(latlng, save = true) {
    start = [latlng.lng, latlng.lat];
    if (!startMarker) {
      startMarker = L.marker(latlng, { draggable: true, title: "Start", keyboard: true,
        icon: L.divIcon({ className: "start-pin", html: "<span>S</span>", iconSize: [28, 28], iconAnchor: [14, 14] }) })
        .addTo(map).on("dragend", e => setStart(e.target.getLatLng()));
    } else startMarker.setLatLng(latlng);
    $("start-label").textContent = `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
    $("set-start").textContent = "Move start";
    if (save) Store.set("start", start);
    clearRoute(); refresh();
  }

  function pickStart() {
    cancelMode();
    mode = "start"; map.getContainer().classList.add("picking");
    say("Click the map where your ride starts.");
    map.once("click", e => { cancelMode(); setStart(e.latlng); say(""); });
  }

  // ---------- area: a polygon ring [[lon,lat], ...] (a box is just 4 corners) ----------
  const AREA_STYLE = { color: "#12573a", weight: 2, fillOpacity: 0.06, dashArray: "6 4", interactive: false };
  const toLatLngs = ring => ring.map(([x, y]) => [y, x]);

  function setArea(ring, save = true) {
    area = ring;
    if (!areaRect) areaRect = L.polygon(toLatLngs(ring), AREA_STYLE).addTo(map);
    else areaRect.setLatLngs(toLatLngs(ring));
    if (save) Store.set("area", area);
    clearRoute(); refresh();
    drawHandles();
  }

  /* Corner handles: drag a corner to move it, drag a small midpoint handle to
   * add a corner there, right-click or double-click a corner to delete it. */
  let handles = null;
  const handleIcon = (cls) => {
    const z = cls === "mid" ? 11 : 16; // Leaflet positions markers with transform, so size via the icon
    return L.divIcon({ className: "area-handle " + cls, iconSize: [z, z], iconAnchor: [z / 2, z / 2] });
  };
  function drawHandles() {
    if (handles) { map.removeLayer(handles); handles = null; }
    if (!area) return;
    handles = L.layerGroup().addTo(map);
    const live = () => area.map(([x, y]) => L.latLng(y, x));
    area.forEach(([x, y], i) => {
      const m = L.marker([y, x], { draggable: true, icon: handleIcon("corner"), keyboard: false,
        title: "Drag to move. Right-click or double-click to delete." }).addTo(handles);
      m.on("drag", e => { const ll = live(); ll[i] = e.target.getLatLng(); areaRect.setLatLngs(ll); });
      m.on("dragend", e => { const p = e.target.getLatLng(); const r = area.slice(); r[i] = [p.lng, p.lat]; setArea(r); });
      const del = e => {
        L.DomEvent.stop(e);
        if (area.length <= 3) { say("A shape needs at least 3 corners.", true); return; }
        setArea(area.filter((_, j) => j !== i)); say("");
      };
      m.on("contextmenu", del); m.on("dblclick", del);
    });
    area.forEach(([x1, y1], i) => {
      const [x2, y2] = area[(i + 1) % area.length];
      const m = L.marker([(y1 + y2) / 2, (x1 + x2) / 2], { draggable: true, icon: handleIcon("mid"), keyboard: false,
        title: "Drag to add a corner" }).addTo(handles);
      m.on("drag", e => { const ll = live(); ll.splice(i + 1, 0, e.target.getLatLng()); areaRect.setLatLngs(ll); });
      m.on("dragend", e => { const p = e.target.getLatLng(); const r = area.slice(); r.splice(i + 1, 0, [p.lng, p.lat]); setArea(r); });
    });
  }

  function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function clearArea() {
    cancelMode();
    if (areaRect) { map.removeLayer(areaRect); areaRect = null; }
    area = null; drawHandles();
    Store.del("area");
    clearRoute(); refresh(); say("");
  }

  /* Shape: click (or tap) corners; click the first corner, double-click, or press
   * Enter to finish. Backspace removes the last corner, Esc cancels. */
  function drawShape() {
    cancelMode();
    mode = "shape";
    if (handles) { map.removeLayer(handles); handles = null; }
    const el = map.getContainer();
    el.classList.add("picking");
    map.doubleClickZoom.disable();
    const pts = [];
    const line = L.polyline([], { color: "#12573a", weight: 2, interactive: false }).addTo(map);
    const rubber = L.polyline([], { color: "#12573a", weight: 2, dashArray: "4 4", interactive: false }).addTo(map);
    const dots = L.layerGroup().addTo(map);
    const hint = () => {
      say(pts.length < 3
        ? `Click around the area to add corners (${pts.length} so far). Right-click or Ctrl+Z undoes one, Esc cancels.`
        : "Click the first corner, double-click, or press Enter to finish. Right-click or Ctrl+Z undoes a corner.");
      $("undo-corner").disabled = !pts.length;
      $("finish-shape").disabled = pts.length < 3;
    };
    const redraw = () => {
      line.setLatLngs(pts);
      dots.clearLayers();
      pts.forEach((p, i) => L.circleMarker(p, { radius: i === 0 ? 7 : 4, color: "#12573a", weight: 2,
        fillColor: i === 0 ? "#f2b705" : "#fff", fillOpacity: 1, interactive: false }).addTo(dots));
      hint();
    };
    const nearFirst = latlng => pts.length >= 3 &&
      map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(pts[0])) < 14;
    const finish = () => {
      if (pts.length < 3) { say("A shape needs at least 3 corners.", true); return; }
      const ring = pts.map(p => [p.lng, p.lat]);
      cleanup(); setArea(ring); say("");
    };
    const nearLast = latlng => pts.length &&
      map.latLngToContainerPoint(latlng).distanceTo(map.latLngToContainerPoint(pts.at(-1))) < 6;
    const onClick = e => {
      if (nearFirst(e.latlng)) { finish(); return; }
      if (nearLast(e.latlng)) return; // second click of a double-click
      pts.push(e.latlng); redraw();
    };
    const onDbl = e => { L.DomEvent.stop(e); finish(); };
    const onMove = e => { rubber.setLatLngs(pts.length ? [pts.at(-1), e.latlng] : []); };
    const undo = () => { if (pts.length) { pts.pop(); redraw(); rubber.setLatLngs([]); } };
    const onKey = e => {
      if (e.key === "Enter") { e.preventDefault(); finish(); }
      else if (e.key === "Backspace" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")) { e.preventDefault(); undo(); }
    };
    const onRight = e => { L.DomEvent.preventDefault(e.originalEvent); undo(); };
    function cleanup() {
      if (!handles) setTimeout(drawHandles, 0); // bring corner handles back if the shape wasn't replaced
      map.off("click", onClick); map.off("dblclick", onDbl); map.off("mousemove", onMove); map.off("contextmenu", onRight);
      document.removeEventListener("keydown", onKey);
      $("shape-tools").hidden = true;
      $("undo-corner").onclick = $("finish-shape").onclick = null;
      [line, rubber, dots].forEach(l => map.removeLayer(l));
      map.doubleClickZoom.enable(); el.classList.remove("picking"); mode = null; cancelMode.fn = null;
    }
    map.on("click", onClick); map.on("dblclick", onDbl); map.on("mousemove", onMove); map.on("contextmenu", onRight);
    document.addEventListener("keydown", onKey);
    $("shape-tools").hidden = false;
    $("undo-corner").onclick = undo;
    $("finish-shape").onclick = finish;
    cancelMode.fn = cleanup;
    hint();
  }

  function cancelMode() {
    if (cancelMode.fn) cancelMode.fn();
    if (mode === "start") map.off("click");
    map.getContainer().classList.remove("picking");
    mode = null;
  }

  function areaNewMiles() {
    if (!network || !area) return 0;
    let m = 0;
    for (const ed of network.edges) {
      if (ed.newM < 5) continue;
      if (pointInRing(ed.coords[ed.coords.length >> 1], area)) m += ed.newM;
    }
    return m;
  }

  function refresh() {
    $("area-label").textContent = area ? `${fmtMi(areaNewMiles())} new mi inside` : "Not drawn";
    $("draw-shape").textContent = area ? "Redraw" : "Draw";
    $("clear-area").disabled = !area;
    $("build-route").disabled = !(network && start && area);
  }

  // ---------- solve + optimize ----------
  const PENALTY = { off: 0, some: 0.5, strong: 1.5 };
  let optimizing = false, firstTotal = null;

  function onWorker(e) {
    const d = e.data;
    if (d.progress) { say(d.progress); return; }
    if (d.error) { setBusy(false); say(d.error, true); return; }
    if (d.result) {
      const keepView = !!route; // improvements redraw in place without re-zooming
      showRoute(d.result, keepView);
      if (d.final) {
        setBusy(false);
        if (d.optimized) {
          const saved = (firstTotal - d.result.totalM) * M2MI;
          say(`Optimized: ${d.result.tries} tries. ` + (saved > 0.05 ? `${saved.toFixed(1)} mi shorter than the first pass.` :
            "The first pass was already the best found."));
        }
      }
    }
  }

  function setBusy(b, opt = false) {
    optimizing = b && opt;
    $("build-route").disabled = b || !(network && start && area);
    $("optimize-route").textContent = optimizing ? "Stop" : "Optimize";
    $("optimize-route").disabled = b && !opt;
    $("repeat-penalty").disabled = b;
  }

  function build() {
    if (!(network && start && area)) return;
    cancelMode(); clearRoute();
    setBusy(true);
    say("Building route...");
    worker.onmessage = onWorker;
    worker.postMessage({ type: "solve", start, ring: area, penalty: PENALTY[$("repeat-penalty").value] ?? 0.5 });
  }

  function optimize() {
    if (optimizing) { worker.postMessage({ type: "stop" }); return; }
    if (!route) return;
    stopPlay();
    firstTotal = firstTotal ?? route.totalM;
    setBusy(true, true);
    say("Optimizing...");
    worker.onmessage = onWorker;
    worker.postMessage({ type: "optimize", seconds: Number($("optimize-secs").value) || 20 });
  }

  function showRoute(r, keepView) {
    if (!route) firstTotal = r.totalM;
    route = r;
    if (routeLine) routeLine.setLatLngs(r.coords.map(([x, y]) => [y, x]));
    else routeLine = L.polyline(r.coords.map(([x, y]) => [y, x]), { color: ROUTE, weight: 3.5, opacity: 0.9 }).addTo(map);
    if (!keepView) map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
    $("route-result").hidden = false;
    $("route-total").textContent = fmtMi(r.totalM);
    $("route-new").textContent = `${fmtMi(r.newM)} mi`;
    $("route-eff").textContent = `${Math.round(100 * r.newM / r.totalM)}%`;
    $("route-repeat").textContent = `${fmtMi(r.repeatM)} mi`;
    $("route-time").textContent = `${(r.ms / 1000).toFixed(1)} s`;
    if (!keepView) $("route-result").scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const notes = [];
    if (r.dropped) notes.push(`${r.dropped} new road piece${r.dropped > 1 ? "s" : ""} can't be reached legally from this start and ${r.dropped > 1 ? "were" : "was"} skipped.`);
    if (r.wrongWay) notes.push(`Warning: ${r.wrongWay} wrong-way segment${r.wrongWay > 1 ? "s" : ""}.`);
    if (!optimizing) say(notes.join(" "));
  }

  function clearRoute() {
    stopPlay();
    if (optimizing && worker) worker.postMessage({ type: "stop" });
    firstTotal = null;
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    route = null; $("route-result").hidden = true;
  }

  // ---------- play + GPX ----------
  let playTrail = null, playRaf = null;
  function stopPlay() {
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = null; }
    playTimer = null;
    if (playDot) { map.removeLayer(playDot); playDot = null; }
    if (playTrail) { map.removeLayer(playTrail); playTrail = null; }
    $("play-route").textContent = "Play route";
  }
  function play() {
    if (!route) return;
    if (playTimer) { stopPlay(); return; }
    const pts = route.coords.map(([x, y]) => L.latLng(y, x));
    // cumulative distance so the dot moves at a steady pace
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    const total = cum.at(-1) || 1;
    playTrail = L.polyline([pts[0]], { color: "#0b2e66", weight: 5, opacity: 0.85, interactive: false }).addTo(map);
    playDot = L.circleMarker(pts[0], { radius: 7, color: "#fff", weight: 2, fillColor: ROUTE, fillOpacity: 1, interactive: false }).addTo(map);
    $("play-route").textContent = "Stop";
    let pos = 0, idx = 0, last = performance.now();
    playTimer = true;
    const frame = now => {
      if (!playTimer) return;
      const speed = Number($("play-speed").value) || 1;      // 1x = whole route in 20 s
      pos += (now - last) / 20000 * total * speed; last = now;
      if (pos >= total) { stopPlay(); return; }
      while (idx < pts.length - 2 && cum[idx + 1] < pos) { idx++; playTrail.addLatLng(pts[idx]); }
      const f = (pos - cum[idx]) / ((cum[idx + 1] - cum[idx]) || 1);
      const a = pts[idx], b = pts[idx + 1];
      playDot.setLatLng([a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f]);
      playRaf = requestAnimationFrame(frame);
    };
    playRaf = requestAnimationFrame(frame);
  }
  function gpx() {
    if (!route) return;
    const d = new Date().toISOString().slice(0, 10);
    Gpx.download(route.coords, `Wandrer route ${d} ${fmtMi(route.totalM)} mi`);
  }

  // ---------- wiring ----------
  window.Plan = {
    init(m) {
      map = m;
      $("set-start").addEventListener("click", pickStart);
      $("draw-shape").addEventListener("click", drawShape);
      $("clear-area").addEventListener("click", clearArea);
      $("build-route").addEventListener("click", build);
      $("play-route").addEventListener("click", play);
      $("download-gpx").addEventListener("click", gpx);
      $("optimize-route").addEventListener("click", optimize);
      Store.get("penalty").then(v => { if (v && PENALTY[v] !== undefined) $("repeat-penalty").value = v; });
      $("repeat-penalty").addEventListener("change", e => { Store.set("penalty", e.target.value); clearRoute(); say(""); });
      document.addEventListener("keydown", e => { if (e.key === "Escape" && mode) { cancelMode(); say(""); } });
      Store.get("start").then(s => { if (s) setStart(L.latLng(s[1], s[0]), false); });
      Store.get("area").then(a => {
        if (!a) return;
        // older versions saved a box as [w, s, e, n]
        if (typeof a[0] === "number") { const [w, s, e, n] = a; a = [[w, s], [e, s], [e, n], [w, n]]; }
        setArea(a, false);
      });
    },
    setNetwork(net) {
      network = net;
      if (worker) worker.terminate();
      worker = new Worker("js/solver.worker.js?v=" + (window.APP_VERSION || "0"));
      worker.postMessage({ type: "network", nodes: net.nodes, edges: net.edges });
      $("step-plan").hidden = false;
      clearRoute(); refresh();
    },
    reset() {
      network = null; clearRoute(); refresh();
      $("step-plan").hidden = true;
    },
  };
})();
