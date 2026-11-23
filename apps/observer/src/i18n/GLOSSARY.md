# English glossary for SREO (use these exact terms everywhere)

British spelling and number/date formats come from the en-GB locale (`LOCALE`); words follow this list.
Tone: plain, modern, short (Zillow/Redfin/ONS style). No bureaucratic phrasing. Sentence case for headings and buttons.

| Slovenian | English |
|---|---|
| Slovenian Real Estate Observer / SREO | Slovenian Real Estate Observer / SREO |
| Trg po območjih | Market by area |
| Trendi | Trends |
| O podatkih | About the data |
| Koliko je vredna moja nepremičnina? | What is my property worth? |
| stanovanje / stanovanja | apartment / apartments |
| hiša / hiše | house / houses |
| zemljišče / zemljišča | land / plots (a sale of land = "land sale") |
| zazidljivo zemljišče | building land |
| kmetijsko zemljišče | agricultural land |
| gozdno zemljišče | forest land |
| vsa zemljišča | all land |
| poslovni prostor(i) | commercial premises |
| garaža / parkirišče | garage / parking space |
| soba / sobe | room / rooms |
| prodaja | sale |
| najem (pogodba) | rental |
| najemnina | rent |
| posel | transaction |
| evidentiran posel | recorded transaction |
| mediana | median |
| srednja polovica (P25–P75) | middle half |
| upoštevan v statistiki / reprezentativen | included in the statistics |
| ni v statistiki | not in the statistics |
| premalo prodaj (12) | too few sales (12) |
| premalo najemov (12) | too few rentals (12) |
| ni prodaj / ni najemov | no sales / no rentals |
| ni podatka (screen readers; on screen "—") | no data |
| Premalo prodaj za graf. / Premalo najemov za graf. | Too few sales to chart. / Too few rentals to chart. |
| Premalo podatkov za oceno. | Too little data for an estimate. |
| primerljive prodaje (iz 1.689 primerljivih prodaj) | comparable sales (from 1,689 comparable sales) |
| šrafirano (združeno) | hatched (pooled) |
| še se dopolnjuje | still being reported |
| združeno 5 let | pooled over 5 years |
| Slovenija | Slovenia |
| statistična regija | statistical region |
| občina | municipality |
| četrtna skupnost | city district |
| naselje | settlement |
| katastrska občina (k. o.) | cadastral municipality |
| stavba / del stavbe | building / unit |
| parcela | parcel |
| površina / uporabna površina | floor area / usable area (land: area) |
| nadstropje / pritličje | floor / ground floor |
| leto gradnje | year built |
| cena na m² | price per m² |
| obdobje | period |
| 12 mesecev / 3 leta / 5 let / Po meri | 12 months / 3 years / 5 years / Custom |
| koledarska leta | calendar years |
| gibanje cen | price trend |
| dostopnost | affordability |
| neto mediana plače | median net salary |
| lastna sredstva | down payment |
| obrok | monthly instalment |
| bruto donos | gross yield |
| davek na dobiček | capital gains tax |
| normirani stroški | standard deduction (costs the law allows without receipts) |
| nova gradnja / nova ponudba | new construction / new supply |
| gradbeno dovoljenje | building permit |
| prebivalci / stanovanjski fond | population / housing stock |
| neto selitve | net migration |
| sproščena stanovanja starejših | homes released by older owners (modelled) |
| ocena (vrednosti) | estimate |
| podobne prodaje | similar sales |
| statistični model | statistical model |
| zanesljivost: srednja / nizka / zelo nizka | reliability: moderate / low / very low |
| Prenova / slabše stanje | renovation / worse condition |
| posrednik | estate agent |
| notar, overitve | notary and certification |
| Kopiraj povezavo | Copy link |
| Nazaj | Back |
| Prikaži vse | Show all |
| Legenda | Legend |
| Barva zemljevida | Map colour |
| V pogledu | In view |
| Odpri | Open |
| Nalagam … (non-breaking space before the ellipsis) | Loading… (no space) |
| Ni zadetkov | No results |
| Poskusi znova | Try again |

Proper names from the registers (municipalities, districts, settlements, streets, addresses) stay as they are and are wrapped in `<Name>` (lang="sl"). "Slovenija" as a label of the country area is translated ("Slovenia").

## Missing data (one convention everywhere)

- A register field that is not filled in: `<Missing/>` – "—" on screen, "ni podatka" / "no data" for screen readers. Never "0", "neznano" or an empty cell.
- Below the publication threshold: "premalo prodaj" / "premalo najemov", with "({n})" when the count is known – at every zoom, in tiles, cards, the map legend and tooltips (`tooFew()` in `components/Missing.tsx`).
- No event at all: "ni prodaj" / "ni najemov" (`withheld()` with a count of 0).
- A chart with nothing to draw: "Premalo prodaj za graf." / "Too few sales to chart." (rents: "Premalo najemov za graf.").
- An estimate that cannot be computed: "Premalo podatkov za oceno." / "Too little data for an estimate."
- A load failure: always `LoadFailed` (message and "Poskusi znova"), never text in a tile.
- Loading: "Nalagam …" with a non-breaking space / "Loading…", never "…" alone as a value.
- Retired: "ni objavljeno", "premalo poslov", "premalo za mediano", "(premalo podatkov)", "ni dovolj podatkov", "neznano".
- A number and its unit are joined by a non-breaking space (`withUnit()` in `format.ts`): "2.965 €/m²".
