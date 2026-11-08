"use client";

import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import type { Point } from "geojson";
import { useEffect, useRef, useState } from "react";
import { loadConstructionMap, type ConstructionFilter, type ConstructionMapResponse } from "@/lib/construction-api";
import { mapStyle } from "@/lib/map-styles";
import styles from "./construction.module.css";

const SLOVENIA_BOUNDS: [[number, number], [number, number]] = [[13.3, 45.38], [16.65, 46.9]];
const BUILDING_ZOOM = 12;

type Status = "loading" | "ready" | "offline";

function toGeoJSON(response: ConstructionMapResponse) {
  return {
    type: "FeatureCollection" as const,
    features: response.items.map((item) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [item.longitude, item.latitude] },
      properties: { ...item, label: item.kind === "area" ? item.buildings.toLocaleString("sl-SI") : "" },
    })),
  };
}

export function ConstructionMap({ filter, selectedEid, onArea, onBuilding }: {
  filter: ConstructionFilter;
  selectedEid?: string;
  onArea: (geographyId: number, name: string) => void;
  onBuilding: (eid: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const handlers = useRef({ onArea, onBuilding });
  const [status, setStatus] = useState<Status>("loading");
  const [level, setLevel] = useState<"municipality" | "building">("municipality");
  const [truncated, setTruncated] = useState(false);
  useEffect(() => { handlers.current = { onArea, onBuilding }; }, [onArea, onBuilding]);

  useEffect(() => {
    if (!container.current || mapRef.current) return;
    // Same bundled-worker fix as the market map (MapLibre 6 + Next.js).
    maplibregl.setWorkerUrl(new URL("maplibre-gl/dist/maplibre-gl-worker.mjs", import.meta.url).href);
    const map = new maplibregl.Map({
      container: container.current, style: mapStyle("street"), bounds: SLOVENIA_BOUNDS,
      minZoom: 6.25, maxZoom: 18, maxBounds: [[12.6, 44.9], [17.4, 47.3]], attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
    map.on("load", () => {
      map.addSource("construction", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({ id: "areas", type: "circle", source: "construction", filter: ["==", ["get", "kind"], "area"], paint: {
        "circle-color": "#167266", "circle-opacity": 0.78, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
        "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "buildings"]], 1, 6, 10, 13, 45, 32],
      } });
      map.addLayer({ id: "area-labels", type: "symbol", source: "construction", filter: ["==", ["get", "kind"], "area"],
        layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": false },
        paint: { "text-color": "#ffffff" } });
      map.addLayer({ id: "buildings", type: "circle", source: "construction", filter: ["==", ["get", "kind"], "building"], paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 4, 16, 8],
        "circle-color": ["step", ["coalesce", ["get", "yearBuilt"], 0], "#9bb8ae", 2021, "#5f9c8a", 2023, "#2f7d6b", 2025, "#c27c2c"],
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2,
      } });
      map.addLayer({ id: "building-selected", type: "circle", source: "construction",
        filter: ["==", ["get", "id"], ""], paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 8, 16, 13], "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#143f32", "circle-stroke-width": 3 } });
      map.on("click", "areas", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const { geographyId, name } = feature.properties as { geographyId: number; name: string };
        handlers.current.onArea(Number(geographyId), String(name));
        map.easeTo({ center: (feature.geometry as Point).coordinates as [number, number], zoom: BUILDING_ZOOM + 0.6 });
      });
      map.on("click", "buildings", (event) => {
        const id = event.features?.[0]?.properties?.id;
        if (id) handlers.current.onBuilding(String(id));
      });
      for (const layer of ["areas", "buildings"]) {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      }
      map.fire("moveend");
    });
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller = new AbortController();
    const refresh = () => {
      clearTimeout(timer);
      controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      timer = setTimeout(() => {
        const bounds = map.getBounds();
        setStatus("loading");
        loadConstructionMap(filter, [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
          map.getZoom(), signal).then((response) => {
          if (signal.aborted) return;
          (map.getSource("construction") as GeoJSONSource | undefined)?.setData(toGeoJSON(response));
          setLevel(response.level);
          setTruncated(response.truncated);
          setStatus("ready");
        }).catch(() => { if (!signal.aborted) setStatus("offline"); });
      }, 200);
    };
    map.on("moveend", refresh);
    if (map.loaded()) refresh();
    return () => { clearTimeout(timer); controller.abort(); map.off("moveend", refresh); };
  }, [filter]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer("building-selected")) map.setFilter("building-selected", ["==", ["get", "id"], selectedEid ?? ""]);
  }, [selectedEid]);

  return <div className={styles.mapPanel}>
    <div ref={container} className={styles.map} aria-label="Zemljevid vpisanih novih stavb" role="region"/>
    <div className={styles.mapStatus} role="status">
      {status === "offline" ? "Zemljevida ni bilo mogoče osvežiti." : status === "loading" ? "Osvežujem …"
        : level === "municipality" ? "Občine · število novih stavb · povečajte za posamezne stavbe"
          : `Posamezne stavbe${truncated ? " · prikazanih prvih 3000, povečajte" : ""}`}
    </div>
    {level === "building" && <div className={styles.legend} aria-label="Leto izgradnje">
      <span><i style={{ background: "#9bb8ae" }}/>do 2020</span><span><i style={{ background: "#5f9c8a" }}/>2021–22</span>
      <span><i style={{ background: "#2f7d6b" }}/>2023–24</span><span><i style={{ background: "#c27c2c" }}/>2025–26</span>
    </div>}
  </div>;
}
