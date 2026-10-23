"""Step 4: shortest loop from a start node that rides every 'new' edge, obeying one-way streets.

Usage: python solve_route.py out/network.pkl <start_node_id> out/route
Method (mixed Rural Postman heuristic):
  1. Undirected pass: join required edges (MST) + odd-node matching -> Euler circuit.
     Its travel direction picks an orientation for each two-way new road.
  2. Directed pass: required arcs (one-ways fixed, two-ways as oriented above).
     Join components with round-trip directed shortest paths, then balance
     in/out degree with a min-cost flow over the legal directed network.
  3. Walk the directed Eulerian circuit from the start node.
Outputs: <prefix>.gpx, <prefix>.geojson, stats printed.
"""
import sys, json, pickle, itertools
import networkx as nx

NET, START, PREFIX = sys.argv[1], sys.argv[2], sys.argv[3]
M2MI = 1 / 1609.344
MIN_NEW_M = 5            # ignore slivers shorter than this (cut-point artifacts)

G = pickle.load(open(NET, 'rb'))

# ---------- legal directed network ----------
D = nx.DiGraph()   # keep shortest arc per ordered pair
def arc(a, b, k, L):
    if not D.has_edge(a, b) or D[a][b]['w'] > L: D.add_edge(a, b, w=L, gk=k)
def allowed(u, v, d):
    """Can we ride edge d from u to v?"""
    ow = d['oneway']
    if not ow: return True
    fwd = d['u_first'] == u
    return fwd if ow is True else not fwd
for u, v, k, d in G.edges(keys=True, data=True):
    if allowed(u, v, d): arc(u, v, k, d['length_m'])
    if allowed(v, u, d): arc(v, u, k, d['length_m'])

req = [(u, v, k) for u, v, k, d in G.edges(keys=True, data=True) if d['new_m'] >= MIN_NEW_M]

# ---------- 1. undirected pass to orient two-way required roads ----------
W = nx.Graph()
for u, v, k, d in G.edges(keys=True, data=True):
    if not W.has_edge(u, v) or W[u][v]['w'] > d['length_m']: W.add_edge(u, v, w=d['length_m'], gk=k)
U = nx.MultiGraph(); U.add_node(START)
for u, v, k in req: U.add_edge(u, v, gk=k)
def uadd(path):
    for a, b in zip(path, path[1:]): U.add_edge(a, b, gk=W[a][b]['gk'])
comps = [set(c) for c in nx.connected_components(U)]
if len(comps) > 1:
    C = nx.Graph()
    for i in range(len(comps)):
        dist, paths = nx.multi_source_dijkstra(W, comps[i], weight='w')
        for j in range(i + 1, len(comps)):
            n = min(comps[j], key=lambda x: dist.get(x, 1e18))
            C.add_edge(i, j, w=dist[n], path=paths[n])
    for *_, d in nx.minimum_spanning_edges(C, weight='w', data=True): uadd(d['path'])
odd = [n for n in U.nodes if U.degree(n) % 2]
sp = {n: nx.single_source_dijkstra(W, n, weight='w') for n in odd}
M = nx.Graph()
for a, b in itertools.combinations(odd, 2): M.add_edge(a, b, w=sp[a][0][b])
for a, b in nx.min_weight_matching(M, weight='w'): uadd(sp[a][1][b])
orient = {}
for u, v, rk in nx.eulerian_circuit(U, source=START, keys=True):
    key = (frozenset((u, v)), U[u][v][rk]['gk'])
    orient.setdefault(key, (u, v))

# ---------- 2. directed pass ----------
R = nx.MultiDiGraph(); R.add_node(START)
for u, v, k in req:
    d = G[u][v][k]
    a, b = orient.get((frozenset((u, v)), k), (u, v))
    if not allowed(a, b, d): a, b = b, a          # one-way: force legal direction
    R.add_edge(a, b, gk=k, kind='new')
def dadd(path):
    for a, b in zip(path, path[1:]): R.add_edge(a, b, gk=D[a][b]['gk'], kind='link')

# balance: nodes with more in than out must receive extra arcs from nodes with more out than in
F = nx.DiGraph()
for a, b, d in D.edges(data=True): F.add_edge(a, b, weight=int(round(d['w'])))
imb = {n: 0 for n in F.nodes}
for n in R.nodes: imb[n] = R.out_degree(n) - R.in_degree(n)
def balance_cost():
    for n in F.nodes: F.nodes[n]['demand'] = imb[n]
    return nx.network_simplex(F)

# local search: reverse whole streets (all new blocks of one OSM way), then single blocks
def cand_list():
    return [(a, b, rk) for a, b, rk, d in R.edges(keys=True, data=True)
            if d['kind'] == 'new' and allowed(b, a, G[a][b][d['gk']])]
