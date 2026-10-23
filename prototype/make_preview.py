"""Render network + route to a standalone Leaflet HTML preview."""
import json, sys
net = json.load(open(sys.argv[1])); route = json.load(open(sys.argv[2])); out = sys.argv[3]
p = route['properties']
html = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Route Preview</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<style>html,body{margin:0;height:100%;background:#fff;font-family:system-ui,sans-serif}#m{height:100%}
.lg{background:#fff;padding:8px 10px;border-radius:6px;box-shadow:0 1px 4px #0003;font-size:13px;line-height:1.6;max-width:220px}
.lg i{display:inline-block;width:18px;height:4px;margin-right:6px;vertical-align:middle}
.lg button{margin-top:6px;font:inherit;padding:3px 10px;border:1px solid #888;border-radius:4px;background:#f4f4f4;cursor:pointer}</style></head>
<body><div id="m"></div><script>
const NET=__NET__, R=__ROUTE__;
const ll=R.geometry.coordinates.map(c=>[c[1],c[0]]);
const m=L.map('m').fitBounds(L.latLngBounds(ll).pad(0.05));
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap, &copy; CARTO',maxZoom:19}).addTo(m);
L.geoJSON(NET,{style:f=>f.properties.cls==='connector'?{color:'#8a94a6',weight:1.5,opacity:.45}:{color:'#e0362c',weight:7,opacity:.45}}).addTo(m);
const line=L.polyline(ll,{color:'#1d5fd1',weight:3,opacity:.9}).addTo(m);
L.circleMarker(ll[0],{radius:8,color:'#111',fillColor:'#2fb344',fillOpacity:1,weight:2}).bindTooltip('Start / finish').addTo(m);
const dot=L.circleMarker(ll[0],{radius:6,color:'#fff',fillColor:'#1d5fd1',fillOpacity:1,weight:2}).addTo(m);
let i=0,t=null;
function play(){if(t){clearInterval(t);t=null;btn.textContent='Play route';return}btn.textContent='Pause';
 t=setInterval(()=>{i=(i+1)%ll.length;dot.setLatLng(ll[i])},25)}
const lg=L.control({position:'topright'});let btn;
lg.onAdd=()=>{const d=L.DomUtil.create('div','lg');
 d.innerHTML='<b>__TOT__ mi loop</b><br>__NEW__ mi new road<br><i style="background:#1d5fd1"></i>Route<br><i style="background:#e0362c;opacity:.5"></i>New road<br>';
 btn=L.DomUtil.create('button','',d);btn.textContent='Play route';btn.onclick=play;L.DomEvent.disableClickPropagation(d);return d};
lg.addTo(m);
</script></body></html>"""
html = html.replace('__NET__', json.dumps(net)).replace('__ROUTE__', json.dumps(route)) \
           .replace('__TOT__', str(p['total_mi'])).replace('__NEW__', str(p['new_mi']))
open(out, 'w').write(html)
