import type { Geometry, Position } from "geojson";

/** Slovenia's approximate centre; the scene is built around it. */
export const ORIGIN = { lon: 14.82, lat: 46.12 };
const KM_PER_DEGREE_LAT = 111.32;
/** Scene units per kilometre (Slovenia spans roughly 250 × 160 km). */
const SCALE = 0.1;

/** Equirectangular projection corrected for latitude: x east, y north, in scene units. */
export function project([lon, lat]: Position): [number, number] {
  const cos = Math.cos((ORIGIN.lat * Math.PI) / 180);
  return [(lon - ORIGIN.lon) * KM_PER_DEGREE_LAT * cos * SCALE, (lat - ORIGIN.lat) * KM_PER_DEGREE_LAT * SCALE];
}

export type Ring = Array<[number, number]>;
export interface PlanarPolygon { outer: Ring; holes: Ring[] }

/** Drop the closing duplicate vertex and degenerate rings; keep counter-clockwise outers. */
function ring(positions: Position[]): Ring | null {
  const points = positions.map(project);
  const [first, last] = [points[0], points[points.length - 1]];
  if (first && last && first[0] === last[0] && first[1] === last[1]) points.pop();
  return points.length >= 3 ? points : null;
}

export function signedArea(points: Ring) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[(index + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Polygon or MultiPolygon → planar polygons with outer rings counter-clockwise, holes clockwise. */
export function planarPolygons(geometry: Geometry | null | undefined): PlanarPolygon[] {
  if (!geometry) return [];
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates]
    : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return polygons.flatMap((polygon) => {
    const [outerPositions, ...holePositions] = polygon;
    const outer = outerPositions ? ring(outerPositions) : null;
    if (!outer) return [];
    if (signedArea(outer) < 0) outer.reverse();
    const holes = holePositions.map(ring).filter((item): item is Ring => item !== null)
      .map((item) => (signedArea(item) > 0 ? item.reverse() : item));
    return [{ outer, holes }];
  });
}

/** Centroid of the largest outer ring (label/anchor position). */
export function anchor(polygons: PlanarPolygon[]): [number, number] {
  const largest = polygons.reduce<PlanarPolygon | undefined>((best, item) =>
    !best || Math.abs(signedArea(item.outer)) > Math.abs(signedArea(best.outer)) ? item : best, undefined);
  if (!largest) return [0, 0];
  const sum = largest.outer.reduce(([x, y], [px, py]) => [x + px, y + py], [0, 0]);
  return [sum[0] / largest.outer.length, sum[1] / largest.outer.length];
}
