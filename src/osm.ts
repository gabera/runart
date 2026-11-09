import { type LatLng, fromLocal } from "./geo";
import { type Graph, type RawNode, buildGraph } from "./graph";

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

// Streets and paths a runner can use (no motorways/trunks, no private/forbidden access).
const EXCLUDED =
  "motorway|motorway_link|trunk|trunk_link|construction|proposed|abandoned|raceway|bus_guideway|elevator|platform|corridor";

let cache: Graph | null = null;

function bboxAround(c: LatLng, radiusM: number) {
  const sw = fromLocal(c, { x: -radiusM, y: -radiusM });
  const ne = fromLocal(c, { x: radiusM, y: radiusM });
  return { s: sw.lat, w: sw.lng, n: ne.lat, e: ne.lng };
}

const contains = (o: Graph["bbox"], i: Graph["bbox"]) => o.s <= i.s && o.w <= i.w && o.n >= i.n && o.e >= i.e;

/** Walkable street graph covering a square of `radiusM` around `center` (cached). */
export async function getGraph(center: LatLng, radiusM: number, onStatus?: (s: string) => void): Promise<Graph> {
  const need = bboxAround(center, radiusM);
  if (cache && contains(cache.bbox, need)) return cache;

  // fetch a bit more than needed so small adjustments reuse the cache
  const b = bboxAround(center, radiusM * 1.25);
  const q = `[out:json][timeout:90];
way["highway"]["highway"!~"^(${EXCLUDED})$"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"](${b.s},${b.w},${b.n},${b.e});
(._;>;);
out skel qt;`;

  let lastErr: unknown;
  for (const url of ENDPOINTS) {
    try {
      onStatus?.(`Baixando ruas do OpenStreetMap (${new URL(url).host})…`);
      const res = await fetch(url, { method: "POST", body: new URLSearchParams({ data: q }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const nodes: RawNode[] = [];
      const ways: number[][] = [];
      for (const el of json.elements) {
        if (el.type === "node") nodes.push({ id: el.id, lat: el.lat, lng: el.lon });
        else if (el.type === "way") ways.push(el.nodes);
      }
      onStatus?.("Montando grafo de ruas…");
      const g = buildGraph(nodes, ways, center, b);
      if (g.xs.length < 10) throw new Error("Poucas ruas encontradas nessa região.");
      cache = g;
      return g;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Não foi possível baixar as ruas: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
}

export async function geocode(query: string): Promise<{ name: string; latlng: LatLng }[]> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "pt-BR" } });
  if (!res.ok) throw new Error(`Busca falhou (HTTP ${res.status})`);
  const data = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return data.map((d) => ({ name: d.display_name, latlng: { lat: +d.lat, lng: +d.lon } }));
}
