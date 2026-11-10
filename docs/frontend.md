# Frontend architecture (`apps/observer`)

## Purpose

`apps/observer` is the SREO web frontend: a React 19 + TypeScript single-page app
with a MapLibre map, built by Vite and served by nginx. The interface is
Slovenian by default with a full English translation. It never calculates
authoritative statistics itself: market figures, publication state, quality
evidence and geography all come from `real-estate-api`. There are no accounts and
no write requests; the frontend only reads.

In Compose it is the `observer` service at <http://localhost:3000> (and `:3100`,
kept so earlier links work), bound to loopback only.

## Pages and views

| Address | Page | Code |
|---|---|---|
| `#` / `#?…` | **Trg po območjih** (Market by area): the map, the area panel, sales lists, building evidence, transaction details, rent, value check | `views/ExplorerView.tsx`, `components/ExplorerMap.tsx`, `AreaPanel.tsx`, `AreaModules.tsx`, `SalesList.tsx`, `BuildingEvidence.tsx`, `TransactionDetails.tsx`, `RentSection.tsx`, `ValueCheck.tsx` |
| `#trendi?g=…` | **Trendi** (Trends): prices over time, and distribution with extreme sales | `views/TimeView.tsx`, `views/MarketView.tsx` (lazy-loaded) |
| `#o-podatkih` | **O podatkih** (About the data): sources, methodology and data quality | `views/QualityView.tsx` (lazy-loaded) |

`components/App.tsx` owns the masthead, page switch, language switch, data-status
banner (`DataStatusBanner.tsx`, from `/api/v1/data-status`) and the source footer.
`ErrorBoundary.tsx` and `LoadState.tsx` give every view the same loading, empty
and failure states.

## State lives in the address

The hash is the application state, so every view can be shared, reloaded and
navigated with Back/Forward. `src/url-state.ts` is the only module that reads or
writes it:

- `parseHash()` turns `#?g=133&b=1734-1710&posel=985416&vrsta=hise&obdobje=3&sloj=rentPrice`
  into an `ExplorerState` (area `g`, building `b`, opened sale `posel` or rental
  `najem`, property type `vrsta`, land use `raba`, size band `m2`, street `ulica`,
  period `obdobje` or `od`/`do`, map layer `sloj`, `vrednost`). Unknown parts
  (such as `3d=1` in links to the former 3D view) are ignored and dropped.
- `toHash()` writes the canonical form back; defaults and invalid parts are left
  out, so equal states always have equal addresses.
- URL words (page ids, parameter names, slugs) are Slovenian in both languages,
  so a link works whichever language the reader uses.
- `translateLegacyHash()` in `App.tsx` maps addresses from earlier versions
  (`#pregled`, `#posli`, `#dokazi`, `#kakovost`, `#cas`, `#trg`) onto the current
  ones. Keep it when renaming anything in the address.

The interface language is the only state outside the hash: `?lang=en`, then the
saved choice (`localStorage` key `sreo-language`), then Slovenian.

## Data loading

- **One API client.** `src/api.ts` `api(path, { params, query }, signal)` is the
  only way the frontend talks to the API. `path` must be a path from the OpenAPI
  contract (checked by `tsc`), and the response type comes from the contract.
  `coverage.test.ts` reads the literal paths passed to `api()` and fails when a
  GET data endpoint of the contract is unused, when a used path is not in the
  contract, or when an `api.ts` loader is not used by any view.
- **Generated types.** `src/generated/api-schema.d.ts` is generated from
  `apps/real-estate-api/openapi/openapi.yaml` with `npm run generate:api-types`
  (`make web-generate-api-types`). CI fails if the committed file differs from
  the contract (`make web-contract-drift`).
- **Shared requests.** Identical GETs share one in-flight request and its answer
  for 60 seconds; a shared request is aborted only when every caller has aborted.
  Failures are never cached.
- **One loading hook.** `hooks/useLoad.ts` loads by key: a new key aborts the
  previous request, a late answer can never overwrite a newer one, and failures
  are shown with a retry instead of loading forever.
- **Independent parts.** Optional statistics fail on their own and show "—", so
  one unavailable figure never blanks a view.
- **Same origin.** Requests go to `/api/…` on the page's own origin. In Compose,
  nginx (`apps/observer/nginx.conf`) proxies `/api/` to `real-estate-api:8080`,
  resolving the service per request so an API restart needs no nginx restart. In
  development, Vite proxies `/api` to `OBSERVER_API` (default
  `http://localhost:8080`).

## Map

`components/ExplorerMap.tsx` uses MapLibre GL with the OpenFreeMap "liberty" style
(`https://tiles.openfreemap.org/styles/liberty`, OpenMapTiles schema, OpenStreetMap
data). No map token is needed. Place labels prefer `name:sl`. Area shapes, metric
colours and sale/rental points are SREO layers drawn on top; `map-zoom.ts` decides
which geography level a zoom shows. One colour scale per map: while districts or
settlements are drawn (inside a selected municipality, or every one in view from
zoom 11), the municipalities underneath turn neutral grey and only the sub-areas
carry the teal ramp (classed on their own values). Map attribution
(OpenFreeMap, OpenMapTiles, OpenStreetMap contributors) must stay visible; see
[data licensing](data-licensing-privacy.md).

