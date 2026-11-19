# SREO, Slovenian Real Estate Observer

SREO shows actual concluded property sales and rentals in Slovenia from the official
Evidenca trga nepremičnin (ETN) of the Surveying and Mapping Authority (GURS), not
advertisements. Every statistic is computed from representative open-market agreements with a
known floor area and price: medians and middle halves (P25 to P75) per area, period and
property type, hedonic price indices, a current-market estimate for one property with its
comparable sales, and context from SURS (wages, population), Banka Slovenije (loan rates,
lending limits), the ECB (EURIBOR), the GURS building cadastre and valuation register, the
public register of energy performance certificates and the DRSV flood hazard map.

## How to read the answers

- Areas are official units of the Register prostorskih enot: statistical regions,
  municipalities, city districts, local communities and settlements. Each has a numeric `id`
  used by every tool; `find_areas` resolves a name to ids.
- Sales and rentals have numeric `transactionId`s. A building is identified by its cadastral
  municipality code and building number; a unit by the part-of-building number.
- Medians are published only from 30 agreements; smaller samples are marked as not
  publishable. Thin areas may pool three or five years, which the answers state.
- GURS records agreements with a lag (sales a few months, rentals up to a year), so the last
  quarters are provisional. `data_status` gives the cutoff the statistics run to.
- The current-market estimate is a statistical reading of comparable sales, not an official
  valuation, and the GURS generalised value is an administrative value, never a price.
- Names from the registers (municipalities, streets, settlements) are Slovene and should be
  shown as they are.

## Licence and attribution

GURS data is used under CC BY 4.0; the data has been processed. Energy certificates are
public-sector information re-used under ZURE Art. 32; DRSV flood classes are CC BY 4.0; SURS,
Banka Slovenije and ECB data are re-used with the source cited. Every tool answer carries the
`source` notice, which must stay with the data when it is shown to people. No personal data
is held: owners and contracting parties are never imported.
