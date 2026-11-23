import { useEffect, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { Geometry, Position } from "geojson";
import { decimal1, integer, month, upTo1, withUnit } from "../format";
import { LOCALE, t } from "../i18n";
import { emptyChart, tooFew } from "./Missing";
import "./charts-extra.css";

/** Rendered width of a chart, so the SVG viewBox matches CSS pixels and 11 px text stays 11 px. */
function useWidth(fallback: number) {
  // A callback ref: the figure may mount after a "no data" first render, and the observer must follow it.
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const next = Math.round(entry.contentRect.width); if (next > 0) setWidth(next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width] as const;
}

const number = { format: integer };

/**
 * Series styles. A series takes the hue of its family of measure (palette.ts): prices `c-price` (a second price series
 * `c-price-alt`, dashed), rents `c-rent`, money `c-money`. Reference areas are grey: the region `ref-region` (long dash),
 * Slovenia `ref-country` (dotted). `s1`–`s3` stay for comparisons without a family (areas the reader added).
 */
export type SeriesStyle = "c-price" | "c-price-alt" | "c-rent" | "c-money" | "ref-region" | "ref-country" | "ref" | "accent" | "s1" | "s2" | "s3";
interface Series { name: string; /** A `SeriesStyle`. */ className: string; points: Array<{ x: number; y: number | null }> }

/** Round axis steps (1, 2, 2.5 or 5 × 10ⁿ) so ticks read as 1.000 / 2.000 / 3.000. */
export function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step - 1e-9) }, (_, index) => Number(((index + 1) * step).toPrecision(12)));
}

/** Decimals a tick step needs so that no two labels round to the same text: 2.5 → 1, 0.25 → 2, 500 → 0. */
export function stepDecimals(step: number): number {
  for (let digits = 0; digits < 4; digits += 1) {
    const scaled = step * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return digits;
  }
  return 4;
}

/** The formatter for one axis: every label with the decimals of its step ("2,5 / 5,0 / 7,5 / 10,0"), thousands grouped. */
export function axisFormat(ticks: number[]): (value: number) => string {
  const step = ticks.length > 1 ? ticks[1] - ticks[0] : Math.abs(ticks[0] ?? 0) || 1;
  const digits = stepDecimals(step);
  const format = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: "always" });
  return (value: number) => format.format(value);
}

/** A value in a readout: whole numbers from 100 up, one decimal below. */
const readoutNumber = (value: number) => Math.abs(value) >= 100 ? integer(value) : upTo1(value);

/**
 * The hover and keyboard readout every chart shares: the pointer (or the arrow keys on the focused chart) picks one mark,
 * Escape and leaving clear it. Keyboard moves are announced in a polite status region rendered empty from the start.
 */
function useReadout(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const [announce, setAnnounce] = useState(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!count) return;
    const last = count - 1;
    const next = event.key === "ArrowRight" || event.key === "ArrowUp" ? (index == null ? 0 : Math.min(last, index + 1))
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? (index == null ? last : Math.max(0, index - 1))
      : event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setAnnounce(next != null);
    setIndex(next);
  };
  const point = (next: number | null) => { setAnnounce(false); setIndex(next); };
  return { index: index != null && index < count ? index : null, announce, onKeyDown, point, clear: () => point(null) };
}

/** Pointer position in the SVG's own units (the viewBox is as wide as the rendered chart, but CSS may scale it). */
function svgX(event: PointerEvent<SVGElement>, width: number) {
  const box = (event.currentTarget.ownerSVGElement ?? event.currentTarget).getBoundingClientRect();
  return box.width ? ((event.clientX - box.left) / box.width) * width : 0;
}

interface ReadoutRow { key: string; name?: string; className?: string; value: string }

