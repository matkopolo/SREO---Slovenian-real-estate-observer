import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("../scene/atlas-scene", () => ({ AtlasScene: vi.fn(() => { throw new Error("no WebGL in jsdom"); }) }));

const boundaries = { type: "FeatureCollection", features: [
  { type: "Feature", properties: { id: 133, name: "Ljubljana" }, geometry: { type: "Polygon", coordinates: [[[14.4, 46], [14.6, 46], [14.6, 46.1], [14.4, 46]]] } },
  { type: "Feature", properties: { id: 137, name: "Maribor" }, geometry: { type: "Polygon", coordinates: [[[15.6, 46.5], [15.7, 46.5], [15.7, 46.6], [15.6, 46.5]]] } },
  { type: "Feature", properties: { id: 140, name: "Hodoš" }, geometry: { type: "Polygon", coordinates: [[[16.3, 46.8], [16.4, 46.8], [16.4, 46.9], [16.3, 46.8]]] } },
] };
const sales = { type: "FeatureCollection", features: [
  { properties: { geographyId: 133, medianPricePerSqm: 4320.22, transactionCount: 1888, representativeCount: 1698 } },
  { properties: { geographyId: 137, medianPricePerSqm: 2650, transactionCount: 900, representativeCount: 820 } },
  { properties: { geographyId: 140, medianPricePerSqm: 900, transactionCount: 3, representativeCount: 3 } },
] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/geographies/boundaries") ? boundaries
      : url.includes("/data-status") ? { activeRelease: { analyticsSaleThrough: "2026-10-01T00:00:00Z" } }
        : url.includes("/map/geographies") ? sales : { items: [] };
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("falls back to a complete table without WebGL and withholds small samples", async () => {
  render(<App/>);
  expect(await screen.findByText(/3D prikaz v tem brskalniku ni na voljo/)).toBeInTheDocument();
  const table = await screen.findByRole("table");
  const rows = await within(table).findAllByRole("row");
  expect(rows[1]).toHaveTextContent("Ljubljana");          // sorted by value, highest first
  expect(rows[1]).toHaveTextContent("4320 €/m²");
  expect(within(table).getByRole("button", { name: "Hodoš" }).closest("tr")).toHaveTextContent("ni objavljeno"); // n=3 < 10
  expect(screen.getByText(/podatki GURS do 1\. 10\. 2026/)).toBeInTheDocument();
});

it("switches the measure and opens a municipality from the table", async () => {
  render(<App/>);
  await screen.findByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "Število prodaj stanovanj" }));
  expect(await screen.findByRole("heading", { level: 1, name: /Število prodaj stanovanj/ })).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/v1/map/geographies"))).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Maribor" }));
  expect(await screen.findByRole("heading", { name: "Maribor", level: 2 })).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/v1/affordability?geographyId=137"))).toBe(true);
  // The stubbed affordability/construction responses have an unexpected shape: the panel must keep rendering
  // (Vitest fails the run on the uncaught render error this used to cause).
  expect(await screen.findByText("Dostopnost za mediano plačo")).toBeInTheDocument();
});
