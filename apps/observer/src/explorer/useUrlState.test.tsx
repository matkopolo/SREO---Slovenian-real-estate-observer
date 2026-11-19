import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, expect, it } from "vitest";
import { useUrlState } from "./useUrlState";

const panel = createRef<HTMLDivElement>();
const open = () => renderHook(() => useUrlState(panel));
const popstate = () => act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });

beforeEach(() => { window.history.replaceState(null, "", "/"); });

it("reads the address, pushes a history entry per navigation and replaces on request", () => {
  window.location.hash = "#?g=133&vrsta=hise";
  const { result } = open();
  expect(result.current.state).toMatchObject({ g: 133, group: "house" });
  const before = window.history.length;
  act(() => result.current.navigate({ g: 137 }));
  expect(window.location.hash).toBe("#?g=137&vrsta=hise");
  expect(window.history.length).toBe(before + 1);
  act(() => result.current.navigate({ years: 3 }, true));
  expect(window.location.hash).toBe("#?g=137&vrsta=hise&obdobje=3");
  expect(window.history.length).toBe(before + 1);                 // replaced, not pushed
});

it("drops a street filter when the area changes, and keeps it when the street is set with the area", () => {
  window.location.hash = "#?g=133&ulica=Celovška+cesta";
  const { result } = open();
  act(() => result.current.navigate({ g: 137 }));
  expect(result.current.state.street).toBeUndefined();
  act(() => result.current.navigate({ g: 133, street: "Dunajska cesta" }));
  expect(result.current.state).toMatchObject({ g: 133, street: "Dunajska cesta" });
});

it("rewrites an invalid address to its canonical form on mount and follows Back/Forward", () => {
  window.location.hash = "#?obdobje=7&raba=gozdna&3d=1&g=133";
  const { result } = open();
  expect(window.location.hash).toBe("#?g=133");
  expect(window.history.length).toBeGreaterThan(0);
  act(() => result.current.navigate({ g: 137 }));
  window.history.replaceState(null, "", "#?g=133");             // what Back would leave in the address bar
  popstate();
  expect(result.current.state.g).toBe(133);
});

it("accepts an address with a building whose number carries a hyphen", () => {
  window.location.hash = "#?b=1734-1710-A";
  const { result } = open();
  expect(result.current.state.building).toEqual({ ko: 1734, st: "1710-A" });
  expect(window.location.hash).toBe("#?b=1734-1710-A");
});