/** The floating readout over a chart: a title (the year, the month, the price band) and one row per series. */
function Tooltip({ x, width, title, rows }: { x: number; width: number; title: string; rows: ReadoutRow[] }) {
  const flip = x > width / 2;
  return <div className={flip ? "chart-tip flip" : "chart-tip"} style={{ left: `${(x / width) * 100}%` }} aria-hidden="true">
    <strong>{title}</strong>
    {rows.map((row) => <span key={row.key} className="chart-tip-row">{row.className && <i className={row.className}/>}{row.name && <span className="chart-tip-name">{row.name}</span>}
      <span className="chart-tip-value">{row.value}</span></span>)}
  </div>;
}

/** The readout as one sentence for screen readers (announced only after a keyboard move). */
const sentence = (title: string, rows: ReadoutRow[]) => [title, ...rows.map((row) => row.name ? `${row.name}: ${row.value}` : row.value)].join("; ");

/** Multi-series line chart on one y scale (never two axes); legend always present for > 1 series, direct labels at the line ends for up to four. */
export function LineChart({ series, unit, label, height = 220, yMax, xLabel = (value: number) => String(Math.floor(value)), xTitle, legend = true, compact = false, kind = "sale", directLabels }: {
  series: Series[]; unit: string; label: string; height?: number; yMax?: number; xLabel?: (value: number) => string; legend?: boolean; compact?: boolean;
  /** How a point is named in the readout and the table (a month for monthly series); the axis label by default. */
  xTitle?: (value: number) => string;
  /** What a missing series lacks, for its legend note: sales or rentals. */
  kind?: "sale" | "rent";
  /** Name each line at its end (default: 2–4 series on a full-size chart). */
  directLabels?: boolean;
}) {
  const [ref, measured] = useWidth(compact ? 320 : 640);
  const xs = series.flatMap((item) => item.points.map((point) => point.x));
  const ys = series.flatMap((item) => item.points.flatMap((point) => point.y == null ? [] : [point.y]));
  const steps = [...new Set(xs)].sort((a, b) => a - b);
  const pick = useReadout(steps.length);
  if (!xs.length || !ys.length) return <figure className="chart" ref={ref}><p className="note muted">{emptyChart()}</p></figure>;
  const visible = series.filter((item) => item.points.some((point) => point.y != null));
  const labelled = (directLabels ?? (!compact && visible.length > 1 && visible.length <= 4)) && visible.length > 0;
  const longest = Math.max(0, ...visible.map((item) => Math.min(18, item.name.length)));
  const width = Math.max(220, measured);
  const basePad = compact ? { top: 10, right: 12, bottom: 22, left: 44 } : { top: 14, right: 16, bottom: 26, left: 52 };
  const ticks = niceTicks(yMax ?? Math.max(...ys), compact ? 3 : 4);
  const tickText = axisFormat(ticks);
  // The left margin fits the longest tick label (12 px figures are about 7 px wide), so "12.500" is never clipped.
  const left = Math.max(basePad.left, 12 + Math.max(...ticks.map((tick) => tickText(tick).length)) * 7);
  const pad = { ...basePad, left, ...(labelled ? { right: Math.min(130, 14 + longest * 6.6) } : {}) };
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(0, ...ys), Math.max(ticks[ticks.length - 1], ...ys)];
  const x = (value: number) => pad.left + ((value - x0) / Math.max(1e-9, x1 - x0)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - y0) / Math.max(1e-9, y1 - y0)) * (height - pad.top - pad.bottom);
  // A year label is centred under its tick unless that would run past the edge: the first and last are nudged inside, so "2025" never ends as "202".
  const labelX = (value: number, text: string) => { const half = Math.max(8, text.length * 3.4); return Math.min(width - pad.right + 8 - half, Math.max(half, x(value))); };
  const title = xTitle ?? xLabel;
  const valueOf = (item: Series, at: number) => item.points.find((point) => point.x === at)?.y ?? null;
  const active = pick.index != null ? steps[pick.index] : null;
  const rows: ReadoutRow[] = active == null ? [] : series.map((item, index) => {
    const value = valueOf(item, active);
    return { key: String(index), name: item.name, className: item.className, value: value == null ? tooFew(kind) : withUnit(readoutNumber(value), unit) };
  });
  // Direct labels: at each line's last point, pushed apart so two close ends never overlap.
  const ends = labelled ? visible.map((item) => { const last = [...item.points].reverse().find((point) => point.y != null)!; return { item, y: y(last.y!) }; })
    .sort((a, b) => a.y - b.y) : [];
  for (let index = 1; index < ends.length; index += 1) ends[index].y = Math.max(ends[index].y, ends[index - 1].y + 12);
  const nearest = (event: PointerEvent<SVGElement>) => {
    const at = svgX(event, width);
    let best = 0;
    for (const [index, value] of steps.entries()) if (Math.abs(x(value) - at) < Math.abs(x(steps[best]) - at)) best = index;
    pick.point(best);
  };
  return <figure className="chart has-readout" ref={ref}>
    {legend && series.length > 1 && <ul className="chart-legend">{series.map((item, index) => <li key={index}><i className={item.className}/>{item.name}
      {visible.includes(item) ? "" : ` (${tooFew(kind)})`}</li>)}</ul>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} tabIndex={0} onKeyDown={pick.onKeyDown} onBlur={pick.clear}>
      {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid"/>
        <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="axis">{tickText(tick)}</text></g>)}
      <line x1={pad.left} x2={width - pad.right} y1={y(y0)} y2={y(y0)} className="baseline"/>
      {(x0 === x1 ? [x0] : [x0, (x0 + x1) / 2, x1]).map((tick) => { const text = xLabel(tick);
        return <text key={tick} x={labelX(tick, text)} y={height - 8} textAnchor="middle" className="axis">{text}</text>; })}
      {series.map((item, index) => {
        const segments: string[] = [];
        let open = false;
        for (const point of item.points) {
          if (point.y == null) { open = false; continue; }
          segments.push(`${open ? "L" : "M"}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`);
          open = true;
        }
        const last = [...item.points].reverse().find((point) => point.y != null);
        return <g key={index} className={item.className}>
          <path d={segments.join(" ")} className="series"/>
          {last && <circle cx={x(last.x)} cy={y(last.y!)} r={3.5} className="series-end"/>}
        </g>;
      })}
      {ends.map((end) => <text key={end.item.name} x={width - pad.right + 8} y={end.y + 4} className="direct-label">
        {end.item.name.length > 18 ? `${end.item.name.slice(0, 17)}…` : end.item.name}</text>)}
      {active != null && <g className="crosshair" aria-hidden="true">
        <line x1={x(active)} x2={x(active)} y1={pad.top} y2={height - pad.bottom}/>
        {series.map((item, index) => { const value = valueOf(item, active);
          return value == null ? null : <g key={index} className={item.className}><circle cx={x(active)} cy={y(value)} r={4} className="series-end"/></g>; })}
      </g>}
      {/* The hit area is the whole plot, far larger than the 2 px lines. */}
      <rect className="hit" x={pad.left} y={pad.top} width={Math.max(0, width - pad.left - pad.right)} height={Math.max(0, height - pad.top - pad.bottom)}
        onPointerMove={nearest} onPointerDown={nearest} onPointerLeave={pick.clear}/>
    </svg>
    {active != null && <Tooltip x={x(active)} width={width} title={title(active)} rows={rows}/>}
    <p className="sr-only" role="status">{active != null && pick.announce ? sentence(title(active), rows) : ""}</p>
    <figcaption className="sr-only">{t("{label}. Enota: {unit}.", { label, unit })}</figcaption>
    {/* A <table> ignores height:1px, so the visually-hidden wrapper must be a block element. */}
    <div className="sr-only"><table><thead><tr><th>{t("Leto")}</th>{series.map((item, index) => <th key={index}>{item.name}</th>)}</tr></thead>
      <tbody>{steps.map((value) => <tr key={value}><th>{title(value)}</th>
        {series.map((item, index) => { const point = valueOf(item, value); return <td key={index}>{point == null ? "—" : upTo1(point)}</td>; })}</tr>)}</tbody></table></div>
  </figure>;
}

