import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDataStatus, loadMetric, loadMunicipalities, type MunicipalityShape } from "../api";
import { METRICS, colorScale, heightScale, quantileBreaks, type MetricId, type MunicipalityValue } from "../metrics";
import type { AtlasScene } from "../scene/atlas-scene";
import { DataTable } from "./DataTable";
import { MunicipalityPanel } from "./MunicipalityPanel";

const THIS_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: THIS_YEAR - 2013 + 1 }, (_, index) => THIS_YEAR - index);
const ORDER: MetricId[] = ["salePrice", "saleVolume", "rentPrice", "newBuildings"];

function useDarkScheme() {
  const query = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
  const [dark, setDark] = useState(query?.matches ?? true);
  useEffect(() => {
    if (!query) return;
    const change = () => setDark(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, [query]);
  return dark;
}

export function App() {
  const dark = useDarkScheme();
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<AtlasScene | null>(null);
  const [shapes, setShapes] = useState<MunicipalityShape[]>([]);
  const [metric, setMetric] = useState<MetricId>("salePrice");
  const [year, setYear] = useState(THIS_YEAR - 1);
  const [values, setValues] = useState<MunicipalityValue[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: number; x: number; y: number } | null>(null);
  const [error, setError] = useState<string>();
  const [webgl, setWebgl] = useState<"pending" | "ready" | "failed">("pending");
  const [cutoff, setCutoff] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    loadMunicipalities(controller.signal).then(setShapes)
      .catch(() => { if (!controller.signal.aborted) setError("Meja občin ni bilo mogoče naložiti."); });
    loadDataStatus(controller.signal).then((status) => setCutoff(status.activeRelease?.analyticsSaleThrough?.slice(0, 10)))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadMetric(metric, year, controller.signal).then((next) => { setValues(next); setError(undefined); })
      .catch(() => { if (!controller.signal.aborted) setError("Podatkov za izbrani prikaz ni bilo mogoče naložiti."); });
    return () => controller.abort();
  }, [metric, year]);

  // The three.js scene loads on demand and degrades to the table when WebGL is unavailable.
  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    const element = host.current;
    import("../scene/atlas-scene").then(({ AtlasScene }) => {
      if (cancelled) return;
      try {
        scene.current = new AtlasScene(element, {
          onHover: (id, screen) => setHover(id == null || !screen ? null : { id, ...screen }),
          onSelect: (id) => setSelected(id),
        }, dark);
        setWebgl("ready");
      } catch { setWebgl("failed"); }
    }).catch(() => { if (!cancelled) setWebgl("failed"); });
    return () => { cancelled = true; scene.current?.dispose(); scene.current = null; };
    // The scene is created once; theme changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { scene.current?.setTheme(dark); }, [dark, webgl]);
  useEffect(() => { if (webgl === "ready") scene.current?.setShapes(shapes); }, [shapes, webgl]);

  const definition = METRICS[metric];
  const shown = useMemo(() => values.map((item) => ({ ...item,
    value: item.sample >= definition.minimumSample ? item.value : null })), [values, definition]);
  const byId = useMemo(() => new Map(shown.map((item) => [item.geographyId, item])), [shown]);
  const names = useMemo(() => new Map(shapes.map((shape) => [shape.id, shape.name])), [shapes]);

  useEffect(() => {
    if (webgl !== "ready" || !shapes.length) return;
    const numbers = shown.map((item) => item.value);
    const height = heightScale(numbers);
    const color = colorScale(numbers, dark);
    scene.current?.setValues(new Map(shapes.map((shape) => {
      const value = byId.get(shape.id)?.value ?? null;
      return [shape.id, { height: height(value), color: color(value) }];
    })));
  }, [byId, dark, shapes, shown, webgl]);

  useEffect(() => { scene.current?.select(selected); }, [selected, webgl]);

  const chooseFromTable = useCallback((id: number) => setSelected(id), []);
  const breaks = quantileBreaks(shown.map((item) => item.value));
  const ramp = colorScale(shown.map((item) => item.value), dark);
  const hovered = hover ? byId.get(hover.id) : undefined;
  const withheld = shapes.length - shown.filter((item) => item.value != null).length;

  return <div className="atlas">
    <header className="masthead">
      <div className="wordmark"><span>DOMOGLASNIK</span><strong>Atlas</strong></div>
      <p className="tagline">Dejansko sklenjeni posli in gradnja po slovenskih občinah{cutoff ? ` · podatki GURS do ${new Date(`${cutoff}T00:00:00`).toLocaleDateString("sl-SI")}` : ""}</p>
    </header>

    <section className="controls" aria-label="Prikaz">
      <div className="segmented" role="group" aria-label="Merilo">
        {ORDER.map((id) => <button key={id} type="button" aria-pressed={metric === id} onClick={() => setMetric(id)}>
          {METRICS[id].label}</button>)}
      </div>
      <label className="year">Leto
        <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
          {YEARS.map((value) => <option key={value} value={value}>{value}{value === THIS_YEAR ? " (nepopolno)" : ""}</option>)}
        </select>
      </label>
    </section>

    <main className="layout">
      <section className="stage" aria-labelledby="stage-title">
        <h1 id="stage-title" className="stage-title">{definition.label} · {year}</h1>
        <p className="stage-sub">Višina in barva stolpca prikazujeta isto vrednost. {definition.source}.
          {withheld > 0 ? ` ${withheld} občin brez objavljive vrednosti je prikazanih sivo.` : ""}</p>
        <div ref={host} className="canvas-host">
          {webgl === "failed" && <p className="fallback" role="status">3D prikaz v tem brskalniku ni na voljo. Vse vrednosti so v tabeli spodaj.</p>}
          {hover && <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }} role="presentation">
            <strong>{names.get(hover.id) ?? "Občina"}</strong>
            <span>{hovered?.value == null ? "ni objavljive vrednosti" : definition.format(hovered.value)}</span>
            {hovered && <small>vzorec: {hovered.sample.toLocaleString("sl-SI")}</small>}
          </div>}
        </div>
        <div className="stage-foot">
          {breaks.length > 0 && <ol className="legend" aria-label={`Lestvica: ${definition.unit}, kvantilni razredi`}>
            {breaks.map((value) => <li key={value}><i style={{ background: ramp(value) }}/>do {definition.format(value)}</li>)}
          </ol>}
          <button type="button" className="ghost" onClick={() => scene.current?.resetView()} disabled={webgl !== "ready"}>Začetni pogled</button>
        </div>
        <p className="hint">Povlecite za vrtenje, kolesce za približanje, klik na občino za podrobnosti.</p>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <MunicipalityPanel geographyId={selected} name={selected ? names.get(selected) : undefined}
        value={selected ? byId.get(selected) : undefined} metric={definition} year={year} onClose={() => setSelected(null)}/>
    </main>

    <DataTable rows={shapes.map((shape) => ({ id: shape.id, name: shape.name, value: byId.get(shape.id)?.value ?? null,
      sample: byId.get(shape.id)?.sample ?? 0 }))} metric={definition} selected={selected} onSelect={chooseFromTable}/>

    <footer className="colophon">
      <p>Vir: Geodetska uprava RS (GURS) — Evidenca trga nepremičnin, Register prostorskih enot in Kataster nepremičnin (CC BY 4.0);
        SURS; Banka Slovenije; ECB. Podatki so obdelani. Prikaz je informativen in ni uradna cenitev ali ponudba kredita.</p>
    </footer>
  </div>;
}
