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
      if (ed.newM < 15) continue; // same minimum as the solver
      if (pointInRing(ed.coords[ed.coords.length >> 1], area)) m += ed.newM;
    }
    return m;
  }

  // ---------- goal: everything in the area / max ride distance / new-miles target ----------
  const num = id => { const v = parseFloat($(id).value); return v > 0 ? v : 0; };
  function goalSpec() {
    const g = $("goal").value;
    if (g === "distance") return num("budget") ? { type: "distance", distanceM: num("budget") * 1609.344 } : null;
    if (g === "newmiles") return num("target-new") ? { type: "newmiles", newM: num("target-new") * 1609.344,
                                                       capM: num("target-cap") * 1609.344 } : null;
    return { type: "all" };
  }
  function canBuild() {
    const g = goalSpec();
    return !!(network && start && g && (g.type !== "all" || area));
  }
  function showGoalFields() {
    const g = $("goal").value;
    $("goal-distance").hidden = g !== "distance";
    $("goal-newmiles").hidden = g !== "newmiles";
  }

  function refresh() {
    const optional = $("goal").value !== "all";
    $("area-label").textContent = area ? `${fmtMi(areaNewMiles())} new mi inside` : optional ? "Optional" : "Not drawn";
    $("draw-shape").textContent = area ? "Redraw" : "Draw";
    $("clear-area").disabled = !area;
    $("build-route").disabled = !canBuild();
  }

  // ---------- solve + optimize ----------
  // Smooth riding: how much distance a smoother ride is worth (see solver.worker.js and help.html#smooth)
  const STYLES = {
    off:    { repeat: 0,   turn: 0,  uturn: 0 },    // shortest distance
    some:   { repeat: 0,   turn: 30, uturn: 400 },  // loop instead of a U-turn if it adds < 400 m
    strong: { repeat: 0.2, turn: 60, uturn: 900 },  // loop instead of a U-turn if it adds < 900 m
  };
  let optimizing = false, firstTotal = null, firstNew = null;

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
          const r = d.result;
          const saved = (firstTotal - r.totalM) * M2MI, gained = (r.newM - firstNew) * M2MI;
          const tried = (r.selTries ? `${r.selTries} road selections and ` : "") + `${r.routeTries ?? r.tries} routes`;
          const parts = [];
          if (gained > 0.05) parts.push(`${gained.toFixed(1)} more new mi`);
          if (saved > 0.05) parts.push(`${saved.toFixed(1)} mi shorter`);
          else if (saved < -0.05 && gained > 0.05) parts.push(`${(-saved).toFixed(1)} mi longer`);
          say(`Optimized: tried ${tried}. ` + (parts.length ? parts.join(", ") + " than the first pass." :
            r.selTries ? "No better selection of roads or route was found." : "No better route was found for these roads."));
        }
      }
    }
  }

  function setBusy(b, opt = false) {
    optimizing = b && opt;
    $("build-route").disabled = b || !canBuild();
    $("optimize-route").textContent = optimizing ? "Stop" : "Optimize";
    $("optimize-route").disabled = b && !opt;
    $("repeat-penalty").disabled = b;
    $("skip-unpaved").disabled = b;
  }

  function build() {
    if (!canBuild()) return;
    cancelMode(); clearRoute();
    setBusy(true);
    say("Building route...");
    worker.onmessage = onWorker;
    worker.postMessage({ type: "solve", start, ring: area, goal: goalSpec(),
                         style: { ...(STYLES[$("repeat-penalty").value] || STYLES.some), skipUnpaved: $("skip-unpaved").checked } });
  }

  function optimize() {
    if (optimizing) { worker.postMessage({ type: "stop" }); return; }
    if (!route) return;
    stopPlay();
    firstTotal = firstTotal ?? route.totalM;
    firstNew = firstNew ?? route.newM;
    setBusy(true, true);
    say("Optimizing...");
    worker.onmessage = onWorker;
    worker.postMessage({ type: "optimize", seconds: Number($("optimize-secs").value) || 20 });
  }

  let skippedLayer = null;
  function showRoute(r, keepView) {
    if (!route) { firstTotal = r.totalM; firstNew = r.newM; }
    route = r;
    if (skippedLayer) { map.removeLayer(skippedLayer); skippedLayer = null; }
    if (r.skipped && r.skipped.length) {
      // fade the red roads the budget left out
      skippedLayer = L.layerGroup(r.skipped.map(c => L.polyline(c.map(([x, y]) => [y, x]),
        { color: "#ffffff", weight: 6, opacity: 0.6, interactive: false }))).addTo(map);
    }
    if (routeLine) routeLine.setLatLngs(r.coords.map(([x, y]) => [y, x]));
    else routeLine = L.polyline(r.coords.map(([x, y]) => [y, x]), { color: ROUTE, weight: 3.5, opacity: 0.9 }).addTo(map);
    if (!keepView) map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
    $("route-result").hidden = false;
    $("route-total").textContent = fmtMi(r.totalM);
    $("route-new").textContent = `${fmtMi(r.newM)} mi`;
    $("route-eff").textContent = `${Math.round(100 * r.newM / r.totalM)}%`;
    $("route-repeat").textContent = `${fmtMi(r.repeatM)} mi`;
    $("route-uturns").textContent = r.uturns ?? "-";
    $("route-turns").textContent = r.turns ?? "-";
    $("route-time").textContent = `${(r.ms / 1000).toFixed(1)} s`;
    stopPlay();
    if (!keepView) $("route-result").scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const notes = [];
    const g = r.goal || {}, where = r.hasArea ? "in the area" : "within reach";
    const faded = r.skipped && r.skipped.length ? " Faded red roads were left out." : "";
    if (g.type === "distance") {
      notes.push(`Fits your ${fmtMi(g.distanceM)} mi ride: ${fmtMi(r.newM)} new mi collected, of ${fmtMi(r.areaNewM)} ${where}.${faded}`);
    } else if (g.type === "newmiles") {
      if (g.met) notes.push(`Shortest loop found with ${fmtMi(g.newM)}+ new mi: collects ${fmtMi(r.newM)} new mi.${faded}`);
      else if (g.capM) notes.push(`Couldn't reach ${fmtMi(g.newM)} new mi within ${fmtMi(g.capM)} mi. Best within that: ${fmtMi(r.newM)} new mi.${faded}`);
      else notes.push(`Only ${fmtMi(r.areaNewM)} new mi ${where}, short of ${fmtMi(g.newM)}. This loop collects all of it.`);
    }
    if (r.unpavedSkippedM >= 16) notes.push(`${fmtMi(r.unpavedSkippedM)} mi of unpaved new road ${where} was skipped.`);
    if (r.dropped) notes.push(`${r.dropped} new road piece${r.dropped > 1 ? "s" : ""} can't be reached legally from this start and ${r.dropped > 1 ? "were" : "was"} skipped.`);
    if (r.wrongWay) notes.push(`Warning: ${r.wrongWay} wrong-way segment${r.wrongWay > 1 ? "s" : ""}.`);
    if (!optimizing) say(notes.join(" "));
  }

  function clearRoute() {
    stopPlay();
    if (optimizing && worker) worker.postMessage({ type: "stop" });
    firstTotal = null; firstNew = null;
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (skippedLayer) { map.removeLayer(skippedLayer); skippedLayer = null; }
    route = null; $("route-result").hidden = true;
  }

  // ---------- play + GPX ----------
  /* ---- route player: play / pause, scrub slider, speed ----
   * P holds the route's points with cumulative distance so the dot moves at a steady pace. */
  let playTrail = null, playRaf = null, P = null;
  const SLIDER_MAX = 1000;

  function playerData() {
    if (P && P.route === route) return P;
    const pts = route.coords.map(([x, y]) => L.latLng(y, x));
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i - 1].distanceTo(pts[i]));
    return (P = { route, pts, cum, total: cum.at(-1) || 1, pos: 0 });
  }
  /** index of the segment containing distance d (binary search) */
  function segAt(d) {
    const c = P.cum; let lo = 0, hi = c.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= d) lo = m; else hi = m - 1; }
    return lo;
  }
  function renderAt(d) {
    P.pos = Math.max(0, Math.min(P.total, d));
    const i = segAt(P.pos), a = P.pts[i], b = P.pts[Math.min(i + 1, P.pts.length - 1)];
    const f = (P.pos - P.cum[i]) / ((P.cum[i + 1] - P.cum[i]) || 1);
    const here = L.latLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f);
    if (!playTrail) playTrail = L.polyline([], { color: "#0b2e66", weight: 5, opacity: 0.85, interactive: false }).addTo(map);
    if (!playDot) playDot = L.circleMarker(here, { radius: 7, color: "#fff", weight: 2, fillColor: ROUTE, fillOpacity: 1, interactive: false }).addTo(map);
    // grow the trail while moving forward; rebuild only after a jump backwards
    const ll = playTrail.getLatLngs();
    if (P.ti !== undefined && i >= P.ti && ll.length) {
      ll.pop();
      for (let k = P.ti + 1; k <= i; k++) ll.push(P.pts[k]);
      ll.push(here);
      playTrail.setLatLngs(ll);
    } else playTrail.setLatLngs(P.pts.slice(0, i + 1).concat([here]));
    P.ti = i;
    playDot.setLatLng(here);
    $("play-pos").value = Math.round(P.pos / P.total * SLIDER_MAX);
    $("play-mi").textContent = `${fmtMi(P.pos)} of ${fmtMi(P.total)} mi`;
  }
  function pausePlay() {
    if (playRaf) { cancelAnimationFrame(playRaf); playRaf = null; }
    playTimer = null;
    $("play-route").textContent = "Play";
  }
  /** pause and remove the dot and trail (new route, cleared route, optimizing) */
  function stopPlay() {
    pausePlay();
    if (playDot) { map.removeLayer(playDot); playDot = null; }
    if (playTrail) { map.removeLayer(playTrail); playTrail = null; }
    P = null;
    $("play-pos").value = 0;
    $("play-mi").textContent = route ? `0.0 of ${fmtMi(route.totalM)} mi` : "";
  }
  function play() {
    if (!route) return;
    if (playTimer) { pausePlay(); return; }
    playerData();
    if (P.pos >= P.total - 1) P.pos = 0; // at the end: start over
    renderAt(P.pos);
    $("play-route").textContent = "Pause";
    playTimer = true;
    let last = performance.now();
    const frame = now => {
      if (!playTimer) return;
      const speed = Number($("play-speed").value) || 1;      // 1x = whole route in 40 s
      const next = P.pos + (now - last) / 40000 * P.total * speed; last = now;
      if (next >= P.total) { renderAt(P.total); pausePlay(); return; }
      renderAt(next);
      playRaf = requestAnimationFrame(frame);
    };
    playRaf = requestAnimationFrame(frame);
  }
  function seek() {
    if (!route) return;
    playerData();
    renderAt(Number($("play-pos").value) / SLIDER_MAX * P.total); // keeps playing if it was
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
      $("play-pos").addEventListener("input", seek);
      $("download-gpx").addEventListener("click", gpx);
      $("optimize-route").addEventListener("click", optimize);
      Store.get("penalty").then(v => { if (v && STYLES[v]) $("repeat-penalty").value = v; });
      $("repeat-penalty").addEventListener("change", e => { Store.set("penalty", e.target.value); clearRoute(); say(""); });
      Store.get("skip-unpaved").then(v => { if (v === "0") $("skip-unpaved").checked = false; });
      $("skip-unpaved").addEventListener("change", e => { Store.set("skip-unpaved", e.target.checked ? "1" : "0"); clearRoute(); say(""); });
      // goal and its numbers are remembered; an older saved max distance becomes the distance goal
      Promise.all(["goal", "budget", "target-new", "target-cap"].map(k => Store.get(k))).then(([g, b, tn, tc]) => {
        if (b) $("budget").value = b;
        if (tn) $("target-new").value = tn;
        if (tc) $("target-cap").value = tc;
        $("goal").value = g || (b ? "distance" : "all");
        showGoalFields(); refresh();
      });
      $("goal").addEventListener("change", e => { Store.set("goal", e.target.value); showGoalFields(); clearRoute(); refresh(); say(""); });
      for (const id of ["budget", "target-new", "target-cap"]) {
        const el = $(id);
        el.addEventListener("input", refresh);
        el.addEventListener("change", () => {
          if (!(parseFloat(el.value) > 0)) el.value = "";
          Store.set(id, el.value); clearRoute(); refresh(); say("");
        });
      }
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