/** 33.005 → 33.000, 1.234.567 → 1.200.000: two significant digits, so the end labels of a histogram read as round prices. */
export const roundLabel = (value: number) => {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = 10 ** (Math.floor(Math.log10(Math.abs(value))) - 1);
  return Math.round(value / magnitude) * magnitude;
};

/** Two or three round values inside (lower, upper), clear of both ends, for a histogram's price axis. */
export function rangeTicks(lower: number, upper: number, count = 3): number[] {
  const span = upper - lower;
  if (!(span > 0)) return [];
  const raw = span / (count + 1);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let value = Math.ceil(lower / step) * step; value < upper; value += step) {
    if (value - lower > span * 0.12 && upper - value > span * 0.12) ticks.push(Number(value.toPrecision(12)));
  }
  return ticks.slice(0, count);
}

/** Histogram of a published distribution; bars share one zero-based count scale. An optional marker names one value (the median). */
export function Histogram({ buckets, unit, label, marker, format, open = { below: false, above: false }, kind = "sale" }: {
  buckets: Array<{ lower: number; upper: number; count: number }>; unit: string; label: string; marker?: { value: number; name: string };
  /** How an axis value reads ("33.005 €" / "€33,005"); by default the number and the unit. */
  format?: (value: number) => string;
  /** The first (last) bar also counts the transactions below (above) the drawn range: it is "≤" ("≥") its inner bound. */
  open?: { below: boolean; above: boolean };
  kind?: "sale" | "rent";
}) {
  const [ref, measured] = useWidth(640);
  const pick = useReadout(buckets.length);
  const axis = format ?? ((value: number) => withUnit(number.format(value), unit));
  if (!buckets.length) return <p className="note muted">{kind === "rent" ? t("Premalo najemov za graf.") : emptyChart()}</p>;
  const width = Math.max(240, measured);
  const height = 160;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const barWidth = (width - 40) / buckets.length;
  const lower = buckets[0].lower, upper = buckets[buckets.length - 1].upper;
  const last = buckets.length - 1;
  const at = (value: number) => 20 + ((value - lower) / Math.max(1e-9, upper - lower)) * (width - 40);
  // The marker's label has its own strip above the plot, so the tallest bar never runs through it; the marker itself
  // stays inside the plot (a median in a clipped tail sits at the edge rather than off the chart).
  const top = marker ? 18 : 0;
  const markerX = marker && upper > lower ? Math.min(width - 20, Math.max(20, at(marker.value))) : null;
  const band = (index: number) => {
    const bucket = buckets[index];
    if (index === 0 && open.below) return `≤ ${axis(bucket.upper)}`;
    if (index === last && open.above) return `≥ ${axis(bucket.lower)}`;
    return `${axis(bucket.lower)}–${axis(bucket.upper)}`;
  };
  const ticks = rangeTicks(lower, upper).filter((value) => markerX == null || Math.abs(at(value) - markerX) > 6);
  const active = pick.index;
  const rows: ReadoutRow[] = active == null ? [] : [{ key: "count", value: kind === "rent" ? t("{count} najemov", { count: integer(buckets[active].count) }) : t("{count} prodaj", { count: integer(buckets[active].count) }) }];
  return <figure className="chart has-readout" ref={ref}>
    <svg viewBox={`0 0 ${width} ${top + height + 22}`} role="img" aria-label={label} tabIndex={0} onKeyDown={pick.onKeyDown} onBlur={pick.clear}>
      {buckets.map((bucket, index) => {
        const h = (bucket.count / max) * height;
        return <rect key={index} x={20 + index * barWidth + 1} y={top + height - h} width={Math.max(1, barWidth - 2)} height={h} rx={2}
          className={index === active ? "bar is-active" : "bar"}/>;
      })}
      {markerX != null && marker && <g><line x1={markerX} x2={markerX} y1={top - 4} y2={top + height} className="marker"/>
        <text x={markerX > width - 120 ? markerX - 5 : markerX + 5} y={11} textAnchor={markerX > width - 120 ? "end" : "start"} className="marker-label">{marker.name}</text></g>}
      <line x1={20} x2={width - 20} y1={top + height} y2={top + height} className="baseline"/>
      {ticks.map((value) => <g key={value} aria-hidden="true"><line x1={at(value)} x2={at(value)} y1={top + height} y2={top + height + 4} className="baseline"/>
        <text x={at(value)} y={top + height + 16} textAnchor="middle" className="axis">{axis(value)}</text></g>)}
      <text x={20} y={top + height + 16} className="axis">{open.below ? `≤ ${axis(roundLabel(buckets[0].upper))}` : axis(roundLabel(lower))}</text>
      <text x={width - 20} y={top + height + 16} textAnchor="end" className="axis">{open.above ? `≥ ${axis(roundLabel(buckets[last].lower))}` : axis(roundLabel(upper))}</text>
      {/* One hit column per bucket, the full plot height, so a short bar is as easy to point at as a tall one. */}
      {buckets.map((_, index) => <rect key={`hit-${index}`} className="hit" x={20 + index * barWidth} y={0} width={barWidth} height={top + height}
        onPointerEnter={() => pick.point(index)} onPointerDown={() => pick.point(index)} onPointerLeave={pick.clear}/>)}
    </svg>
    {active != null && <Tooltip x={20 + (active + 0.5) * barWidth} width={width} title={band(active)} rows={rows}/>}
    <p className="sr-only" role="status">{active != null && pick.announce ? sentence(band(active), rows) : ""}</p>
    <div className="sr-only"><table><caption>{label}</caption><thead><tr><th>{t("Razpon ({unit})", { unit })}</th><th>{kind === "rent" ? t("Najemi") : t("Prodaje")}</th></tr></thead>
      <tbody>{buckets.map((bucket, index) => <tr key={index}><th>{band(index)}</th><td>{integer(bucket.count)}</td></tr>)}</tbody></table></div>
  </figure>;
}

