"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { loadRecentTransactions, type RecentTransactionsResult } from "@/lib/recent-transactions";
import { decimal, euro } from "@/lib/display-values";
import type { MarketConstraints, MarketContext, MarketMode, PropertyGroup, YearRange } from "@/lib/types";

const PAGE_SIZE = 5;

export function RecentTransactions({ mode, propertyGroup, geographyId, name, years, area, onChange }: {
  mode: MarketMode; propertyGroup: PropertyGroup; geographyId?: number; name: string;
  years: YearRange; area: MarketConstraints; onChange: (context: MarketContext) => void;
}) {
  const [result, setResult] = useState<RecentTransactionsResult>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [direction, setDirection] = useState<"highest" | "lowest">("highest");
  const [page, setPage] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(false); setResult(undefined); setPage(0); } });
    loadRecentTransactions(mode, propertyGroup, geographyId, years, controller.signal, area)
      .then((value) => { if (!controller.signal.aborted) setResult(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mode, propertyGroup, geographyId, years, area]);
  const date = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString("sl-SI", { timeZone: "UTC" });
  return <section className="recent-transactions" aria-label="Nedavni posli v območju" aria-busy={loading}>
    <h3>Nedavni posli · {name}</h3>
    <p>Do 10 najvišjih in 10 najnižjih skupnih {mode === "sale" ? "cen" : "mesečnih najemnin"}.
      Reprezentativni dejansko sklenjeni posli, ne oglaševane cene. Isti posel je lahko na obeh seznamih.</p>
    {loading && <p role="status">Iščem nedavne posle v izbranem območju …</p>}
    {error && <p role="alert">Nedavnih poslov ni bilo mogoče naložiti.</p>}
    {result && <><p>{date(result.from)}–{date(result.to)}{result.expanded ? " · obdobje razširjeno zaradi majhnega števila poslov" : " · zadnji trije koledarski meseci izbranega obdobja"}.
      {" "}Filtri območja, površine in vrste nepremičnine ostanejo upoštevani.</p>
      {result.items.length === 0 ? <p>V izbranem obdobju ni ustreznih reprezentativnih poslov s ceno.</p>
        : <>
          <div className="recent-switch" role="group" aria-label="Razvrstitev poslov">
            {(["highest", "lowest"] as const).map((value) => <button type="button" key={value}
              aria-pressed={direction === value} onClick={() => { setDirection(value); setPage(0); }}>
              {value === "highest" ? "Najvišje" : "Najnižje"} {mode === "sale" ? "prodaje" : "najemnine"}
              <span>{result.items.filter((item) => item.direction === value).length}</span>
            </button>)}
          </div>
          {(() => {
            const rows = result.items.filter((item) => item.direction === direction);
            const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
            const current = Math.min(page, pages - 1);
            const visible = rows.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE);
            const first = rows.length === 0 ? 0 : current * PAGE_SIZE + 1;
            return <>
              {rows.length === 0 ? <p>Ni poslov na tem seznamu.</p> : <div className="recent-list">
                {visible.map((item) => <button className="recent-transaction" type="button" key={item.transactionId}
                  aria-label={`Odpri ${mode === "sale" ? "prodajo" : "najem"} #${item.transactionId}`}
                  onClick={() => onChange({ kind: "transaction", mode, id: item.transactionId })}>
                  <span>#{item.transactionId} · {item.contractDate ? date(item.contractDate) : "Datum ni znan"}</span>
                  <strong>{item.amount == null ? "—" : euro.format(item.amount)}{mode === "rent" ? " / mesec" : ""}</strong>
                  <small>{item.area == null ? "Površina ni znana" : `${decimal.format(item.area)} m²`}</small>
                  <small>{decimal.format(item.amountPerSqm)} €/m²{mode === "rent" ? " / mesec" : ""} →</small>
                </button>)}
              </div>}
              {pages > 1 && <nav className="recent-pager" aria-label="Strani seznama">
                <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}
                  aria-label={`Prejšnjih ${PAGE_SIZE} poslov`}><ChevronLeft aria-hidden="true" size={16}/> Prejšnji</button>
                <span aria-live="polite">{first}–{first + visible.length - 1} od {rows.length}</span>
                <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}
                  aria-label={`Naslednjih ${PAGE_SIZE} poslov`}>Naslednji <ChevronRight aria-hidden="true" size={16}/></button>
              </nav>}
            </>;
          })()}
        </>}</>}
  </section>;
}
