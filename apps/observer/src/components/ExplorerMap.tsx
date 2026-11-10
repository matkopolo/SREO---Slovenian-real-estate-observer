import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, LngLatBoundsLike, MapGeoJSONFeature } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// Vite emits the worker as an asset and returns its URL (a bare specifier inside new URL() is not resolved).
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import type { FeatureCollection, Geometry } from "geojson";
import type { Bbox, MunicipalityShape } from "../api";
import { t } from "../i18n";
import { WITHHELD } from "../metrics";
import { AGREEMENT_ZOOM, BUILDING_ZOOM } from "./map-zoom";

/** Street basemap (OpenFreeMap "liberty", OpenStreetMap data); area colours fade as the user zooms into streets. */
const STYLE = "https://tiles.openfreemap.org/styles/liberty"; // streets, building footprints and places (as in the original dashboard); i18n-ignore
const SLOVENIA: LngLatBoundsLike = [[13.3, 45.4], [16.65, 46.9]];

/** How one area is drawn: `label` ("Šiška: 4.538 €/m², …") is `name` and `value` joined, kept apart for the panel header. */
export interface AreaPaint { color: string; height: number; name: string; value: string; label: string; pooled?: boolean }
export interface MapBuildingPoint { key: string; lon: number; lat: number; color: string; radius: number; label: string }
export interface MapAgreementPoint { id: number; lon: number; lat: number; color: string; label: string }
export interface MapView { bbox: Bbox; zoom: number; /** Moved by the user (drag, wheel, buttons), not by a fit to the selected area. */ byUser?: boolean }

type Collection = FeatureCollection<Geometry, Record<string, unknown>>;
const collection = (features: Collection["features"]): Collection => ({ type: "FeatureCollection", features });

/**
 * The navigator: municipalities (or the selected municipality's districts/settlements) coloured by the chosen
 * measure, buildings from street zoom and single agreements at the closest zoom. Clicks drill down.
 */