function projector(bbox: [number, number, number, number], width: number, height: number) {
  const [west, south, east, north] = bbox;
  const cos = Math.cos((((south + north) / 2) * Math.PI) / 180);
  const scale = Math.min(width / ((east - west) * cos), height / (north - south));
  const offsetX = (width - (east - west) * cos * scale) / 2;
  const offsetY = (height - (north - south) * scale) / 2;
  return ([lon, lat]: Position) => [offsetX + (lon - west) * cos * scale, offsetY + (north - lat) * scale] as const;
}

/** Plain SVG locator: an optional outline plus sized dots, all on one projection. */
export function DotMap({ bbox, outline, layers, label, height = 260 }: {
  bbox: [number, number, number, number]; outline?: Geometry; label: string; height?: number;
  layers: Array<{ name: string; className: string; points: Array<{ at: [number, number]; size?: number }>; capped?: boolean; total?: number }>;
}) {
  const width = 640;
  const project = projector(bbox, width, height);
  const rings = !outline ? [] : outline.type === "Polygon" ? outline.coordinates
    : outline.type === "MultiPolygon" ? outline.coordinates.flat() : [];
  return <figure className="chart dotmap">
    <ul className="chart-legend">{layers.map((layer) => <li key={layer.name}><i className={layer.className}/>{layer.name} ({number.format(layer.total ?? layer.points.length)}{layer.capped ? "+" : ""})</li>)}</ul>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {rings.map((ring, index) => <path key={index} className="outline"
        d={ring.map((position, i) => `${i ? "L" : "M"}${project(position).map((v) => v.toFixed(1)).join(",")}`).join(" ") + "Z"}/>)}
      {layers.map((layer) => <g key={layer.name} className={layer.className}>{layer.points.map((point, index) => {
        const [cx, cy] = project(point.at);
        return <circle key={index} cx={cx} cy={cy} r={point.size ?? 2.6} className="dot"/>;
      })}</g>)}
    </svg>
  </figure>;
}

