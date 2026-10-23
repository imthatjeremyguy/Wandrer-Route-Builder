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

  // ---------- area box ----------
  function setArea(bounds, save = true) {
    area = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
    if (!areaRect) areaRect = L.rectangle(bounds, { color: "#12573a", weight: 2, fillOpacity: 0.06, dashArray: "6 4", interactive: false }).addTo(map);
    else areaRect.setBounds(bounds);
    $("draw-area").textContent = "Redraw area";
    if (save) Store.set("area", area);
    clearRoute(); refresh();
  }

  function drawArea() {
    cancelMode();
    mode = "area";
    const el = map.getContainer();
    el.classList.add("picking");
    map.dragging.disable();
    say("Drag a box over the roads you want to collect.");
    let a = null, tmp = null;
    const ll = e => map.mouseEventToLatLng(e);
    const down = e => { if (e.button > 0) return; a = ll(e); el.setPointerCapture?.(e.pointerId); e.preventDefault(); };
    const move = e => {
      if (!a) return;
      const b = L.latLngBounds(a, ll(e));
      if (!tmp) tmp = L.rectangle(b, { color: "#12573a", weight: 2, fillOpacity: 0.08, interactive: false }).addTo(map);
      else tmp.setBounds(b);
    };
    const up = e => {
      if (!a) return;
      const b = L.latLngBounds(a, ll(e));
      cleanup();
      if (map.latLngToContainerPoint(b.getNorthWest()).distanceTo(map.latLngToContainerPoint(b.getSouthEast())) < 12) {
        say("That box was too small. Press Draw area and drag across the roads.", true); return;
      }
      setArea(b); say("");
    };
    function cleanup() {
      el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up);
      if (tmp) map.removeLayer(tmp);
      map.dragging.enable(); el.classList.remove("picking"); mode = null; cancelMode.fn = null;
    }
    el.addEventListener("pointerdown", down); el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    cancelMode.fn = cleanup;
  }

  function cancelMode() {
    if (cancelMode.fn) cancelMode.fn();
    if (mode === "start") map.off("click");
    map.getContainer().classList.remove("picking");
    mode = null;
  }

  function areaNewMiles() {
    if (!network || !area) return 0;
    const [w, s, e, n] = area; let m = 0;
    for (const ed of network.edges) {
      if (ed.newM < 5) continue;
      const [x, y] = ed.coords[ed.coords.length >> 1];
      if (x >= w && x <= e && y >= s && y <= n) m += ed.newM;
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
    worker.postMessage({ type: "solve", start, box: area });
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
      $("draw-area").addEventListener("click", drawArea);
      $("build-route").addEventListener("click", build);
      $("play-route").addEventListener("click", play);
      $("download-gpx").addEventListener("click", gpx);
      document.addEventListener("keydown", e => { if (e.key === "Escape" && mode) { cancelMode(); say(""); } });
      Store.get("start").then(s => { if (s) setStart(L.latLng(s[1], s[0]), false); });
      Store.get("area").then(a => { if (a) setArea(L.latLngBounds([a[1], a[0]], [a[3], a[2]]), false); });
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
