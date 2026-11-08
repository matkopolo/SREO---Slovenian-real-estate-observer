import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DirectComparable } from "@/lib/types";
import { DirectComparables } from "./direct-comparables";

const item: DirectComparable = {
  transactionId: 12, contractDate: "2025-03-14", contractYear: 2025,
  area: 60, amount: 180000, amountPerSqm: 3000, areaDifferencePercent: 10,
  amountPerSqmDifferencePercent: 50, yearDifference: 0,
  matchTier: "same_building_same_year_area_15", isRepresentative: true,
};
afterEach(cleanup);

describe("DirectComparables", () => {
  it("preserves all evidence and uses the same zero-based scale across cards", () => {
    const onChange = vi.fn();
    render(<DirectComparables items={[item, { ...item, transactionId: 13, amountPerSqm: 4000 }]}
      selectedAmountPerSqm={2000} mode="sale" onChange={onChange}/>);
    const card = screen.getByRole("button", { name: "Odpri primerljivi posel #12" });
    for (const value of ["2025-03-14", "180.000 €", "3000 €/m²", "60 m²", "+10 %", "+50 %", "Reprezentativen posel", "Ista stavba · isto leto · površina ±15 %"]) {
      expect(card).toHaveTextContent(value);
    }
    const bars = card.querySelectorAll("figure i");
    expect(bars[0]).toHaveStyle({ width: "50%" });
    expect(bars[1]).toHaveStyle({ width: "75%" });
    expect(within(card).getByText("Izbrani posel")).toBeInTheDocument();
    expect(screen.getByText(/brez časovne prilagoditve/)).toBeInTheDocument();
    fireEvent.click(card);
    expect(onChange).toHaveBeenCalledWith({ kind: "transaction", mode: "sale", id: 12 });
  });

  it("keeps source evidence without inventing a bar for a missing selected price", () => {
    const { container } = render(<DirectComparables items={[item]} mode="sale" onChange={vi.fn()}/>);
    expect(container.querySelector("figure")).toBeNull();
    expect(screen.getByText("180.000 €")).toBeInTheDocument();
  });

  it("labels rent monthly and keeps empty results distinct", () => {
    const view = render(<DirectComparables items={[item]} selectedAmountPerSqm={14} mode="rent" onChange={vi.fn()}/>);
    expect(screen.getByText("3000 €/m² / mesec")).toBeInTheDocument();
    view.rerender(<DirectComparables items={[]} mode="rent" onChange={vi.fn()}/>);
    expect(screen.getByText(/ni primerljivega posla/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