/** Population by five-year age group: filled bar = latest stock, outline = ten years earlier, one shared scale. */
export function Pyramid({ groups, period, earlierPeriod, label }: {
  groups: Array<{ group: string; population: number; earlier?: number | null }>; period: string; earlierPeriod?: string | null; label: string;
}) {
  const [ref, measured] = useWidth(640);
  if (!groups.length) return <p className="note muted">{t("Podatki SURS za to območje niso na voljo.")}</p>;
  const rows = [...groups].reverse(); // oldest on top
  const width = Math.max(260, measured);
  const row = 15;
  const pad = { left: 56, right: 70, top: 4 };
  const height = pad.top + rows.length * row + 4;
  const max = Math.max(1, ...groups.flatMap((item) => [item.population, item.earlier ?? 0]));
  const x = (value: number) => (value / max) * (width - pad.left - pad.right);
  return <figure className="chart pyramid" ref={ref}>
    <ul className="chart-legend">
      <li><i className="s1"/>{period.replace("H1", "")}</li>
      {earlierPeriod && <li><i className="outline-key"/>{earlierPeriod.replace("H1", "")}</li>}
    </ul>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {rows.map((item, index) => {
        const y = pad.top + index * row;
        return <g key={item.group}>
          <text x={pad.left - 8} y={y + row - 4} textAnchor="end" className="axis">{item.group}</text>
          <rect x={pad.left} y={y + 2} width={Math.max(1, x(item.population))} height={row - 4} rx={2} className="bar-now">
            <title>{item.group}: {number.format(item.population)}{item.earlier != null ? ` ${t("(prej {count})", { count: number.format(item.earlier) })}` : ""}</title></rect>
          {item.earlier != null && <line x1={pad.left + x(item.earlier)} x2={pad.left + x(item.earlier)} y1={y + 1} y2={y + row - 1} className="bar-earlier"/>}
          {(index % 4 === 0 || index === rows.length - 1) && <text x={pad.left + x(Math.max(item.population, item.earlier ?? 0)) + 6} y={y + row - 4} className="axis">{number.format(item.population)}</text>}
        </g>;
      })}
    </svg>
    <div className="sr-only"><table><thead><tr><th>{t("Starost")}</th><th>{period}</th><th>{earlierPeriod ?? t("prej")}</th></tr></thead>
      <tbody>{groups.map((item) => <tr key={item.group}><th>{item.group}</th><td>{number.format(item.population)}</td><td>{item.earlier == null ? "—" : number.format(item.earlier)}</td></tr>)}</tbody></table></div>
  </figure>;
}

