import type { Polygon } from "geojson";
import type { Bbox } from "../api";

/** Metres to degrees around a point: planar, which is accurate enough at Slovenia's latitudes and these radii. */
const degrees = ([, lat]: [number, number], meters: number) => ({ dLat: meters / 111_320, dLon: meters / (111_320 * Math.cos((lat * Math.PI) / 180)) });

/** The box a circle of `meters` around `center` fits in: the map is fitted to it so the drawn circle is the frame. */
export function radiusBbox(center: [number, number], meters: number): Bbox {
  const { dLat, dLon } = degrees(center, meters);
  return [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat];
}

/** The same circle as a closed 72-point polygon, for the map's line layer. */
export function circlePolygon(center: [number, number], meters: number): Polygon {
  const { dLat, dLon } = degrees(center, meters);
  const ring: [number, number][] = [];
  for (let step = 0; step < 72; step++) {
    const angle = (step / 72) * 2 * Math.PI;
    ring.push([center[0] + dLon * Math.cos(angle), center[1] + dLat * Math.sin(angle)]);
  }
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}
