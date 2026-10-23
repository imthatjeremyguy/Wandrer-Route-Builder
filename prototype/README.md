# Python prototype

The proof of concept that the browser version is checked against.

```
pip install shapely networkx
python build_network.py data/area.osm data/untraveled.kml out/
python solve_route.py out/network.pkl <start_osm_node_id> out/route
python make_preview.py out/network.geojson out/route.geojson out/route_preview.html
```

- `build_network.py`: OSM roads + Wandrer KMZ lines into a routable graph tagged new vs connector.
- `solve_route.py`: shortest one-way-aware loop from a start node that rides every new road.
- `make_preview.py`: Leaflet preview of the network and route.
- `match_nearest.py`: diagnostic; which OSM road types Wandrer's untraveled lines sit on.

Reference result (Oct 23, 2026, Butler-Tarkington / Rocky Ripple, start Illinois St & 52nd St):
13.38 mi untraveled, 13.37 mi captured on the graph, 24.47 mi loop collecting 13.35 new mi, 0 wrong-way edges.