export default function ExplorerMap({ municipalities, regions, paint, subAreas, subPaint, buildings, agreements, selected, selectedSub = null, focus, marker = null, extrude,
  onArea, onSubArea, onBuilding, onAgreement, onView }: {
  municipalities: MunicipalityShape[]; regions: MunicipalityShape[]; paint: Map<number, AreaPaint>; // i18n-ignore: TypeScript generics, not JSX text
  subAreas: MunicipalityShape[]; subPaint: Map<number, AreaPaint>;
  buildings: MapBuildingPoint[]; agreements: MapAgreementPoint[];
  selected: number | null; focus: Bbox | null; extrude: boolean;
  /** The district or settlement shown in the panel: outlined on the map. */
  selectedSub?: number | null;
  /** The opened building or sale: drawn as a ring so it stays findable among the other points. */
  marker?: [number, number] | null;
  onArea: (id: number) => void; onSubArea: (id: number) => void; onBuilding: (key: string) => void; onAgreement: (id: number) => void;
  onView: (view: MapView) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const popup = useRef<maplibregl.Popup | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // The map's listeners are registered once; they call the latest callbacks.
  const handlers = useRef({ onArea, onSubArea, onBuilding, onAgreement, onView });
  useLayoutEffect(() => { handlers.current = { onArea, onSubArea, onBuilding, onAgreement, onView }; });

  useEffect(() => {
    if (!host.current || map.current) return;
    // Without WebGL the constructor throws: the error boundary around the map shows the fallback.
    {
      maplibregl.setWorkerUrl(workerUrl);
      const instance = new maplibregl.Map({ container: host.current, style: STYLE, bounds: SLOVENIA, fitBoundsOptions: { padding: 24 },
        minZoom: 6.5, maxZoom: 18.5, maxBounds: [[12.2, 44.9], [17.8, 47.3]], attributionControl: false, dragRotate: false, pitchWithRotate: false,
        // On touch screens one finger scrolls the page; two fingers move the map (no accidental area picks).
        cooperativeGestures: window.matchMedia?.("(pointer: coarse)").matches ?? false,
        // MapLibre's own texts in the interface language (gesture hint, zoom buttons, attribution).
        locale: {
          "CooperativeGesturesHandler.WindowsHelpText": t("Za povečavo zemljevida držite tipko Ctrl in uporabite kolesce"),
          "CooperativeGesturesHandler.MacHelpText": t("Za povečavo zemljevida držite tipko ⌘ in uporabite kolesce"),
          "CooperativeGesturesHandler.MobileHelpText": t("Zemljevid premikate z dvema prstoma"),
          "NavigationControl.ZoomIn": t("Približaj"), "NavigationControl.ZoomOut": t("Oddalji"), "NavigationControl.ResetBearing": t("Obrni proti severu"),
          "AttributionControl.ToggleAttribution": t("Viri zemljevida"), "Map.Title": t("Zemljevid"), "Popup.Close": t("Zapri"),
        } });
      map.current = instance;
      instance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      instance.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
      popup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "map-tip" });
      instance.on("load", () => {
        // Slovenian place names where the tiles have them.
        for (const layer of instance.getStyle().layers ?? []) {
          // Basemap place names would repeat our area labels ("Šoštanj Šoštanj"); they appear from street zoom on.
          if (layer.type === "symbol" && "source-layer" in layer && layer["source-layer"] === "place") {
            try { instance.setLayerZoomRange(layer.id, Math.max(layer.minzoom ?? 0, 14.5), layer.maxzoom ?? 24); } catch { /* keep */ }
          }
          if (layer.type === "symbol" && (layer.layout as Record<string, unknown> | undefined)?.["text-field"]) {
            try { instance.setLayoutProperty(layer.id, "text-field", ["coalesce", ["get", "name:sl"], ["get", "name:latin"], ["get", "name"]]); } catch { /* keep the style's label */ }
          }
        }
        const empty = collection([]);
        for (const id of ["areas", "regions", "sub", "buildings", "agreements", "marker"]) instance.addSource(id, { type: "geojson", data: empty, promoteId: "id" });
        // Area fills fade as the user zooms into streets, so the basemap takes over.
        instance.addLayer({ id: "areas-fill", type: "fill", source: "areas", paint: {
          "fill-color": ["get", "color"],
          // Pooled (3 or 5 years) values are drawn lighter than the selected period.
          // "zoom" may only drive a top-level interpolate, so the pooled case sits inside each stop.
          "fill-opacity": ["interpolate", ["linear"], ["zoom"], 7, ["case", ["get", "pooled"], 0.42, 0.78], 11, ["case", ["get", "pooled"], 0.25, 0.45], 13, 0.12] } });
        instance.addLayer({ id: "areas-extrude", type: "fill-extrusion", source: "areas", layout: { visibility: "none" }, paint: {
          "fill-extrusion-color": ["get", "color"], "fill-extrusion-height": ["get", "height"], "fill-extrusion-opacity": 0.85 } });
        instance.addLayer({ id: "areas-line", type: "line", source: "areas", paint: {
          "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#0f2a33", "#ffffff"],
          "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.6, ["boolean", ["feature-state", "hover"], false], 1.8, 0.6] } });
        instance.addLayer({ id: "areas-label", type: "symbol", source: "areas", maxzoom: 10.5, layout: {
          "text-field": ["get", "name"], "text-size": ["interpolate", ["linear"], ["zoom"], 7, 10, 10, 12], "text-font": ["Noto Sans Regular"] },
          paint: { "text-color": "#1d2b33", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
        instance.addLayer({ id: "regions-line", type: "line", source: "regions", paint: { "line-color": "#36505c", "line-width": 1.4, "line-opacity": 0.8 } });
        instance.addLayer({ id: "sub-fill", type: "fill", source: "sub", paint: {
          "fill-color": ["get", "color"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["get", "pooled"], 0.4, 0.7], 14, ["case", ["get", "pooled"], 0.1, 0.18]] } });
        instance.addLayer({ id: "sub-line", type: "line", source: "sub", paint: {
          "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#0f2a33", "#ffffff"],
          "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 3, ["boolean", ["feature-state", "hover"], false], 2, 0.8] } });
        instance.addLayer({ id: "sub-label", type: "symbol", source: "sub", minzoom: 9.5, maxzoom: 14.5, layout: {
          "text-field": ["get", "name"], "text-size": 11, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#1d2b33", "text-halo-color": "#ffffff", "text-halo-width": 1.4 } });
        instance.addLayer({ id: "buildings", type: "circle", source: "buildings", minzoom: BUILDING_ZOOM, paint: {
          "circle-color": ["get", "color"], "circle-radius": ["get", "radius"], "circle-stroke-color": "#0f2a33", "circle-stroke-width": 1.4,
          "circle-opacity": ["interpolate", ["linear"], ["zoom"], BUILDING_ZOOM, 0.7, AGREEMENT_ZOOM, 0.35] } });
        // Single sales: loaded only from AGREEMENT_ZOOM for buildings, from street zoom for land (no buildings).
        instance.addLayer({ id: "agreements", type: "circle", source: "agreements", minzoom: BUILDING_ZOOM, paint: {
          "circle-color": ["get", "color"], "circle-radius": 7, "circle-stroke-color": "#0f2a33", "circle-stroke-width": 1.5 } });
        instance.addLayer({ id: "marker-halo", type: "circle", source: "marker", paint: {
          "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#ffffff", "circle-stroke-width": 5 } });
        instance.addLayer({ id: "marker-ring", type: "circle", source: "marker", paint: {
          "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#d9480f", "circle-stroke-width": 3 } });

        // One rule for hover and click: the nearest dot within 14 px wins (agreement over building), else the area under the pointer.
        const pick = (point: { x: number; y: number }) => {
          const box: [[number, number], [number, number]] = [[point.x - 14, point.y - 14], [point.x + 14, point.y + 14]];
          const dots = instance.queryRenderedFeatures(box, { layers: ["agreements", "buildings"].filter((id) => instance.getLayer(id)) });
          const distance = (feature: MapGeoJSONFeature) => {
            const [lon, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates;
            const projected = instance.project([lon, lat]);
            return (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2 - (feature.layer.id === "agreements" ? 50 : 0);
          };
          return [...dots].sort((a, b) => distance(a) - distance(b))[0]
            ?? instance.queryRenderedFeatures([point.x, point.y], { layers: ["sub-fill", "areas-fill"].filter((id) => instance.getLayer(id)) })[0];
        };
        const SOURCES: Record<string, string> = { "areas-fill": "areas", "sub-fill": "sub", buildings: "buildings", agreements: "agreements" };
        let hovered: { source: string; id: string | number } | undefined;
        const clearHover = () => {
          if (hovered) instance.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: false });
          hovered = undefined;
          instance.getCanvas().style.cursor = "";
          popup.current?.remove();
        };
        instance.on("mousemove", (event) => {
          const feature = pick(event.point) as MapGeoJSONFeature | undefined;
          if (!feature) { clearHover(); return; }
          const source = SOURCES[feature.layer.id];
          if (hovered && (hovered.source !== source || hovered.id !== feature.id)) instance.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: false });
          if (feature.id !== undefined && source) { hovered = { source, id: feature.id }; instance.setFeatureState({ source, id: feature.id }, { hover: true }); }
          instance.getCanvas().style.cursor = "pointer";
          popup.current?.setLngLat(event.lngLat).setText(String(feature.properties?.label ?? "")).addTo(instance);
        });
        instance.getCanvas().addEventListener("mouseleave", clearHover);
        // The most specific feature wins: agreement > building > sub-area > municipality.
        instance.on("click", (event) => {
          const hit = pick(event.point);
          if (!hit) return;
          const id = hit.properties?.id;
          if (hit.layer.id === "agreements") handlers.current.onAgreement(Number(id));
          else if (hit.layer.id === "buildings") handlers.current.onBuilding(String(id));
          else if (hit.layer.id === "sub-fill") handlers.current.onSubArea(Number(id));
          else handlers.current.onArea(Number(id));
        });
        let userMoved = false;
        instance.on("movestart", (event) => { userMoved = !!(event as { originalEvent?: unknown }).originalEvent; });
        instance.on("zoomstart", (event) => { if ((event as { originalEvent?: unknown }).originalEvent) userMoved = true; });
        const report = () => {
          const bounds = instance.getBounds();
          handlers.current.onView({ bbox: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], zoom: instance.getZoom(), byUser: userMoved });
        };
        instance.on("moveend", report);
        setReady(true);
        report();
      });
      instance.on("error", (event) => { if (String(event.error?.message ?? "").includes("WebGL")) setFailed(true); });
    }
    return () => { popup.current?.remove(); map.current?.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("areas") as GeoJSONSource).setData(collection(municipalities.map((shape) => {
      const style = paint.get(shape.id);
      return { type: "Feature", id: shape.id, geometry: shape.geometry, properties: { id: shape.id, name: shape.name,
        color: style?.color ?? WITHHELD, height: style?.height ?? 0, label: style?.label ?? shape.name, pooled: !!style?.pooled } };
    })));
  }, [municipalities, paint, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("regions") as GeoJSONSource).setData(collection(regions.map((shape) => ({ type: "Feature", id: shape.id, geometry: shape.geometry, properties: { id: shape.id } }))));
  }, [regions, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("sub") as GeoJSONSource).setData(collection(subAreas.map((shape) => {
      const style = subPaint.get(shape.id);
      return { type: "Feature", id: shape.id, geometry: shape.geometry, properties: { id: shape.id, name: shape.name,
        color: style?.color ?? WITHHELD, label: style?.label ?? shape.name, pooled: !!style?.pooled } };
    })));
  }, [ready, subAreas, subPaint]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("buildings") as GeoJSONSource).setData(collection(buildings.map((item) => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [item.lon, item.lat] }, properties: { id: item.key, color: item.color, radius: item.radius, label: item.label } }))));
  }, [buildings, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("agreements") as GeoJSONSource).setData(collection(agreements.map((item) => ({ type: "Feature",
      geometry: { type: "Point", coordinates: [item.lon, item.lat] }, properties: { id: item.id, color: item.color, label: item.label } }))));
  }, [agreements, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    (instance.getSource("marker") as GeoJSONSource).setData(collection(marker
      ? [{ type: "Feature", geometry: { type: "Point", coordinates: marker }, properties: { id: 1 } }] : []));
  }, [marker, ready]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    for (const shape of subAreas) instance.setFeatureState({ source: "sub", id: shape.id }, { selected: shape.id === selectedSub });
  }, [ready, selectedSub, subAreas]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    for (const shape of municipalities) instance.setFeatureState({ source: "areas", id: shape.id }, { selected: shape.id === selected });
  }, [municipalities, ready, selected]);

  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (focus) instance.fitBounds([[focus[0], focus[1]], [focus[2], focus[3]]], { padding: 40, duration: reduced ? 0 : 700, maxZoom: 16.5 });
    else instance.fitBounds(SLOVENIA, { padding: 24, duration: reduced ? 0 : 700 });
  }, [focus, ready]);

  // Only a real 3D toggle animates the pitch; an easeTo on first load would cancel the fitBounds zoom.
  const extruded = useRef(false);
  useEffect(() => {
    const instance = map.current;
    if (!ready || !instance) return;
    instance.setLayoutProperty("areas-extrude", "visibility", extrude ? "visible" : "none");
    if (extrude !== extruded.current) instance.easeTo({ pitch: extrude ? 50 : 0, duration: 500 });
    extruded.current = extrude;
  }, [extrude, ready]);

  return <div className="explorer-map" ref={host} role="region" aria-label={t("Zemljevid: izberite območje ali stavbo; enako vsebino ima lestvica v levem stolpcu")}>
    {failed && <p className="fallback" role="status">{t("Zemljevid v tem brskalniku ni na voljo. Območje izberite z iskalnikom zgoraj.")}</p>}
  </div>;
}
