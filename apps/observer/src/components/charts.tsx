import { useEffect, useRef, useState } from "react";
import type { Geometry, Position } from "geojson";
import { decimal1, integer, upTo1 } from "../format";
import { t } from "../i18n";

/** Rendered width of a chart, so the SVG viewBox matches CSS pixels and 11 px text stays 11 px. */
function useWidth(fallback: number) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const next = Math.round(entry.contentRect.width); if (next > 0) setWidth(next); });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const number = { format: integer };
/** Small scales (land €/m², rents) need decimals, or the ticks read "0 / 1 / 1 / 1". */
const fine = { format: upTo1 };

interface Series { name: string; className: string; points: Array<{ x: number; y: number | null }> }

/** Round axis steps (1, 2, 2.5 or 5 × 10ⁿ) so ticks read as 1.000 / 2.000 / 3.000. */
function niceTicks(max: number, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  return Array.from({ length: Math.ceil(max / step) }, (_, index) => (index + 1) * step);
}

/** Multi-series line chart on one y scale (never two axes); legend always present for > 1 series. */
export function LineChart({ series, unit, label, height = 220, yMax, xLabel = (value: number) => String(Math.floor(value)), legend = true, compact = false }: {
  series: Series[]; unit: string; label: string; height?: number; yMax?: number; xLabel?: (value: number) => string; legend?: boolean; compact?: boolean;
}) {
  const [ref, measured] = useWidth(compact ? 320 : 640);
  const width = Math.max(220, measured);
  const pad = compact ? { top: 10, right: 12, bottom: 22, left: 44 } : { top: 14, right: 16, bottom: 26, left: 52 };
  const xs = series.flatMap((item) => item.points.map((point) => point.x));
  const ys = series.flatMap((item) => item.points.flatMap((point) => point.y == null ? [] : [point.y]));
  if (!xs.length || !ys.length) return <figure className="chart" ref={ref}><p className="muted">{t("Ni objavljivih podatkov.")}</p></figure>;
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const ticks = niceTicks(yMax ?? Math.max(...ys), compact ? 3 : 4);
  const [y0, y1] = [Math.min(0, ...ys), Math.max(ticks[ticks.length - 1], ...ys)];
  const x = (value: number) => pad.left + ((value - x0) / Math.max(1e-9, x1 - x0)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - y0) / Math.max(1e-9, y1 - y0)) * (height - pad.top - pad.bottom);
  const visible = series.filter((item) => item.points.some((point) => point.y != null));
  // A year label is centred under its tick unless that would run past the edge: the first and last are nudged inside, so "2025" never ends as "202".
  const labelX = (value: number, text: string) => { const half = Math.max(8, text.length * 3.4); return Math.min(width - half, Math.max(half, x(value))); };
  return <figure className="chart" ref={ref}>
    {legend && series.length > 1 && <ul className="chart-legend">{series.map((item, index) => <li key={index}><i className={item.className}/>{item.name}
      {visible.includes(item) ? "" : ` ${t("(premalo podatkov)")}`}</li>)}</ul>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {ticks.map((tick) => <g key={tick}><line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className="grid"/>
        <text x={pad.left - 6} y={y(tick) + 4} textAnchor="end" className="axis">{(ticks.at(-1)! < 10 ? fine : number).format(tick)}</text></g>)}
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
    </svg>
    <figcaption className="sr-only">{t("{label}. Enota: {unit}.", { label, unit })}</figcaption>
    {/* A <table> ignores height:1px, so the visually-hidden wrapper must be a block element. */}
    <div className="sr-only"><table><thead><tr><th>{t("Leto")}</th>{series.map((item, index) => <th key={index}>{item.name}</th>)}</tr></thead>
      <tbody>{[...new Set(xs)].sort((a, b) => a - b).map((value) => <tr key={value}><th>{xLabel(value)}</th>
        {series.map((item, index) => { const y = item.points.find((point) => point.x === value)?.y; return <td key={index}>{y == null ? "—" : upTo1(y)}</td>; })}</tr>)}</tbody></table></div>
  </figure>;
}

/** Histogram of a published distribution; bars share one zero-based count scale. */
export function Histogram({ buckets, unit, label }: { buckets: Array<{ lower: number; upper: number; count: number }>; unit: string; label: string }) {
  const [ref, measured] = useWidth(640);
  if (!buckets.length) return <p className="muted">{t("Ni objavljive porazdelitve.")}</p>;
  const width = Math.max(240, measured);
  const height = 160;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const barWidth = (width - 40) / buckets.length;
  return <figure className="chart" ref={ref}>
    <svg viewBox={`0 0 ${width} ${height + 22}`} role="img" aria-label={label}>
      {buckets.map((bucket, index) => {
        const h = (bucket.count / max) * height;
        return <rect key={index} x={20 + index * barWidth + 1} y={height - h} width={Math.max(1, barWidth - 2)} height={h} rx={2} className="bar">
          <title>{number.format(bucket.lower)}–{number.format(bucket.upper)} {unit}: {number.format(bucket.count)}</title></rect>;
      })}
      <line x1={20} x2={width - 20} y1={height} y2={height} className="baseline"/>
      <text x={20} y={height + 16} className="axis">{number.format(buckets[0].lower)} {unit}</text>
      <text x={width - 20} y={height + 16} textAnchor="end" className="axis">{number.format(buckets[buckets.length - 1].upper)} {unit}</text>
    </svg>
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
  if (!groups.length) return <p className="muted">{t("Ni objavljenih podatkov.")}</p>;
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
      {markers.map((marker, index) => <span key={index} className="range-marker" style={{ left: at(marker.value) }} title={`${marker.name}: ${format.format(marker.value)} ${unit}`}/>)}{/* i18n-ignore (code, not text) */}
    </div>
    <figcaption>{caption ?? t("Srednja polovica poslov: {low}–{high} {unit}", { low: format.format(p25), high: format.format(p75), unit })}
      {markers.length > 0 && <>; {markers.map((marker) => `${marker.name} ${format.format(marker.value)}`).join(", ")}</>}</figcaption>
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
    <figcaption><ul className="scale-names">{items.map((item, index) => <li key={index} className={item.current ? "current" : undefined}>
      <i className={item.current ? "scale-key current" : "scale-key"}/>{item.name} {format.format(item.value)}</li>)}</ul>
      <span className="sr-only">{unit}</span></figcaption>
  </figure>;
}
