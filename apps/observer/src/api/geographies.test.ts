import { expect, it } from "vitest";
import { areaLabel, bboxOf, unionBbox } from "./geographies";

it("bounds a polygon and a multipolygon, and has no box for nothing", () => {
  expect(bboxOf({ type: "Polygon", coordinates: [[[14.4, 46], [14.6, 46], [14.6, 46.1], [14.4, 46]]] })).toEqual([14.4, 46, 14.6, 46.1]);
  expect(bboxOf({ type: "MultiPolygon", coordinates: [[[[1, 1], [2, 1], [2, 2], [1, 1]]], [[[-1, 5], [0, 5], [0, 6], [-1, 5]]]] })).toEqual([-1, 1, 2, 6]);
  expect(bboxOf({ type: "Polygon", coordinates: [] })).toBeUndefined();
  expect(bboxOf(null)).toBeUndefined();
  expect(bboxOf({ type: "Point", coordinates: [1, 2] })).toBeUndefined();
});

it("survives an outline with more vertices than a call takes arguments", () => {
  const ring = Array.from({ length: 300_000 }, (_, index) => [14 + (index % 1000) / 1000, 46 + Math.floor(index / 1000) / 1000]);
  expect(bboxOf({ type: "Polygon", coordinates: [ring] })).toEqual([14, 46, 14.999, 46.299]);
});

it("unions boxes and drops the register's common-noun prefixes", () => {
  expect(unionBbox([[1, 1, 2, 2], [0, 3, 1, 4]])).toEqual([0, 1, 2, 4]);
  expect(areaLabel("Četrtna skupnost Šiška")).toBe("Šiška");
  expect(areaLabel("Krajevna skupnost Kamnik")).toBe("Kamnik");
  expect(areaLabel("Ljubljana")).toBe("Ljubljana");
});