/**
 * P25–P75 band with the median tick on a shared scale; optional markers (e.g. a building or parent areas).
 * The caption names the band as the middle half of transactions unless the caller says what it is (`caption`).
 * The first marker is the subject (filled, in the subject's coral); further markers are rings of the same colour.
 */
export function RangeBar({ p25, p50, p75, min, max, unit, markers = [], label, caption }: {
  p25: number; p50: number; p75: number; min: number; max: number; unit: string; label: string;
  markers?: Array<{ value: number; name: string }>; caption?: string;
}) {
  const span = Math.max(1e-9, max - min);
  const at = (value: number) => `${Math.min(100, Math.max(0, ((value - min) / span) * 100))}%`;
  const format = { format: /mesec|month/.test(unit) ? upTo1 : integer };
  return <figure className="range-bar" aria-label={label}>
    <div className="range-track">
      <span className="range-band" style={{ left: at(p25), width: `calc(${at(p75)} - ${at(p25)})` }}/>
      <span className="range-median" style={{ left: at(p50) }}/>{/* i18n-ignore (code, not text) */}
      {markers.map((marker, index) => <span key={index} className={index ? "range-marker subject-marker alt" : "range-marker subject-marker"} style={{ left: at(marker.value) }}/>)}{/* i18n-ignore (code, not text) */}
    </div>
    <figcaption>{caption ?? t("Srednja polovica poslov: {low}–{high}", { low: format.format(p25), high: withUnit(format.format(p75), unit) })}
      {markers.length > 0 && <>; {markers.map((marker, index) => <span key={index} className="range-marker-name">{index ? ", " : ""}<i className={index ? "subject-key alt" : "subject-key"} aria-hidden="true"/>{marker.name} {withUnit(format.format(marker.value), unit)}</span>)}</>}</figcaption>
  </figure>;
}

