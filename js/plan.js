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
  }

  function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function drawBox() {
    cancelMode();
    mode = "box";
    const el = map.getContainer();
    el.classList.add("picking");
    map.dragging.disable();
    say("Drag a box over the roads you want to collect. Esc cancels.");
    let a = null, tmp = null;
    const ll = e => map.mouseEventToLatLng(e);
    const down = e => { if (e.button > 0) return; a = ll(e); el.setPointerCapture?.(e.pointerId); e.preventDefault(); };
    const move = e => {
      if (!a) return;
      const b = L.latLngBounds(a, ll(e));
      if (!tmp) tmp = L.rectangle(b, { ...AREA_STYLE, dashArray: null, fillOpacity: 0.1 }).addTo(map);
      else tmp.setBounds(b);
    };
    const up = e => {
      if (!a) return;
      const b = L.latLngBounds(a, ll(e));
      cleanup();
      if (map.latLngToContainerPoint(b.getNorthWest()).distanceTo(map.latLngToContainerPoint(b.getSouthEast())) < 12) {
        say("That box was too small. Press Draw box and drag across the roads.", true); return;
      }
      const [w, s, e2, n] = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      setArea([[w, s], [e2, s], [e2, n], [w, n]]); say("");
    };
    function cleanup() {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      if (tmp) map.removeLayer(tmp);
      map.dragging.enable(); el.classList.remove("picking"); mode = null; cancelMode.fn = null;
    }
    el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    cancelMode.fn = cleanup;
  }

  /* Shape: click (or tap) corners; click the first corner, double-click, or press
   * Enter to finish. Backspace removes the last corner, Esc cancels. */
  function drawShape() {
    cancelMode();
    mode = "shape";
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
    $("build-route").disabled = !(network && start && area);
  }

  // ---------- solve ----------
  function build() {
    if (!(network && start && area)) return;
    cancelMode(); clearRoute();
    $("build-route").disabled = true;
    say("Building route...");
    worker.onmessage = e => {
      if (e.data.progress) { say(e.data.progress); return; }
      $("build-route").disabled = false;
      if (e.data.error) { say(e.data.error, true); return; }
      showRoute(e.data.result);
    };
    worker.postMessage({ type: "solve", start, ring: area });
  }

  function showRoute(r) {
    route = r;
    routeLine = L.polyline(r.coords.map(([x, y]) => [y, x]), { color: ROUTE, weight: 3.5, opacity: 0.9 }).addTo(map);
    map.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
    $("route-result").hidden = false;
    $("route-total").textContent = fmtMi(r.totalM);
    $("route-new").textContent = `${fmtMi(r.newM)} mi`;
    $("route-eff").textContent = `${Math.round(100 * r.newM / r.totalM)}%`;
    $("route-extra").textContent = `${fmtMi(r.totalM - r.newM)} mi`;
    $("route-time").textContent = `${(r.ms / 1000).toFixed(1)} s`;
    $("route-result").scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    const notes = [];
    if (r.dropped) notes.push(`${r.dropped} new road piece${r.dropped > 1 ? "s" : ""} can't be reached legally from this start and ${r.dropped > 1 ? "were" : "was"} skipped.`);
    if (r.wrongWay) notes.push(`Warning: ${r.wrongWay} wrong-way segment${r.wrongWay > 1 ? "s" : ""}.`);
    say(notes.join(" "));
  }

  function clearRoute() {
    stopPlay();
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    route = null; $("route-result").hidden = true;
  }

  // ---------- play + GPX ----------
  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    if (playDot) { map.removeLayer(playDot); playDot = null; }
    $("play-route").textContent = "Play route";
  }
  function play() {
    if (!route) return;
    if (playTimer) { stopPlay(); return; }
    const pts = route.coords.map(([x, y]) => [y, x]);
    let i = 0;
    playDot = L.circleMarker(pts[0], { radius: 7, color: "#fff", weight: 2, fillColor: ROUTE, fillOpacity: 1 }).addTo(map);
    const step = Math.max(1, Math.round(pts.length / 900)); // ~20 s for any route length
    $("play-route").textContent = "Stop";
    playTimer = setInterval(() => {
      i += step;
      if (i >= pts.length) { stopPlay(); return; }
      playDot.setLatLng(pts[i]);
    }, 22);
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
      $("draw-box").addEventListener("click", drawBox);
      $("draw-shape").addEventListener("click", drawShape);
      $("build-route").addEventListener("click", build);
      $("play-route").addEventListener("click", play);
      $("download-gpx").addEventListener("click", gpx);
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
