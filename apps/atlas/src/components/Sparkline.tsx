const number = new Intl.NumberFormat("sl-SI", { maximumFractionDigits: 0 });

/** Small line chart on one scale, with first/last values labelled and every point in an accessible list. */
export function Sparkline({ points, unit }: { points: Array<{ label: string; value: number; incomplete?: boolean }>; unit: string }) {
  const width = 300;
  const height = 90;
  const pad = { top: 12, right: 10, bottom: 18, left: 10 };
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const x = (index: number) => pad.left + (index / Math.max(1, points.length - 1)) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + (1 - (value - min) / Math.max(1, max - min)) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const first = points[0];
  const last = points[points.length - 1];
  const change = ((last.value / first.value) - 1) * 100;
  return <figure className="sparkline">
    <svg viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Od ${first.label} do ${last.label}: ${number.format(first.value)} → ${number.format(last.value)} ${unit}`}>
      <path d={`${path} L${x(points.length - 1)},${height - pad.bottom} L${x(0)},${height - pad.bottom} Z`} className="area"/>
      <path d={path} className="line"/>
      <circle cx={x(points.length - 1)} cy={y(last.value)} r={3.5} className="end"/>
      <text x={x(0)} y={height - 4} className="axis">{first.label}</text>
      <text x={x(points.length - 1)} y={height - 4} textAnchor="end" className="axis">{last.label}{last.incomplete ? "*" : ""}</text>
    </svg>
    <figcaption>{number.format(first.value)} → <strong>{number.format(last.value)} {unit}</strong>
      <span> ({change > 0 ? "+" : ""}{number.format(change)} %)</span></figcaption>
    <ol className="sr-only">{points.map((point) => <li key={point.label}>{point.label}: {number.format(point.value)} {unit}</li>)}</ol>
  </figure>;
}
