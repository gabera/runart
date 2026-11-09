import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { DrawPad, SHAPES } from "./drawpad";
import { type LatLng, suggestDistances, toLocal } from "./geo";
import { estimateBlockSize } from "./graph";
import { geocode, getGraph } from "./osm";
import { type Plan, initialScale, placeDrawing, plan } from "./planner";
import { download, toGpx } from "./gpx";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------
let start: LatLng | null = null;
let blockM = 120; // typical block size; refined once we see the streets around the start
let current: Plan | null = null;

// ---------- map ----------
const map = L.map("map", { zoomControl: true }).setView([-23.5614, -46.6559], 14);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
const startIcon = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:50%;background:${accent};border:3px solid #fff;box-shadow:0 1px 4px #0006"></div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});
let startMarker: L.Marker | null = null;
const ghost = L.polyline([], { color: "#16130f", weight: 3, opacity: 0.55, dashArray: "6 8" }).addTo(map);
const routeLine = L.polyline([], { color: accent, weight: 5, opacity: 0.95 }).addTo(map);

new ResizeObserver(() => map.invalidateSize()).observe($("map"));
map.on("click", (e: L.LeafletMouseEvent) => setStart({ lat: e.latlng.lat, lng: e.latlng.lng }));

// ---------- drawing ----------
const pad = new DrawPad($<HTMLCanvasElement>("pad"), () => {
  clearRoute();
  refresh();
});
document.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
  b.addEventListener("click", () => (b.dataset.act === "undo" ? pad.undo() : pad.clear())),
);
document.querySelectorAll<HTMLButtonElement>("[data-shape]").forEach((b) =>
  b.addEventListener("click", () => pad.setShape(SHAPES[b.dataset.shape!]())),
);
$<HTMLInputElement>("closed").addEventListener("change", (e) => {
  pad.closed = (e.target as HTMLInputElement).checked;
  pad.render();
  clearRoute();
  refresh();
});

// ---------- start point ----------
async function setStart(p: LatLng, zoom = false) {
  start = p;
  clearRoute();
  if (!startMarker) startMarker = L.marker([p.lat, p.lng], { icon: startIcon, draggable: true }).addTo(map);
  else startMarker.setLatLng([p.lat, p.lng]);
  startMarker.off("dragend").on("dragend", () => {
    const ll = startMarker!.getLatLng();
    setStart({ lat: ll.lat, lng: ll.lng });
  });
  if (zoom) map.setView([p.lat, p.lng], 15);
  $("startInfo").textContent = `Partida: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)} — arraste o marcador para ajustar.`;
  refresh();

  // learn the local street density to refine the minimum-distance suggestion
  try {
    const g = await getGraph(p, 800);
    if (start !== p) return;
    blockM = estimateBlockSize(g, toLocal(g.origin, p), 700);
    refresh();
  } catch {
    /* keep default block size */
  }
}

$("search").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>("q").value.trim();
  if (!q) return;
  const ul = $("results");
  ul.innerHTML = "<li>Buscando…</li>";
  try {
    const rs = await geocode(q);
    ul.innerHTML = "";
    if (!rs.length) ul.innerHTML = "<li>Nada encontrado.</li>";
    for (const r of rs) {
      const li = document.createElement("li");
      li.textContent = r.name;
      li.onclick = () => {
        ul.innerHTML = "";
        setStart(r.latlng, true);
      };
      ul.appendChild(li);
    }
  } catch (err) {
    ul.innerHTML = "";
    const li = document.createElement("li");
    li.textContent = (err as Error).message;
    ul.appendChild(li);
  }
});

$("locate").addEventListener("click", () => {
  if (!navigator.geolocation) return setStatus("Geolocalização indisponível neste navegador.", true);
  setStatus("Obtendo sua localização…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setStatus("");
      setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude }, true);
    },
    (err) => setStatus(`Não foi possível obter a localização: ${err.message}`, true),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

// ---------- distance / rotation ----------
const km = $<HTMLInputElement>("km");
const rot = $<HTMLInputElement>("rot");
km.addEventListener("input", () => {
  clearRoute();
  refresh();
});
rot.addEventListener("input", () => {
  clearRoute();
  refresh();
});

function refresh() {
  $("kmOut").textContent = `${km.value} km`;
  $("rotOut").textContent = `${rot.value}°`;
  const path = pad.path();
  const hasDrawing = path.length >= 2;

  const sug = $("suggest");
  if (hasDrawing) {
    const { minKm, recKm } = suggestDistances(path, blockM);
    const warn = +km.value < minKm ? `<span class="warn">Abaixo do mínimo — o desenho pode ficar irreconhecível.</span><br>` : "";
    sug.innerHTML = `${warn}Mínima sugerida: <b>${minKm} km</b> · recomendada: <b>${recKm} km</b> <button data-km="${recKm}">usar</button>
      <br><small class="hint">Quarteirões por aqui: ~${Math.round(blockM)} m</small>`;
    sug.querySelector("button")!.onclick = () => {
      km.value = String(recKm);
      clearRoute();
      refresh();
    };
  } else sug.innerHTML = "";

  // live preview of the drawing placed on the map
  if (hasDrawing && start) {
    const pts = placeDrawing(path, start, initialScale(path, +km.value), +rot.value);
    ghost.setLatLngs(pts);
  } else ghost.setLatLngs([]);

  $<HTMLButtonElement>("go").disabled = !(hasDrawing && start);
}

function clearRoute() {
  current = null;
  routeLine.setLatLngs([]);
  $("result").hidden = true;
}

function setStatus(s: string, err = false) {
  const el = $("status");
  el.textContent = s;
  el.classList.toggle("err", err);
}

// ---------- generate ----------
$("go").addEventListener("click", async () => {
  if (!start) return;
  const btn = $<HTMLButtonElement>("go");
  btn.disabled = true;
  clearRoute();
  try {
    const p = await plan(
      {
        pathPx: pad.path(),
        start,
        targetKm: +km.value,
        rotDeg: +rot.value,
        autoRotate: $<HTMLInputElement>("auto").checked,
      },
      (c, r) => getGraph(c, r, setStatus),
      setStatus,
    );
    current = p;
    blockM = p.blockM;
    rot.value = String(((p.rotDeg + 540) % 360) - 180);
    refresh();
    ghost.setLatLngs(p.target);
    routeLine.setLatLngs(p.latlngs);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    $("rKm").textContent = `${(p.lengthM / 1000).toFixed(2)} km`;
    $("rFid").textContent = `${Math.round(p.fidelity)}%`;
    $("rDev").textContent = `${Math.round(p.meanDevM)} m`;
    $("result").hidden = false;
    setStatus(p.fidelity < 60 ? "Fidelidade baixa: tente aumentar a distância, girar o desenho ou mudar a partida." : "");
  } catch (e) {
    setStatus((e as Error).message, true);
  } finally {
    btn.disabled = false;
  }
});

$("gpx").addEventListener("click", () => {
  if (!current) return;
  const name = `RunArt ${(current.lengthM / 1000).toFixed(1)} km`;
  download(`runart-${(current.lengthM / 1000).toFixed(1)}km.gpx`, toGpx(name, current.latlngs));
});

refresh();
