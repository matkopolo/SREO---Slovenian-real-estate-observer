import { useEffect, useEffectEvent, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { isAbort, searchBuildings, type Geography } from "../api";
import { t, tx } from "../i18n";
import {
  addressRow, areaName, EMPTY_RESPONSE, joined, levelLabel, mergeAddresses, namedArea, nearestNote, noResults, place, rank, resolveEnter, SLOVENIA_OPTION,
  streetRow, fold, type AreaOption, type AddressOption, type Row, type SearchResponse,
} from "./search-model";
import "./area-search.css";

export { addressLabel, fold, type AreaOption } from "./search-model";

/**
 * Search-first area and address picker: an ARIA 1.2 combobox with a grouped listbox
 * (Območja: občine, četrtne skupnosti, regije, naselja; Naslovi: streets and buildings with their deal counts).
 * Typing never jumps; Enter takes an exact or unique match and otherwise says why it did not.
 */
export function AreaSearch({ regions, municipalities, districts = [], label, placeholder, onArea, onAddress, onStreet, includeAddresses = true, includeCountry = true, compact = false }: {
  regions: Geography[]; municipalities: Geography[]; districts?: Geography[]; label: string; placeholder: string;
  onArea: (area: AreaOption) => void; onAddress?: (address: AddressOption) => void;
  /** "Vse prodaje na ulici …": the registered street spelling, its settlement and municipality. */
  onStreet?: (street: string, settlement?: string, municipalityId?: number) => void;
  includeAddresses?: boolean; includeCountry?: boolean; compact?: boolean;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<{ query: string; response: SearchResponse }>();
  const [notice, setNotice] = useState<ReactNode>("");
  const pendingEnter = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const regionNames = useMemo(() => new Map(regions.map((region) => [region.id, region.name])), [regions]);
  const options = useMemo<AreaOption[]>(() => [
    ...(includeCountry ? [SLOVENIA_OPTION] : []),
    ...[...municipalities].sort((a, b) => a.name.localeCompare(b.name, "sl")).map((item) => ({ id: item.id, name: item.name, level: "municipality" as const,
      region: item.parentId ? regionNames.get(item.parentId) : undefined })),
    ...regions.map((item) => ({ id: item.id, name: item.name, level: "statistical_region" as const })),
    // "Center" exists in several towns (and "Tabor" is also a municipality): the town makes each district name unique.
    ...districts.map((item) => { const town = municipalities.find((entry) => entry.id === item.parentId)?.name;
      return { id: item.id, name: town ? `${item.name} (${town})` : item.name, level: "city_district" as const, region: town }; }),
  ], [districts, includeCountry, municipalities, regionNames, regions]);

  const query = fold(text);
  const addresses = includeAddresses && !!onAddress;
  const hasDigit = /\d/.test(query);
  // "Šiška", "Bezigrad" and "Vič" name a district: no address search, Enter opens it.
  const { named, area: exactArea } = useMemo(() => !hasDigit && query ? namedArea(options, query) : { named: [], area: undefined }, [hasDigit, options, query]);
  const wantsSearch = addresses && query.length >= 3 && !named.length;
  const response = result && result.query === query ? result.response : undefined;
  const loading = wantsSearch && !response;

  useEffect(() => {
    if (!wantsSearch) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchBuildings(text.trim(), controller.signal).then((body) => setResult({ query, response: {
        ...body, items: body.items ?? [], streets: body.streets ?? [], settlements: body.settlements ?? [] } })).catch((error: unknown) => {
        // A failed search answers "no addresses" so Enter is never left waiting.
        if (!isAbort(error)) setResult({ query, response: EMPTY_RESPONSE });
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, text, wantsSearch]);

  const localMatches = useMemo(() => query && !hasDigit
    ? options.map((option) => ({ option, score: rank(option, query) })).filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score).map((entry) => entry.option)
    : [], [hasDigit, options, query]);
  const settlements = useMemo<AreaOption[]>(() => (response?.settlements ?? []).map((item) => ({ id: item.id, name: item.name, level: "settlement", region: item.municipality })), [response]);

  const groups = useMemo(() => {
    const areaRows: Row[] = [...localMatches.slice(0, 6), ...settlements].map((area) => ({ kind: "area", key: `${area.level}-${area.id ?? ""}`,
      label: areaName(area), meta: levelLabel(area), area }));
    const addressRows: Row[] = [];
    if (response && onStreet && response.matchType !== "cadastral") {
      const streets = response.matchType === "street" ? response.streets : response.streets.slice(0, 1);
      addressRows.push(...streets.filter((street) => street.saleCount > 0).map(streetRow));
    }
    if (response) addressRows.push(...mergeAddresses(response.items.filter((item) => item.street || item.settlement)).map(addressRow));
    return [{ id: "areas", title: t("Območja"), rows: areaRows }, { id: "addresses", title: t("Naslovi"), rows: addressRows }].filter((group) => group.rows.length);
  }, [localMatches, onStreet, response, settlements]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const note = response ? nearestNote(response) : "";
  const expanded = open && query.length > 0 && (rows.length > 0 || !!note);
  const optionId = (index: number) => `${id}-option-${index}`;

  const reset = () => { setText(""); setOpen(false); setActive(-1); setNotice(""); pendingEnter.current = false; };
  /** Take a row and close the list; a note ("15A is registered as 15") stays under the field. */
  const choose = (row: Row, note?: ReactNode) => {
    if (row.kind === "area") onArea(row.area);
    else if (row.kind === "address") onAddress?.(row.address);
    else onStreet?.(row.street.street, place(row.street.settlement) || undefined, row.street.municipalityId ?? undefined);
    reset();
    if (note) setNotice(note);
  };
  /** A question to answer from the list: the list stays open and shows it on top. */
  const ask = (message: ReactNode) => { setNotice(message); setOpen(true); setActive(-1); };
  /** A miss: the list closes so the message under the field is visible. */
  const miss = (message: ReactNode) => { setNotice(message); setOpen(false); setActive(-1); };
  const several = (matches: { label: ReactNode }[]) => ask(matches.length === 1
    ? tx("Ni natančnega zadetka – izberite s seznama, npr. {example}.", { example: matches[0].label })
    : tx("Več zadetkov ({count}) – izberite s seznama, npr. {examples}.", { count: matches.length, examples: joined(matches.slice(0, 3).map((row) => row.label), ", ") }));

  /** Enter without a highlighted row: take an exact or unique match, otherwise say why not. */
  const resolve = (body: SearchResponse | undefined) => {
    pendingEnter.current = false;
    const action = resolveEnter({ query, hasDigit, exactArea, localMatches, settlements, rows, wantsSearch, streets: !!onStreet, addresses }, body);
    if (action.type === "wait") { pendingEnter.current = true; setOpen(true); return; }
    if (action.type === "choose") return choose(action.row, action.note);
    if (action.type === "ask") return ask(action.message);
    if (action.type === "several") return several(action.matches);
    return miss(action.message);
  };

  // Enter pressed before the address results arrived: resolve when they do.
  const resolvePending = useEffectEvent(() => { if (pendingEnter.current && response) resolve(response); });
  useEffect(() => { resolvePending(); }, [response]);

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => !expanded || 0 > current ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length);
    } else if (event.key === "Enter" && expanded && active >= 0 && rows[active]) {
      event.preventDefault();
      choose(rows[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (expanded) { setOpen(false); setActive(-1); } else reset();
    } else if (event.key === "Home" && expanded && active >= 0) { event.preventDefault(); setActive(0); }
    else if (event.key === "End" && expanded && active >= 0) { event.preventDefault(); setActive(rows.length - 1); }
  };

  // While typing: say so when nothing can match (the areas are local; addresses once the API answered).
  const empty = query.length >= 2 && !localMatches.length && !exactArea && (!addresses || (!!response && !rows.length && !note));
  const message = notice || (empty ? (addresses ? noResults() : t("Ni takega območja.")) : "");
  let index = -1;

  return <form className={compact ? "area-search compact" : "area-search"} role="search"
    onSubmit={(event) => { event.preventDefault(); if (query) resolve(response); }}>
    <label htmlFor={id}>{label}</label>
    <div className="area-search-field">
      <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
        value={text} placeholder={placeholder} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="search"
        aria-describedby={message ? `${id}-message` : undefined}
        onChange={(event) => { setText(event.target.value); setOpen(true); setActive(-1); setNotice(""); pendingEnter.current = false; }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={(event) => { if (!listRef.current?.contains(event.relatedTarget as Node | null)) { setOpen(false); setActive(-1); } }}/>
      {loading && open && <span className="area-search-spinner" aria-hidden="true"/>}
      <div ref={listRef} id={listId} role="listbox" aria-label={t("Predlogi: {label}", { label })} className="area-search-list" hidden={!expanded}>
        {(notice || note) && <div className="area-search-note" role="presentation">{notice || note}</div>}
        {groups.map((group) => <div key={group.id} role="group" aria-labelledby={`${id}-${group.id}`}>
          <div id={`${id}-${group.id}`} role="presentation" className="area-search-group">{group.title}</div>
          {group.rows.map((row) => { index += 1; const position = index;
            return <div key={row.key} id={optionId(position)} role="option" aria-selected={position === active}
              className={`area-search-option ${row.kind}${row.kind === "address" && row.empty ? " no-deals" : ""}`}
              onMouseDown={(event) => event.preventDefault()} onMouseMove={() => { if (active !== position) setActive(position); }}
              onClick={() => choose(row)}>
              <span className="area-search-label">{row.label}</span>{" "}
              <span className="area-search-meta">{row.meta}</span>
            </div>; })}
        </div>)}
      </div>
    </div>
    {/* While the list is open its top note shows the message; the status line stays for screen readers. */}
    {message && <p id={`${id}-message`} className={expanded && notice ? "muted search-empty sr-only" : "muted search-empty"} role="status">{message}</p>}
  </form>;
}
