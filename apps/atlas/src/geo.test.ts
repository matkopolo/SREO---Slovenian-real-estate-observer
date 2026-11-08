import { describe, expect, it } from "vitest";
import { anchor, planarPolygons, project, signedArea } from "./geo";
import { colorScale, heightScale, quantileBreaks } from "./metrics";

describe("projection and polygons", () => {
  it("projects the origin to zero and keeps east/north positive", () => {
    expect(project([14.82, 46.12])).toEqual([0, 0]);
    const [x, y] = project([15.65, 46.55]); // Maribor
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    // 1° of longitude is shorter than 1° of latitude at 46° N.
    expect(project([15.82, 46.12])[0]).toBeLessThan(project([14.82, 47.12])[1]);
  });

  it("normalises winding, drops closing vertices and keeps holes", () => {
    const clockwise = [[14, 46], [14, 46.1], [14.1, 46.1], [14.1, 46], [14, 46]];
    const hole = [[14.02, 46.02], [14.08, 46.02], [14.08, 46.08], [14.02, 46.08], [14.02, 46.02]];
    const [polygon] = planarPolygons({ type: "Polygon", coordinates: [clockwise, hole] });
    expect(polygon.outer).toHaveLength(4);
    expect(signedArea(polygon.outer)).toBeGreaterThan(0);
    expect(signedArea(polygon.holes[0])).toBeLessThan(0);
  });

  it("handles multipolygons, empty and unsupported geometries", () => {
    const square = (lon: number) => [[[lon, 46], [lon + 0.1, 46], [lon + 0.1, 46.1], [lon, 46.1], [lon, 46]]];
    expect(planarPolygons({ type: "MultiPolygon", coordinates: [square(14), square(15)] })).toHaveLength(2);
    expect(planarPolygons({ type: "Point", coordinates: [14, 46] })).toEqual([]);
    expect(planarPolygons(null)).toEqual([]);
    expect(anchor([])).toEqual([0, 0]);
  });
});

describe("scales", () => {
  it("keeps heights linear from zero and gives withheld values a minimal plinth", () => {
    const height = heightScale([1000, 2000, null], 6);
    expect(height(2000)).toBeCloseTo(6.15);
    expect(height(1000)).toBeCloseTo(3.15);
    expect(height(null)).toBe(0.15);
  });

  it("uses quantile colour bins, a neutral colour for withheld values, and monotone breaks", () => {
    const values = [100, 200, 300, 400, 500, 600, 4000, null];
    const color = colorScale(values, false);
    expect(color(null)).toBe("#c9cdd1");
    expect(color(100)).not.toBe(color(4000));
    expect(color(600)).not.toBe(color(100));
    const breaks = quantileBreaks(values);
    expect(breaks).toEqual([...breaks].sort((a, b) => a - b));
    expect(breaks.at(-1)).toBe(4000);
  });
});
