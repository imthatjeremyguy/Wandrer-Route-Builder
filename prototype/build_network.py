"""Step 3: build a routable bike graph from OSM, tagging each edge with Wandrer 'new' miles.

Usage: python build_network.py data/area.osm data/untraveled.kml out/
Outputs: out/network.pkl (networkx MultiGraph), out/network.geojson
"""
import sys, math, json, pickle
import xml.etree.ElementTree as ET
import networkx as nx
from shapely.geometry import LineString, Point
from shapely.strtree import STRtree

OSM, KML, OUT = sys.argv[1], sys.argv[2], sys.argv[3].rstrip('/')
LAT0 = 39.84
MX, MY = 111320 * math.cos(math.radians(LAT0)), 110540
M2MI = 1 / 1609.344
MATCH_DIST_M = 6      # untraveled line must be within this distance of the road
MATCH_ANGLE = 25      # and roughly parallel (degrees)
SAMPLE_M = 3          # sampling interval along each road segment

def proj(lon, lat): return (lon * MX, lat * MY)

# ---------- 1. which OSM ways are rideable connectors ----------
RIDEABLE = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
            'residential', 'unclassified', 'living_street', 'service', 'cycleway', 'path', 'track',
            'trunk', 'trunk_link', 'busway_no'}
NO_SERVICE = {'driveway', 'parking_aisle', 'drive-through'}
BLOCK = {'no', 'private', 'customers', 'delivery'}

def rideable(t):
    h = t.get('highway')
    if t.get('bicycle') in ('yes', 'designated', 'permissive'):
        return h not in ('motorway', 'motorway_link', 'steps')
    if h not in RIDEABLE: return False
    if t.get('access') in BLOCK or t.get('bicycle') in ('no', 'private', 'dismount'): return False
    if h == 'service' and t.get('service') in NO_SERVICE: return False
    if h == 'path' and t.get('bicycle') is None and t.get('foot') == 'designated': return False
    if t.get('area') == 'yes': return False
    return True

root = ET.parse(OSM).getroot()
nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
ways = []
for w in root.iter('way'):
    t = {x.get('k'): x.get('v') for x in w.iter('tag')}
    if 'highway' in t and rideable(t):
        refs = [n.get('ref') for n in w.iter('nd') if n.get('ref') in nodes]
        if len(refs) > 1: ways.append((w.get('id'), t, refs))

# ---------- 2. Wandrer untraveled pieces (projected) ----------
K = '{http://www.opengis.net/kml/2.2}'
unt = set()
for ls in ET.parse(KML).getroot().iter(K + 'LineString'):
    pts = [proj(*map(float, p.split(',')[:2])) for p in ls.findtext(K + 'coordinates').split()]
    for a, b in zip(pts, pts[1:]):
        if a != b: unt.add(tuple(sorted((a, b))))
unt = [LineString(s) for s in unt]
unt_ang = [math.atan2(s.coords[1][1] - s.coords[0][1], s.coords[1][0] - s.coords[0][0]) % math.pi for s in unt]
tree = STRtree(unt)
unt_total = sum(s.length for s in unt)

def new_fraction(a, b):
    """Fraction of OSM segment a->b covered by a parallel untraveled piece."""
    L = math.dist(a, b)
    th = math.atan2(b[1] - a[1], b[0] - a[0]) % math.pi
    n = max(1, int(L // SAMPLE_M))
    hits = 0
    for i in range(n):
        f = (i + 0.5) / n
        p = Point(a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]))
        for j in tree.query(p.buffer(MATCH_DIST_M)):
            d = abs(unt_ang[j] - th); d = min(d, math.pi - d)
            if (d < math.radians(MATCH_ANGLE) or unt[j].length < 3) and unt[j].distance(p) <= MATCH_DIST_M:
                hits += 1; break
    return hits / n

# ---------- 3. graph: split ways at intersections ----------
use = {}
for _, _, refs in ways:
    for r in refs: use[r] = use.get(r, 0) + 1
    use[refs[0]] += 1; use[refs[-1]] += 1   # way ends are always graph nodes

G = nx.MultiGraph()
for wid, t, refs in ways:
    oneway = t.get('oneway') in ('yes', '1', '-1') and t.get('oneway:bicycle') != 'no' \
             and t.get('highway') not in ('cycleway', 'path')
    chunk = [refs[0]]
    for r in refs[1:]:
        chunk.append(r)
        if use[r] > 1:
            ll = [nodes[x] for x in chunk]
            pp = [proj(*x) for x in ll]
            length = sum(math.dist(pp[i], pp[i + 1]) for i in range(len(pp) - 1))
            new = sum(math.dist(pp[i], pp[i + 1]) * new_fraction(pp[i], pp[i + 1]) for i in range(len(pp) - 1))
            if length > 0:
                G.add_edge(chunk[0], chunk[-1], way=wid, name=t.get('name', ''), highway=t['highway'],
                           length_m=length, new_m=new, oneway=('-1' if t.get('oneway') == '-1' else oneway),
                           u_first=chunk[0], coords=ll)
            chunk = [r]
for n in G.nodes: G.nodes[n]['lonlat'] = nodes[n]

# keep the largest connected piece (drops islands like isolated parking lots)
big = max(nx.connected_components(G), key=len)
dropped_new = sum(d['new_m'] for u, v, d in G.edges(data=True) if u not in big)
G = G.subgraph(big).copy()

# ---------- 4. report + save ----------
tot = sum(d['length_m'] for *_, d in G.edges(data=True))
new = sum(d['new_m'] for *_, d in G.edges(data=True))
new_edges = sum(1 for *_, d in G.edges(data=True) if d['new_m'] > 0)
print(f"graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {tot*M2MI:.1f} mi rideable")
print(f"Wandrer untraveled in export: {unt_total*M2MI:.2f} mi")
print(f"new miles captured on graph:  {new*M2MI:.2f} mi across {new_edges} edges")
print(f"new miles on disconnected islands (dropped): {dropped_new*M2MI:.2f} mi")

with open(f"{OUT}/network.pkl", "wb") as f: pickle.dump(G, f)
feats = []
for u, v, d in G.edges(data=True):
    frac = d['new_m'] / d['length_m']
    feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": d['coords']},
                  "properties": {"name": d['name'], "highway": d['highway'],
                                 "length_mi": round(d['length_m'] * M2MI, 3), "new_mi": round(d['new_m'] * M2MI, 3),
                                 "cls": "new" if frac > 0.9 else ("partial" if frac > 0.05 else "connector")}})
json.dump({"type": "FeatureCollection", "features": feats}, open(f"{OUT}/network.geojson", "w"))
