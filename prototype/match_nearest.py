"""Assign each untraveled sub-segment to its single nearest, parallel OSM way."""
import sys, math, collections
import xml.etree.ElementTree as ET
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
KML, OSM = sys.argv[1], sys.argv[2]
MX, MY = 111320*math.cos(math.radians(39.84)), 110540
def P(lon, lat): return (lon*MX, lat*MY)
M2MI=1/1609.344
K='{http://www.opengis.net/kml/2.2}'
pieces=set()
for ls in ET.parse(KML).getroot().iter(K+'LineString'):
    pts=[P(*map(float,p.split(',')[:2])) for p in ls.findtext(K+'coordinates').split()]
    for a,b in zip(pts,pts[1:]):
        if a!=b: pieces.add(tuple(sorted((a,b))))
root=ET.parse(OSM).getroot()
nodes={n.get('id'):P(float(n.get('lon')),float(n.get('lat'))) for n in root.iter('node')}
segs=[];meta=[]
for w in root.iter('way'):
    t={x.get('k'):x.get('v') for x in w.iter('tag')}
    if 'highway' not in t: continue
    pts=[nodes[n.get('ref')] for n in w.iter('nd') if n.get('ref') in nodes]
    k=t['highway']+("/"+t['footway'] if 'footway' in t else "")+("/"+t['service'] if 'service' in t else "")+(" access="+t['access'] if 'access' in t else "")
    for a,b in zip(pts,pts[1:]):
        if a!=b: segs.append(LineString([a,b])); meta.append(k)
tree=STRtree(segs)
def ang(a,b): return math.atan2(b[1]-a[1],b[0]-a[0])%math.pi
agg=collections.Counter(); unmatched=0
for a,b in pieces:
    L=math.dist(a,b); mid=Point((a[0]+b[0])/2,(a[1]+b[1])/2); th=ang(a,b)
    best=None
    for i in tree.query(mid.buffer(15)):
        s=segs[i]; d=s.distance(mid)
        c=s.coords; dth=abs(ang(c[0],c[1])-th); dth=min(dth,math.pi-dth)
        if dth>math.radians(25) and L>3: continue
        if best is None or d<best[0]: best=(d,meta[i])
    if best and best[0]<10: agg[best[1]]+=L
    else: unmatched+=L
for k,v in agg.most_common(): print(f"  {k:45s} {v*M2MI:6.2f} mi")
print(f"  unmatched {unmatched*M2MI:.2f} mi")
