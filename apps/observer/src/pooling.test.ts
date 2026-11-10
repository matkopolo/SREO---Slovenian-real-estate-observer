import { expect, it } from "vitest";
import { pool } from "./pooling";

const value = (geographyId: number, sample: number, amount = 1000) => ({ geographyId, sample, value: amount });

it("keeps a period's own value from 30 sales, else borrows 3 then 5 years, else withholds it", () => {
  const period = [value(1, 40), value(2, 12), value(3, 8), value(4, 2)];
  const three = [value(2, 35, 1100), value(3, 20, 1200), value(4, 5)];
  const five = [value(2, 60, 1150), value(3, 31, 1300), value(4, 9)];
  expect(pool(period, [{ years: 3, values: three }, { years: 5, values: five }])).toEqual([
    value(1, 40),
    { ...value(2, 35, 1100), pooled: 3 },          // the shortest wider period that is enough
    { ...value(3, 31, 1300), pooled: 5 },
    { ...value(4, 2), value: null },               // the period's own count is kept for "premalo poslov (2)"
  ]);
});

it("uses the layer's own minimum (counts are published from one)", () => {
  expect(pool([value(1, 1)], [], 1)).toEqual([value(1, 1)]);
});