/** Positions of a few areas on one value scale; names are listed below the strip so close values never collide. */
export function ScaleStrip({ items, unit, label }: { items: Array<{ name: string; value: number; current?: boolean }>; unit: string; label: string }) {
  if (!items.length) return null;
  const max = Math.max(...items.map((item) => item.value)) * 1.1;
  const format = { format: decimal1 };
  return <figure className="scale-strip" aria-label={label}>
    <div className="scale-track" aria-hidden="true">{items.map((item, index) => <span key={index} className={item.current ? "scale-dot current" : "scale-dot"}
      style={{ left: `${(item.value / max) * 100}%` }}/>)}</div>
    <div className="scale-axis" aria-hidden="true"><span>0</span><span>{withUnit(format.format(max), unit)}</span></div>
    <figcaption><ul className="scale-names">{items.map((item, index) => <li key={index} className={item.current ? "current" : undefined}>
      <i className={item.current ? "scale-key current" : "scale-key"}/>{item.name} {format.format(item.value)}</li>)}</ul>
      <span className="sr-only">{unit}</span></figcaption>
  </figure>;
}

/** A tile's trend: recent values as one grey line with the latest as an accent dot; no axes (the tile's value and change carry the numbers). */
export function Sparkline({ points, label }: { points: Array<number | null>; label: string }) {
  const width = 96, height = 28;
  const known = points.flatMap((value, index) => value == null ? [] : [{ value, index }]);
  if (known.length < 2) return null;
  const min = Math.min(...known.map((item) => item.value)), max = Math.max(...known.map((item) => item.value));
  const x = (index: number) => 3 + (index / Math.max(1, points.length - 1)) * (width - 6);
  const y = (value: number) => max === min ? height / 2 : height - 4 - ((value - min) / (max - min)) * (height - 8);
  const segments: string[] = [];
  let open = false;
  for (const [index, value] of points.entries()) {
    if (value == null) { open = false; continue; }
    segments.push(`${open ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`);
    open = true;
  }
  const path = segments.join(" ");
  const last = known[known.length - 1];
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
    <path d={path} className="spark-line"/>
    <circle cx={x(last.index)} cy={y(last.value)} r={3} className="spark-end"/>
  </svg>;
}

/** Ranked horizontal bars in one hue, in the caller's order: the name (a link when given), the bar and the value at its tip. */
export function Bars({ items, label, format, max, tone = "price" }: {
  items: Array<{ key: string | number; name: ReactNode; value: number; href?: string; note?: string; current?: boolean; pooled?: boolean }>;
  label: string; format: (value: number) => string; max?: number;
  /** The family of measure the bars show, for their hue. */
  tone?: "price" | "rent" | "money";
}) {
  if (!items.length) return <p className="note muted">{emptyChart()}</p>;
  const top = Math.max(1e-9, max ?? Math.max(...items.map((item) => item.value)));
  return <ol className={`bars tone-${tone}`} aria-label={label}>{items.map((item) => <li key={item.key}
    className={[item.current ? "current" : "", item.pooled ? "pooled" : ""].filter(Boolean).join(" ") || undefined}>
    <span className="bar-name">{item.href ? <a href={item.href}>{item.name}</a> : item.name}</span>
    <span className="bar-track" aria-hidden="true"><i style={{ width: `${Math.max(1, (item.value / top) * 100)}%` }}/></span>
    <span className="bar-value">{format(item.value)}{item.note ? <small> {item.note}</small> : null}</span>
  </li>)}</ol>;
}

