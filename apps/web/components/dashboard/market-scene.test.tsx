import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MarketScene } from "./market-scene";
import { mountMarketScene } from "./market-scene-renderer";

vi.mock("./market-scene-renderer", () => ({ mountMarketScene: vi.fn(() => ({ select: vi.fn(), dispose: vi.fn() })) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const points = [
  { period: "2024", transactionCount: 100, includedSampleSize: 80, medianPricePerSqm: 2500, isPublishable: true },
  { period: "2025", transactionCount: 17, includedSampleSize: 12, medianPricePerSqm: 5000, isPublishable: false, incomplete: true },
];
it("keeps the same data accessible without WebGL and suppresses withheld prices", () => {
  render(<MarketScene points={points} mode="sale" name="Ruše"/>);
  expect(mountMarketScene).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "2025 *" }));
  expect(screen.getAllByText("Ni objavljena").length).toBeGreaterThan(0);
  expect(screen.queryByText(/5000/)).not.toBeInTheDocument();
  expect(screen.getByText(/Nepopolno obdobje/)).toBeInTheDocument();
  expect(screen.getByRole("table")).toHaveTextContent("100");
});
it("loads on demand, disposes on unmount and handles GPU failure", async () => {
  const dispose = vi.fn();
  vi.mocked(mountMarketScene).mockReturnValueOnce({ select: vi.fn(), dispose });
  const view = render(<MarketScene points={points} mode="sale" name="Slovenija"/>);
  fireEvent.click(screen.getByRole("button", { name: "Vključi 3D pogled" }));
  await waitFor(() => expect(mountMarketScene).toHaveBeenCalled());
  view.unmount();
  expect(dispose).toHaveBeenCalled();
  vi.mocked(mountMarketScene).mockImplementationOnce(() => { throw new Error("no GPU"); });
  render(<MarketScene points={points} mode="sale" name="Slovenija"/>);
  fireEvent.click(screen.getByRole("button", { name: "Vključi 3D pogled" }));
  expect(await screen.findByRole("status")).toHaveTextContent("WebGL ni na voljo");
  expect(screen.getByRole("table")).toHaveTextContent("2024");
});

it("starts on the latest period and keeps the selected year when the range changes", () => {
  const view = render(<MarketScene points={points} mode="sale" name="Ruše"/>);
  expect(screen.getByRole("button", { name: "2025 *" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "2024" }));
  const wider = [{ period: "2023", transactionCount: 90, includedSampleSize: 70, medianPricePerSqm: 2400, isPublishable: true }, ...points];
  view.rerender(<MarketScene points={wider} mode="sale" name="Ruše"/>);
  expect(screen.getByRole("button", { name: "2024" })).toHaveAttribute("aria-pressed", "true");
});

it("recolours the existing scene instead of remounting it when the period changes", async () => {
  const handle = { select: vi.fn(), dispose: vi.fn() };
  vi.mocked(mountMarketScene).mockReturnValueOnce(handle);
  render(<MarketScene points={points} mode="sale" name="Ruše"/>);
  fireEvent.click(screen.getByRole("button", { name: "Vključi 3D pogled" }));
  await waitFor(() => expect(mountMarketScene).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "2024" }));
  expect(handle.select).toHaveBeenLastCalledWith(0);
  expect(mountMarketScene).toHaveBeenCalledTimes(1);
  expect(handle.dispose).not.toHaveBeenCalled();
});