Automated DOM tests do not render WebGL. After map, chart or layout changes,
check the page in a real browser at desktop and phone widths.

## Fonts and styling

Fraunces (display) and Instrument Sans (text) are self-hosted from
`public/fonts/` under the SIL Open Font License (licence files next to the fonts)
and declared in `src/fonts.css`. No font or script is loaded from a third-party
CDN. Global tokens and layout are in `src/styles.css`; component styles sit next
to their components (`components/*.css`).

## Translations (i18n)

Slovenian is the source language. Every visible text is written in Slovenian in
the code and wrapped in a translation call. English lives in a dictionary that
maps each Slovenian template to its English template.

| File | Role |
|---|---|
| `src/i18n/index.tsx` | `t()`, `tx()`, `Name`, `LANG`, `LOCALE`, `setLanguage()` |
| `src/i18n/en/*.ts` | English dictionary, one file per area of the interface: `common`, `explorer`, `area`, `value`, `sale`, `pages` |
| `src/i18n/en.ts` | Merges the dictionary files into `EN` |
| `src/i18n/GLOSSARY.md` | Required English term for every domain word, plus tone rules |
| `src/i18n/scan.ts`, `src/i18n/i18n.test.ts` | Static translation audit, run by `npm test` |

**API.**

- `t("Mediana cene {noun} v {period}", { noun, period })` returns a string.
  `{name}` placeholders are filled after translation, so the English template can
  reorder them.
- `tx("· Vir GURS ETN, {licence}, obdelano", { licence: <abbr>…</abbr> })` is the
  same, but placeholders may be React nodes (links, `<strong>`, `<Term>`); it
  returns a fragment.
- `<Name>` wraps a register name (place, street, address, municipality). It is
  shown unchanged in both languages and marked `lang="sl"`.
- `LOCALE` (`sl-SI` or `en-GB`) is used for every number and date format.
- Plurals and Slovenian noun cases come from `plural.ts` and `nouns.ts`: pass the
  inflected word in as a placeholder rather than building sentences from pieces.
- The language is fixed for a page load; switching reloads the page at the same
  address.

**The audit** (`i18n.test.ts`) fails when:

1. a `t("…")`/`tx("…")` literal has no English entry;
2. an English entry has different `{placeholders}` from its Slovenian key;
3. a key is defined differently in two dictionary files;
4. an English entry still contains Slovenian letters (č, š, ž);
5. visible Slovenian is left outside `t()`/`tx()`: JSX text, user-facing
   attributes (`aria-label`, `title`, `placeholder`, …), or string literals with
   Slovenian letters or words.

A line that processes data but never shows it (URL slugs, matching register
spellings) can opt out with a trailing `// i18n-ignore` comment and a reason.
Never use it for text a user reads. In the running app, a missing English entry
falls back to Slovenian and is logged once as `[i18n] missing English for: …`.

**Adding or changing a text:**

1. Write the Slovenian text in the code inside `t("…")`, or `tx("…")` when it
   contains elements. Keep the whole sentence in one template, with placeholders
   for values.
2. Add `"<Slovenian template>": "<English template>"` to the matching
   `src/i18n/en/<area>.ts` file, using the terms in `GLOSSARY.md` and the same
   placeholders. When you change a Slovenian text, its key changes too: update or
   move the English entry, and remove the old one.
3. New domain term? Add it to `GLOSSARY.md` first.
4. Run `make web-test` (or `npm test`). The audit lists every missing key,
   placeholder mismatch and leftover Slovenian string with its file and line.
5. Check the screen in both languages (`?lang=en` and `?lang=sl`).

## Development and checks

```bash
make web-setup          # npm ci into the node_modules Docker volume
make web-typecheck      # tsc --noEmit
make web-lint           # ESLint
make web-test           # Vitest, including the i18n audit and API coverage test
make web-contract-drift # regenerate API types and fail on a diff
make web-up             # build and start the observer image (and its dependencies)
```

All `web-*` targets run Node in a container (`node:22-bookworm-slim`). For a
local dev server with hot reload, run `npm run dev` in `apps/observer` (port
5174, proxying `/api` to the API on `:8080`). The production build
(`tsc && vite build`) happens inside `apps/observer/Dockerfile`; CI builds the
image once and runs `nginx -t` against it.

Tests use Vitest with jsdom and Testing Library (`*.test.ts(x)` next to the
code). `App.test.tsx` covers the main journeys (area drill-down, buildings,
earlier links, history and Back, property types); the component tests cover
their loading, failure and empty states.

## Provenance and attribution in the interface

The footer of every page names the source (GURS ETN, CC BY 4.0, processed) and links to
**O podatkih**. The footer on the Trends and About pages lists every source:
GURS (ETN, RPE, Kataster nepremičnin), SURS, Banka Slovenije, ECB, OpenFreeMap and
OpenStreetMap contributors, and states that the figures are informative and are
not an official valuation or a loan offer. These disclosures must stay visible in
any public deployment; see [data licensing and privacy](data-licensing-privacy.md).
