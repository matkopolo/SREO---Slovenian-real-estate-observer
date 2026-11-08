import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadConstructionBuilding, loadConstructionSummary, loadPublicWorks, loadRegions,
  type ConstructionSummaryResponse,
} from "@/lib/construction-api";
import { ConstructionExplorer } from "./construction-explorer";

vi.mock("./construction-map", () => ({
  ConstructionMap: ({ onBuilding, onArea }: { onBuilding: (eid: string) => void; onArea: (id: number, name: string) => void }) =>
    <div><button type="button" onClick={() => onBuilding("100200000120012642")}>izberi stavbo</button>
      <button type="button" onClick={() => onArea(137, "Maribor")}>izberi občino</button></div>,
}));
vi.mock("@/lib/construction-api", async (original) => ({
  ...(await original<typeof import("@/lib/construction-api")>()),
  loadConstructionSummary: vi.fn(), loadPublicWorks: vi.fn(), loadConstructionBuilding: vi.fn(), loadRegions: vi.fn(),
}));

const year = new Date().getFullYear();
const summary: ConstructionSummaryResponse = {
  filter: { fromYear: year - 5, toYear: year, withDwellings: false },
  summary: {
    sourceDate: "2026-11-01",
    buildingsByYear: [{ year: year - 1, buildings: 3742, dwellings: 5491, grossFloorArea: 1 }, { year, buildings: 1713, dwellings: 3279, grossFloorArea: 1 }],
    permits: [{ year: String(year - 1), buildings: 5962, dwellings: 4383, floorArea: 1 }],
    permitsScope: "slovenia", publicWorksLast12Months: 1834, publicWorksAwardsLast12Months: 1079, publicWorksScope: "slovenia",
  },
  sources: [{ name: "GURS, Kataster nepremičnin — stavbe", licence: "CC BY 4.0", note: "Vpisane stavbe." }],
};

beforeEach(() => {
  window.history.replaceState(null, "", "/gradbeni-projekti");
  vi.mocked(loadRegions).mockResolvedValue({ items: [{ id: 2, level: "statistical_region", name: "Podravska" }] });
  vi.mocked(loadConstructionSummary).mockResolvedValue(summary);
  vi.mocked(loadPublicWorks).mockResolvedValue({ total: 23, limit: 10, offset: 0, items: [{
    publicationNumber: "3680-2026", noticeType: "can-standard", publicationDate: "2026-01-08",
    title: "Slovenija – Gradbena dela – UKC Maribor", buyer: "UKC MARIBOR", winners: ["KLEPARSTVO TISAJ d.o.o."],
    regions: ["Podravska"], value: 125000, currency: "EUR", url: "https://ted.europa.eu/sl/notice/-/detail/3680-2026" }] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("summarises official sources without presenting registrations as construction in progress", async () => {
  render(<ConstructionExplorer/>);
  expect(await screen.findByText("5455")).toBeInTheDocument();           // 3742 + 1713 registered buildings
  expect(screen.getByText("5962")).toBeInTheDocument();                  // SURS permits, latest year
  expect(screen.getByText("1834")).toBeInTheDocument();                  // TED notices, 12 months
  expect(screen.getByText(/ne gradnje v teku/)).toBeInTheDocument();
  expect(screen.getByText(/Zasebni projekti v gradnji niso javno dostopni/)).toBeInTheDocument();
  const notice = await screen.findByText("Gradbena dela – UKC Maribor");
  expect(notice.closest("li")).toHaveTextContent("Oddano naročilo");
  expect(notice.closest("li")).toHaveTextContent("izvajalec: KLEPARSTVO TISAJ d.o.o.");
  expect(screen.getByRole("link", { name: /Objava 3680-2026/ })).toHaveAttribute("href", expect.stringContaining("ted.europa.eu"));
});

it("filters by area and year and keeps the view in the URL", async () => {
  render(<ConstructionExplorer/>);
  await screen.findByText("5455");
  fireEvent.change(screen.getByLabelText("Območje"), { target: { value: "2" } });
  expect(loadConstructionSummary).toHaveBeenLastCalledWith(expect.objectContaining({ geographyId: 2 }), expect.any(AbortSignal));
  fireEvent.click(screen.getByLabelText("Samo stavbe s stanovanji"));
  expect(loadConstructionSummary).toHaveBeenLastCalledWith(expect.objectContaining({ withDwellings: true }), expect.any(AbortSignal));
  expect(window.location.search).toContain("geographyId=2");
  expect(window.location.search).toContain("withDwellings=true");
  fireEvent.click(screen.getByRole("button", { name: "izberi občino" }));
  expect(await screen.findByRole("heading", { name: "Maribor" })).toBeInTheDocument();
});

it("opens a building with cadastre facts and a link to its market evidence", async () => {
  vi.mocked(loadConstructionBuilding).mockResolvedValue({
    eid: "100200000120012642", cadastralCode: 658, buildingNumber: 1264, yearBuilt: 2026, floors: 4, dwellings: 0,
    businessUnits: 9, buildingType: "samostoječa stavba", loadBearingStructure: null, registrationStatus: "Katastrski vpis po ZKN",
    grossFloorArea: 1414.8, recordChangedOn: "2026-10-22", municipality: "Maribor", municipalityId: 137,
    longitude: 15.64, latitude: 46.56, saleTransactions: 1, rentalTransactions: 0, sourceDate: "2026-11-01",
  });
  render(<ConstructionExplorer/>);
  fireEvent.click(screen.getByRole("button", { name: "izberi stavbo" }));
  const heading = await screen.findByRole("heading", { name: "k. o. 658 · stavba 1264" });
  const panel = heading.closest("div")!.parentElement!.parentElement!;
  expect(within(panel).getByText("1414,8 m²")).toBeInTheDocument();
  expect(within(panel).getAllByText("ni podatka").length).toBeGreaterThan(0);     // unknown stays unknown
  expect(within(panel).getByText(/1 prodaj, 0 najemov/)).toBeInTheDocument();
  expect(within(panel).getByRole("link", { name: /Odpri stavbo v analitiki trga/ }))
    .toHaveAttribute("href", "/?context=building&cadastralCode=658&buildingNumber=1264");
  expect(window.location.search).toContain("building=100200000120012642");
});
