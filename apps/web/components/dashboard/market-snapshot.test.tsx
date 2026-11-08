import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarketSnapshot } from "./market-snapshot";

describe("MarketSnapshot", () => {
  it("uses explicit median and preserves sample evidence", () => {
    render(<MarketSnapshot title="Slovenija" mode="sale" propertyGroup="apartment"
      years={{ from: 2018, to: 2025 }} series={[]}
      overview={{ transactionCount: 100, eligibleCount: 90, includedSampleSize: 80,
        excludedOutlierCount: 10, medianPricePerSqm: 2500, medianPrice: 180000, medianArea: 65 }}/>)
    expect(screen.getByText("Mediana cene / m² · 2018–2025")).toBeInTheDocument();
    expect(screen.getByText("Sklenjeni posli · 2018–2025")).toBeInTheDocument();
    expect(screen.getByText(/ne trenutna tržna cena/)).toBeInTheDocument();
    expect(screen.getByText(/80 \/ 80 %/)).toBeInTheDocument();
    expect(screen.getByText(/10 izločenih statističnih odstopanj/)).toBeInTheDocument();
    expect(screen.getByText("Analizirano obdobje: 2018–2025")).toBeInTheDocument();
    expect(screen.getByText("Stanovanja · prodaja")).toBeInTheDocument();
  });

  it("names the compared periods, the data cutoff and an incomplete latest year", () => {
    render(<MarketSnapshot title="Slovenija" mode="sale" propertyGroup="apartment"
      years={{ from: 2024, to: 2026 }} dataThrough="2026-08-28T00:00:00Z"
      series={[
        { period: "2024", transactionCount: 50, includedSampleSize: 40, medianPricePerSqm: 2000 },
        { period: "2025", transactionCount: 50, includedSampleSize: 40, medianPricePerSqm: 2200 },
        { period: "2026", transactionCount: 20, includedSampleSize: 15, medianPricePerSqm: 9999, isPublishable: false },
      ]}
      overview={{ transactionCount: 120, eligibleCount: 100, includedSampleSize: 95,
        excludedOutlierCount: 5, medianPricePerSqm: 2100 }}/>);
    expect(screen.getByText("Sprememba 2024 → 2025")).toBeInTheDocument();
    expect(screen.getByText("+10 %")).toBeInTheDocument();
    expect(screen.getByText(/Zadnji objavljeni posli GURS: do 28\. 8\. 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/še ni zaključeno/)).not.toBeInTheDocument();
  });

  it("flags a change that ends in an incomplete year", () => {
    render(<MarketSnapshot title="Slovenija" mode="sale" years={{ from: 2025, to: 2026 }}
      series={[
        { period: "2025", transactionCount: 50, includedSampleSize: 40, medianPricePerSqm: 2000 },
        { period: "2026", transactionCount: 20, includedSampleSize: 15, medianPricePerSqm: 2100, incomplete: true },
      ]}
      overview={{ transactionCount: 70, eligibleCount: 60, includedSampleSize: 55,
        excludedOutlierCount: 5, medianPricePerSqm: 2050 }}/>);
    expect(screen.getByText("Sprememba 2025 → 2026 *")).toBeInTheDocument();
    expect(screen.getByText(/2026 še ni zaključeno/)).toBeInTheDocument();
  });
});
