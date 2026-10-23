/* GPX track writer. coords: [[lon, lat], ...] */
(function () {
  const esc = s => String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

  function toGpx(coords, name) {
    const pts = coords.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wandrer Route Builder" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(name)}</name></metadata>
<trk><name>${esc(name)}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>
`;
  }

  function download(coords, name) {
    const blob = new Blob([toGpx(coords, name)], { type: "application/gpx+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[^\w\-. ]+/g, "").replace(/\s+/g, "-") + ".gpx";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.Gpx = { toGpx, download };
})();
