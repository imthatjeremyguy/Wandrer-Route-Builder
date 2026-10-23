"""Build compact road tiles for the site from an OpenStreetMap extract.

Usage: python tools/build_roads.py <input.osm.pbf|.osm> <out_dir>

Keeps the same roads the Overpass query asks for (rideable highways, plus
footways/pedestrian/bridleways that allow bikes) and writes one JSON file per
0.1-degree tile, the same grid js/osm.js uses:

  out_dir/index.json        {"v":1, "built", "osm_date", "tile":0.1, "tiles":{"x_y": ways}}
  out_dir/<x>_<y>.json      {"v":1, "tags":[{...}], "ways":[[id, tagIdx, nodes, lons, lats]], "sig":[...]}

nodes/lons/lats are delta-encoded integers (coordinates in 1e-6 degrees).
A way is written to every tile its bounding box touches, like Overpass does.
"sig" lists node ids with traffic signals that sit on kept ways.
"""
import sys, os, re, json, math, datetime
import osmium

TILE = 0.1
KEEP_TAGS = ("highway", "name", "oneway", "oneway:bicycle", "access", "bicycle", "foot",
             "service", "area", "surface", "junction")
MAIN = re.compile(r"^(trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|"
                  r"unclassified|residential|living_street|service|cycleway|path|track|busway)$")
FOOT = re.compile(r"^(footway|pedestrian|bridleway)$")
BIKE = re.compile(r"^(yes|designated|permissive)$")


def wanted(tags):
    h = tags.get("highway", "")
    return bool(MAIN.match(h) or (FOOT.match(h) and BIKE.match(tags.get("bicycle", ""))))


def deltas(vals):
    out, prev = [], 0
    for v in vals:
        out.append(v - prev); prev = v
    return out


class Roads(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.signals = set()
        self.tiles = {}          # key -> list of way records
        self.tagsets = {}        # key -> {tagset_json: idx}
        self.tag_lists = {}      # key -> [tagset dict]
        self.sig_by_tile = {}    # key -> set(node ids)
        self.ways = 0

    def node(self, n):
        t = n.tags
        if t.get("highway") == "traffic_signals" or t.get("crossing") == "traffic_signals":
            self.signals.add(n.id)

    def way(self, w):
        tags = {k: v for k, v in w.tags if k in KEEP_TAGS}
        if not wanted(tags):
            return
        try:
            refs = [nd.ref for nd in w.nodes]
            lons = [round(nd.lon * 1e6) for nd in w.nodes]
            lats = [round(nd.lat * 1e6) for nd in w.nodes]
        except osmium.InvalidLocationError:
            return  # way references nodes outside the extract
        if len(refs) < 2:
            return
        self.ways += 1
        tj = json.dumps(tags, sort_keys=True, separators=(",", ":"))
        x0, x1 = math.floor(min(lons) / 1e6 / TILE), math.floor(max(lons) / 1e6 / TILE)
        y0, y1 = math.floor(min(lats) / 1e6 / TILE), math.floor(max(lats) / 1e6 / TILE)
        sig = [r for r in refs if r in self.signals]
        rec_tail = [deltas(refs), deltas(lons), deltas(lats)]
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                key = f"{x}_{y}"
                ts = self.tagsets.setdefault(key, {})
                if tj not in ts:
                    ts[tj] = len(ts)
                    self.tag_lists.setdefault(key, []).append(tags)
                self.tiles.setdefault(key, []).append([w.id, ts[tj], *rec_tail])
                if sig:
                    self.sig_by_tile.setdefault(key, set()).update(sig)


def main(src, out):
    os.makedirs(out, exist_ok=True)
    h = Roads()
    h.apply_file(src, locations=True, idx="flex_mem")

    osm_date = None
    try:
        hdr = osmium.io.Reader(src, osmium.osm.osm_entity_bits.NOTHING).header()
        osm_date = hdr.get("osmosis_replication_timestamp") or None
    except Exception:
        pass

    index, total = {}, 0
    for key, ways in h.tiles.items():
        doc = {"v": 1, "tags": h.tag_lists[key], "ways": ways, "sig": sorted(h.sig_by_tile.get(key, ()))}
        data = json.dumps(doc, separators=(",", ":"))
        with open(os.path.join(out, key + ".json"), "w") as f:
            f.write(data)
        index[key] = len(ways)
        total += len(data)
    meta = {"v": 1, "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "osm_date": osm_date, "tile": TILE, "tiles": index}
    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print(f"{h.ways} ways, {len(index)} tiles, {total / 1e6:.1f} MB, {len(h.signals)} signal nodes, osm_date={osm_date}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
