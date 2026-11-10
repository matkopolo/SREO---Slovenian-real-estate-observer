# Data licensing, provenance, privacy, and limitations

## Public data and commercial reuse

The application uses public data from the Geodetic Administration of the
Republic of Slovenia (GURS): the Real Estate Market Register (ETN) and the
Register of Spatial Units (RPE). GURS publishes its public geodetic data under
Creative Commons Attribution 4.0 International (CC BY 4.0), permitting sharing,
adaptation, and commercial reuse with attribution.

Every publication or product view must identify:

- **Geodetska uprava Republike Slovenije (GURS)** as the source;
- the data types, specifically ETN and RPE where both are used;
- the applicable data period or collection state;
- that the source data were processed;
- the [CC BY 4.0 licence](https://creativecommons.org/licenses/by/4.0/deed.sl).

GURS does not sponsor, endorse, certify, or accept responsibility for this
application or its derived results. The official GURS terms remain controlling:
<https://www.e-prostor.gov.si/dostopi/javni-dostop/>.

## Sources

| Source | Used for | Terms | Attribution shown |
|---|---|---|---|
| GURS Evidenca trga nepremičnin (ETN), BUY/KPP and RENT/NP | Transactions, prices, rents, all market statistics and models | CC BY 4.0 | "Vir GURS ETN, CC BY 4.0, obdelano" in the masthead; full list in the footer and on **O podatkih** |
| GURS Register prostorskih enot (RPE) | Region, municipality, district and settlement boundaries | CC BY 4.0 | Footer and **O podatkih** |
| GURS Kataster nepremičnin, stavbe (building cadastre) | Building year, floors, dwellings, type and location (construction views, building evidence). Ownership files in the archive are not imported | CC BY 4.0 | Footer and **O podatkih** |
| SURS (Statistični urad RS), PX-Web | Net wages, building permits, population, deaths, migration, dwellings and households (`analytics.context_series`) | SURS terms of use: free reuse, including commercial, with the source cited ("Vir: SURS") | Footer and next to each context figure |
| Banka Slovenije | Housing-loan interest rates; macroprudential lending limits (`analytics.lending_rules`) | Free reuse with the source cited | Footer and the affordability view |
| European Central Bank (ECB) Data Portal | 6-month EURIBOR | ECB reuse policy: free reuse with the source cited | Footer and the affordability view |
| OpenStreetMap contributors, via OpenMapTiles and OpenFreeMap | Base map tiles and the "liberty" style | Map data ODbL 1.0; OpenMapTiles schema and style under their open licences; OpenFreeMap is a free public tile service | "© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors" must be visible on or directly next to the map |
| Fraunces, Instrument Sans | Interface fonts, self-hosted from `apps/observer/public/fonts` | SIL Open Font License 1.1 (licence texts shipped beside the fonts) | Not required in the UI |

The demographic series are context only: they are not used in any price
statistic, index or model ([demographics](demographics.md)). Keep this table in
step with the footer text in `apps/observer/src/components/App.tsx` when a
source is added.

## Third-party requests from the browser

The page loads its code and fonts from its own origin. The only third-party
requests are the OpenFreeMap tiles, style, glyphs and sprites needed to draw the
map, which reveal the visitor's IP address and the viewed map area to that
service. No analytics, advertising or font CDN (for example Google Fonts) is
used, and nothing is loaded before the visitor opens the page. The interface
language choice is kept in the browser's `localStorage` (`sreo-language`) and
never sent to the server.

## Provenance shown to users

The optional Google Maps link sends a selected ETN coordinate to Google only
when clicked and warns about approximate/package locations. The property-history
cost/tax scenario runs entirely in the browser: entered prices, dates, expenses
and tax assumptions are neither submitted to the API nor stored. Observed
resale intervals do not identify owners or prove uninterrupted ownership.
See [property history](property-history.md) for evidence and tax limitations.

The interface distinguishes three categories:

1. **Podatek GURS ETN** — a field reported in the public source transaction;
2. **Izračun aplikacije** — a derived statistic, comparison, aggregation, or
   current-market estimate produced by this software;
3. **Statistična modelska ocena** — a prediction produced by a fitted valuation
   model, including its uncertainty interval and reliability evidence.

Aggregates use the active filters and the documented representative population.
The displayed analysis period is not necessarily the archive download date;
the database `source_files` ledger is the authoritative local record of archive
name, dataset year, checksum, and import time.

## Valuation limitations

All estimates and comparisons are informational analytical outputs. They are
not official GURS generalized values, certified appraisal reports, or guarantees
of a realizable sale price or rent. They must not be represented as compliant
professional valuations for secured lending, court proceedings, taxation,
accounting, or another regulated purpose without review and responsibility by
an appropriately qualified professional.

Results can be affected by reporting errors, missing characteristics, bundled
transactions, limited comparable samples, location precision, market changes,
and model error. Validation metrics and intervals describe historical model
performance; they do not eliminate uncertainty for an individual property.

## Personal-data minimization

The inspected public 2025 BUY/KPP and RENT/NP archive schemas contain no buyer,
seller, landlord, tenant, owner, tax-number, or EMŠO fields. The application
does not attempt to enrich transactions with owners or contracting parties.

ETN archives do contain unstructured source-note fields. Although these are not
party fields, free text is unnecessary for the analytics and could theoretically
contain identifying text entered by a reporter. Migration
`027_source_text_minimization.sql` removes those columns from the database, and
the importer deliberately ignores:

- `OPOMBE_O_PRAVNEM_POSLU`;
- `OPOMBE_O_NEPREMICNINI`;
- `OPOMBE_O_ODDANIH_PROSTORIH`.

SREO has no user accounts, logins or saved preferences on the server (the
earlier identity tables are dropped by migration 044), so it stores no personal
data about its visitors. The API is read-only for the public frontend.

Exact addresses, transaction dates, and prices can still contribute to
re-identification when combined with external information. The product must
not add owner names, party identities, behavioural profiles, or external
identity enrichment without a separate documented lawful basis and privacy
assessment.