/** A column with a rounded top and a square base. */
const column = (x: number, top: number, width: number, bottom: number) => {
  const r = Math.min(4, width / 2, Math.max(0, bottom - top));
  return `M${x},${bottom} V${top + r} A${r},${r} 0 0 1 ${x + r},${top} H${x + width - r} A${r},${r} 0 0 1 ${x + width},${top + r} V${bottom} Z`; // i18n-ignore (SVG path commands)
};

/**
 * Monthly counts as columns on one zero-based scale; months still being reported are drawn in a lighter step of the
 * same hue and say so in the readout and the table. A year label sits under each January.
 */
export function Columns({ items, unit, label }: { items: Array<{ period: string; value: number; incomplete?: boolean }>; unit: string; label: string }) {
  const [ref, measured] = useWidth(640);
  const pick = useReadout(items.length);
  if (!items.length) return <p className="note muted">{emptyChart()}</p>;
  const width = Math.max(240, measured);
  const height = 150;
  const ticks = niceTicks(Math.max(1, ...items.map((item) => item.value)), 3);
  const tickText = axisFormat(ticks);
  const pad = { left: Math.max(40, 12 + Math.max(...ticks.map((tick) => tickText(tick).length)) * 7), right: 8, top: 8, bottom: 24 };
  const top = ticks[ticks.length - 1];
  const slot = (width - pad.left - pad.right) / items.length;
  const bar = Math.min(24, Math.max(2, slot - 2));
  const y = (value: number) => pad.top + (1 - value / top) * (height - pad.top - pad.bottom);
  const active = pick.index;
  const still = t("še se dopolnjuje");
  const rows: ReadoutRow[] = active == null ? [] : [{ key: "value", value: `${withUnit(number.format(items[active].value), unit)}${items[active].incomplete ? ` (${still})` : ""}` }];
  return <figure className="chart has-readout" ref={ref}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} tabIndex={0} onKeyDown={pick.onKeyDown} onBlur={pick.clear}>
      {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid"/>
        <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="axis">{tickText(tick)}</text></g>)}
      {items.map((item, index) => {
        const x = pad.left + index * slot + (slot - bar) / 2;
        return <g key={item.period}>
          <path d={column(x, y(item.value), bar, y(0))} className={[item.incomplete ? "column incomplete" : "column", index === active ? "is-active" : ""].filter(Boolean).join(" ")}/>
          {item.period.slice(5, 7) === "01" && <text x={x + bar / 2} y={height - 6} textAnchor="middle" className="axis">{item.period.slice(0, 4)}</text>}
        </g>;
      })}
      <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="baseline"/>
      {/* One hit column per month, the full plot height. */}
      {items.map((item, index) => <rect key={`hit-${item.period}`} className="hit" x={pad.left + index * slot} y={pad.top} width={slot} height={height - pad.top - pad.bottom}
        onPointerEnter={() => pick.point(index)} onPointerDown={() => pick.point(index)} onPointerLeave={pick.clear}/>)}
    </svg>
    {active != null && <Tooltip x={pad.left + (active + 0.5) * slot} width={width} title={month(items[active].period)} rows={rows}/>}
    <p className="sr-only" role="status">{active != null && pick.announce ? sentence(month(items[active].period), rows) : ""}</p>
    <div className="sr-only"><table><thead><tr><th>{t("Mesec")}</th><th>{unit}</th></tr></thead>
      <tbody>{items.map((item) => <tr key={item.period}><th>{month(item.period)}</th><td>{number.format(item.value)}{item.incomplete ? ` (${still})` : ""}</td></tr>)}</tbody></table></div>
  </figure>;
}
