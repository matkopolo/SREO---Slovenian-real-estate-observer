import { useMemo, useState } from "react";
import type { MetricDefinition } from "../metrics";

interface Row { id: number; name: string; value: number | null; sample: number }
type Sort = "value" | "name";

/** The accessible equivalent of the 3D view: every municipality with its value and sample. */
export function DataTable({ rows, metric, selected, onSelect }: {
  rows: Row[]; metric: MetricDefinition; selected: number | null; onSelect: (id: number) => void;
}) {
  const [sort, setSort] = useState<Sort>("value");
  const [showAll, setShowAll] = useState(false);
  const sorted = useMemo(() => [...rows].sort((a, b) => sort === "name" ? a.name.localeCompare(b.name, "sl")
    : (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.name.localeCompare(b.name, "sl")), [rows, sort]);
  const visible = showAll ? sorted : sorted.slice(0, 15);
  return <section className="table-section" aria-labelledby="table-title">
    <header>
      <h2 id="table-title">Vse občine · {metric.label}</h2>
      <div className="segmented small" role="group" aria-label="Razvrsti">
        <button type="button" aria-pressed={sort === "value"} onClick={() => setSort("value")}>Po vrednosti</button>
        <button type="button" aria-pressed={sort === "name"} onClick={() => setSort("name")}>Po imenu</button>
      </div>
    </header>
    <div className="table-scroll">
      <table>
        <thead><tr><th scope="col">#</th><th scope="col">Občina</th><th scope="col">{metric.unit}</th><th scope="col">Vzorec</th></tr></thead>
        <tbody>{visible.map((row, index) => <tr key={row.id} aria-selected={row.id === selected}>
          <td>{index + 1}</td>
          <th scope="row"><button type="button" className="link" onClick={() => onSelect(row.id)}>{row.name}</button></th>
          <td>{row.value == null ? "ni objavljeno" : metric.format(row.value)}</td>
          <td>{row.sample.toLocaleString("sl-SI")}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {rows.length > 15 && <button type="button" className="ghost" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
      {showAll ? "Prikaži manj" : `Prikaži vseh ${rows.length} občin`}</button>}
  </section>;
}