def way_of(e): a, b, rk = e; return G[a][b][R[a][b][rk]['gk']]['way']
best, _ = balance_cost()
print(f"balancing overhead before search: {best*M2MI:.2f} mi")
def try_flip(group):
    global best
    for a, b, _ in group: imb[a] -= 2; imb[b] += 2
    c, _ = balance_cost()
    if c < best:
        best = c
        for a, b, rk in group:
            gk = R[a][b][rk]['gk']; R.remove_edge(a, b, key=rk); R.add_edge(b, a, gk=gk, kind='new')
        return True
    for a, b, _ in group: imb[a] += 2; imb[b] -= 2
    return False
passes = 0
for mode in ('street', 'block'):
    improved = True
    while improved and passes < 10:
        improved, passes = False, passes + 1
        cs = cand_list()
        groups = {}
        for e in cs: groups.setdefault(way_of(e) if mode == 'street' else e, []).append(e)
        done = set()
        for g in groups.values():
            g = [e for e in g if e not in done]
            if g and try_flip(g): improved = True; done.update(g)
print(f"balancing overhead after {passes} passes: {best*M2MI:.2f} mi")
_, flow = balance_cost()
for a, nbrs in flow.items():
    for b, f in nbrs.items():
        for _ in range(f): R.add_edge(a, b, gk=D[a][b]['gk'], kind='link')

# join any clusters the balancing paths didn't already connect (round trips keep balance)
Drev = D.reverse(copy=False)
comps = [set(c) for c in nx.weakly_connected_components(R)]
print(f"clusters still separate after balancing: {len(comps)}")
if len(comps) > 1:
    C = nx.Graph()
    for i in range(len(comps)):
        fd, fp = nx.multi_source_dijkstra(D, comps[i], weight='w')      # i -> others
        bd, bp = nx.multi_source_dijkstra(Drev, comps[i], weight='w')   # others -> i
        for j in range(i + 1, len(comps)):
            n1 = min(comps[j], key=lambda x: fd.get(x, 1e18))
            n2 = min(comps[j], key=lambda x: bd.get(x, 1e18))
            C.add_edge(i, j, w=fd[n1] + bd[n2], go=fp[n1], back=bp[n2][::-1])
    for *_, d in nx.minimum_spanning_edges(C, weight='w', data=True):
        dadd(d['go']); dadd(d['back'])
    for n in F.nodes: imb[n] = 0
    for n in R.nodes: imb[n] = R.out_degree(n) - R.in_degree(n)
    extra, flow = balance_cost()
    print(f"re-balance after joining clusters: {extra*M2MI:.2f} mi")
    for a, nbrs in flow.items():
        for b, f in nbrs.items():
            for _ in range(f): R.add_edge(a, b, gk=D[a][b]['gk'], kind='link')

assert nx.is_eulerian(R), "directed graph not eulerian"

# ---------- 3. walk it ----------
coords, total, new_got, seen, wrong = [], 0.0, 0.0, set(), 0
for u, v, rk in nx.eulerian_circuit(R, source=START, keys=True):
    k = R[u][v][rk]['gk']; d = G[u][v][k]
    if not allowed(u, v, d): wrong += 1
    seg = d['coords'] if d['u_first'] == u else d['coords'][::-1]
    coords.extend(seg if not coords else seg[1:])
    total += d['length_m']
    eid = (min(u, v), max(u, v), k)
    if eid not in seen: new_got += d['new_m']; seen.add(eid)

avail = sum(d['new_m'] for *_, d in G.edges(data=True))
print(f"total distance: {total*M2MI:.2f} mi")
print(f"new miles:      {new_got*M2MI:.2f} of {avail*M2MI:.2f} available")
print(f"overhead:       {(total-new_got)*M2MI:.2f} mi (connectors + repeats)")
print(f"efficiency:     {new_got/total:.0%} of riding is new road")
print(f"wrong-way edges: {wrong}")

gpx = ['<?xml version="1.0" encoding="UTF-8"?>',
       '<gpx version="1.1" creator="wandrer-router" xmlns="http://www.topografix.com/GPX/1/1">',
       '<trk><name>Wandrer route</name><trkseg>']
gpx += [f'<trkpt lat="{la:.6f}" lon="{lo:.6f}"/>' for lo, la in coords]
gpx += ['</trkseg></trk></gpx>']
open(f"{PREFIX}.gpx", "w").write("\n".join(gpx))
json.dump({"type": "Feature", "geometry": {"type": "LineString", "coordinates": coords},
           "properties": {"total_mi": round(total * M2MI, 2), "new_mi": round(new_got * M2MI, 2)}},
          open(f"{PREFIX}.geojson", "w"))
