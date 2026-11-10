import { describe, expect, it } from "vitest";
import { DEFAULT_STATE, hasBadArea, hrefWith, pageOf, parseHash, toHash, transactionHref, type ExplorerState } from "./url-state";

describe("explorer address", () => {
  it("round-trips every part of the state", () => {
    const state: ExplorerState = { ...DEFAULT_STATE, g: 269, building: { ko: 1739, st: "1354" }, selected: { kind: "rent", id: 5 }, group: "land", landScope: "forest",
      landChosen: true, street: "Celovška cesta", years: "2019-2021", layer: "rentPrice", extrude: true, value: true };
    expect(parseHash(toHash(state))).toEqual({ ...state, size: undefined });
    const flats: ExplorerState = { ...DEFAULT_STATE, group: "house", size: "100-150", years: 3 };
    expect(toHash(flats)).toBe("#?vrsta=hise&m2=100-150&obdobje=3");
    expect(parseHash(toHash(flats))).toEqual({ ...flats, g: undefined, building: undefined, selected: undefined, street: undefined });
  });
  it("writes the defaults as nothing and drops invalid parts", () => {
    expect(toHash(DEFAULT_STATE)).toBe("#");
    expect(toHash(parseHash("#?obdobje=7&od=2021&do=2019&m2=45-70&vrsta=garaze&raba=gozdna"))).toBe("#?vrsta=garaze");
    expect(parseHash("#?sloj=nonsense").layer).toBe("salePrice");
    expect(hasBadArea("#?g=abc")).toBe(true);
    expect(hasBadArea("#?g=133")).toBe(false);
  });
  it("builds links from the current state and names the page of a URL", () => {
    expect(hrefWith({ selected: { kind: "sale", id: 9 } }, "#?g=133&vrsta=hise")).toBe("#?g=133&posel=9&vrsta=hise");
    expect(transactionHref({ kind: "rent", id: 4 })).toBe("#?najem=4");
    expect(pageOf("http://x/#trendi?g=1")).toBe("trendi");
    expect(pageOf("http://x/#o-podatkih")).toBe("o-podatkih");
    expect(pageOf("http://x/#?g=1")).toBe("explorer");
    expect(pageOf("http://x/")).toBe("explorer");
  });
});
