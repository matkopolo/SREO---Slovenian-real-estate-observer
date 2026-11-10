package analytics

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

// Match types of a building search.
const (
	// SearchMatchAddress: buildings with the requested house number.
	SearchMatchAddress = "address"
	// SearchMatchNearest: the house number has no recorded building; the nearest numbers on that street.
	SearchMatchNearest = "nearest"
	// SearchMatchStreet: a street or settlement without a house number; its buildings by transaction count.
	SearchMatchStreet = "street"
	// SearchMatchCadastral: a cadastral identity ("1730 123").
	SearchMatchCadastral = "cadastral"
	// SearchMatchNone: nothing matched.
	SearchMatchNone = "none"
)

// BuildingSearch is the answer to an address search.
type BuildingSearch struct {
	Items     []BuildingSearchResult `json:"items"`
	MatchType string                 `json:"matchType"`
	// RequestedHouseNumber is the house number read from the query ("100", "15a"), if any.
	RequestedHouseNumber *string `json:"requestedHouseNumber"`
	// Streets that the query names, with their transaction totals (at most three).
	Streets []StreetSearchResult `json:"streets"`
	// Settlements (naselja) whose name the query starts, for queries without a house number (at most five).
	Settlements []SettlementSearchResult `json:"settlements"`
}

// SettlementSearchResult is a settlement (naselje) geography matching the query.
type SettlementSearchResult struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	MunicipalityID *int64 `json:"municipalityId"`
	Municipality   string `json:"municipality"`
}

// StreetSearchResult summarises one street of one settlement.
type StreetSearchResult struct {
	// Street is the most common registered spelling (what /transactions/recent?street= matches).
	Street         string `json:"street"`
	Settlement     string `json:"settlement"`
	MunicipalityID *int64 `json:"municipalityId"`
	BuildingCount  int    `json:"buildingCount"`
	SaleCount      int64  `json:"saleCount"`
	RentalCount    int64  `json:"rentalCount"`
}

// addressQuery is a parsed search text.
type addressQuery struct {
	words        []string // normalised words other than the house number
	number       int      // house number, -1 when absent
	suffix       string   // house-number suffix, lower case ("a")
	cadastral    bool
	cadastreCode int32
	cadastreNo   string
}

var (
	cadastralPattern = regexp.MustCompile(`^(\d{1,4})\s*[-/ ]\s*(\d{1,6})$`)
	numberPattern    = regexp.MustCompile(`^(\d{1,5})([a-z])?$`)
	foldReplacer     = strings.NewReplacer(
		"č", "c", "š", "s", "ž", "z", "ć", "c", "đ", "d", "Č", "c", "Š", "s", "Ž", "z", "Ć", "c", "Đ", "d",
		"ä", "a", "ö", "o", "ü", "u", "é", "e", "á", "a", "í", "i", "ó", "o", "ú", "u",
	)
)

// foldAddress lower-cases, removes Slovenian diacritics and splits "C.1.MAJA" into "c. 1. maja".
func foldAddress(value string) []string {
	value = strings.ToLower(foldReplacer.Replace(value))
	value = strings.NewReplacer(".", ". ", ",", " ", ";", " ").Replace(value)
	return strings.Fields(value)
}

// normalizeWord expands the "c." and "ul." abbreviations and drops dots ("1." → "1").
func normalizeWord(token string) string {
	switch token {
	case "c.":
		return "cesta"
	case "ul.":
		return "ulica"
	}
	return strings.Trim(token, ".-")
}

func normalizeWords(value string) []string {
	words := make([]string, 0, 4)
	for _, token := range foldAddress(value) {
		if word := normalizeWord(token); word != "" {
			words = append(words, word)
		}
	}
	return words
}

// parseAddressQuery reads "Dunajska c. 100", "Celovska cesta 15 a", "Kozje 144" or "1730 123".
func parseAddressQuery(raw string) addressQuery {
	query := addressQuery{number: -1}
	trimmed := strings.TrimSpace(raw)
	if match := cadastralPattern.FindStringSubmatch(trimmed); match != nil {
		code, _ := strconv.Atoi(match[1])
		query.cadastral, query.cadastreCode, query.cadastreNo = true, int32(code), match[2]
	}
	tokens := foldAddress(trimmed)
	// The last bare number is the house number; a number with a dot ("1. maja") is part of the name.
	numberAt := -1
	for index := len(tokens) - 1; index >= 0; index-- {
		if numberPattern.MatchString(tokens[index]) {
			numberAt = index
			break
		}
	}
	suffixAt := -1
	if numberAt >= 0 {
		match := numberPattern.FindStringSubmatch(tokens[numberAt])
		query.number, _ = strconv.Atoi(match[1])
		query.suffix = match[2]
		if query.suffix == "" && numberAt+1 < len(tokens) && len(tokens[numberAt+1]) == 1 &&
			tokens[numberAt+1][0] >= 'a' && tokens[numberAt+1][0] <= 'z' {
			query.suffix, suffixAt = tokens[numberAt+1], numberAt+1
		}
	}
	for index, token := range tokens {
		if index == numberAt || index == suffixAt {
			continue
		}
		if word := normalizeWord(token); word != "" {
			query.words = append(query.words, word)
		}
	}
	return query
}

type buildingKey struct {
	code   int32
	number string
}

type addressVariant struct {
	street, settlement, houseNumber, suffix string
	parts                                   int64
	streetWords, settlementWords            []string // settlementWords also hold the municipality name
	streetKey                               string
	summarizable                            bool     // a clean street name ("Garažna hiša B, …" is not)
	rural                                   bool     // no street, or a street named after its village
	villageWords                            []string // settlement words without the municipality
	number                                  int
	suffixNorm                              string
}

type indexedBuilding struct {
	key        buildingKey
	variants   []addressVariant // most parts first: variants[0] is the display address
	longitude  float64
	latitude   float64
	totalCount int64 // sales + rentals over all time, for ranking
}

type indexedStreet struct {
	street, settlement string
	buildings          []int
	totalCount         int64
	// hidden: a misspelt duplicate ("Celovška, Ljubljabna" next to "Celovška cesta, Ljubljana"), not listed as a street.
	hidden bool
}

type indexedSettlement struct {
	result            SettlementSearchResult
	words, localWords []string
}

type addressIndex struct {
	settlements []indexedSettlement
	buildings   []indexedBuilding
	streets     map[string]*indexedStreet
	byKey       map[buildingKey]int
}

// addressRow is one registered address spelling of a building.
type addressRow struct {
	code                                    int32
	number                                  string
	settlement, street, houseNumber, suffix string
	municipality                            string
	parts                                   int64
	longitude, latitude                     float64
}

func appendNewWords(words []string, extra []string) []string {
	for _, word := range extra {
		if !containsWord(words, word) {
			words = append(words, word)
		}
	}
	return words
}

func containsWord(words []string, wanted string) bool {
	for _, word := range words {
		if word == wanted {
			return true
		}
	}
	return false
}

func newAddressVariant(row addressRow) addressVariant {
	variant := addressVariant{street: row.street, settlement: row.settlement, houseNumber: row.houseNumber,
		suffix: row.suffix, parts: row.parts, number: -1,
		streetWords: normalizeWords(row.street), settlementWords: normalizeWords(row.settlement),
		suffixNorm: strings.Join(normalizeWords(row.suffix), "")}
	if strings.EqualFold(strings.TrimSpace(row.settlement), "ni podatka") {
		variant.settlementWords = nil
	}
	settlementOnly := variant.settlementWords
	variant.villageWords = settlementOnly
	variant.rural = len(variant.streetWords) == 0 || strings.Join(variant.streetWords, " ") == strings.Join(settlementOnly, " ")
	municipalityWords := normalizeWords(row.municipality)
	variant.settlementWords = appendNewWords(append([]string(nil), settlementOnly...), municipalityWords)
	if value, err := strconv.Atoi(strings.TrimSpace(row.houseNumber)); err == nil {
		variant.number = value
	}
	// Rural addresses have no street: the settlement is the "street" ("Kozje 144").
	streetPart := variant.streetWords
	if len(streetPart) == 0 {
		streetPart = settlementOnly
	}
	// One street per municipality: "Celovška cesta" is registered under Ljubljana, Šiška and "Ni podatka".
	place := municipalityWords
	if len(place) == 0 {
		place = variant.settlementWords
	}
	variant.streetKey = strings.Join(streetPart, " ") + "|" + strings.Join(place, " ")
	// Only a registered street can be listed: /transactions/recent?street= matches the street column.
	variant.summarizable = strings.TrimSpace(row.street) != "" && !strings.Contains(row.street, ",") && !junkStreetName(row.street)
	return variant
}

var bareNumberToken = regexp.MustCompile(`^\d+[a-z]?$`)

// junkStreetName tells a register note from a street name: "k.o. Bežigrad", "k.o.Zgornja Šiška", "kat.občina vič"
// (a cadastral municipality) or "Vojkova 73" (a whole address in the street column). "C. 1. maja" keeps its dotted number.
func junkStreetName(street string) bool {
	tokens := foldAddress(street)
	if len(tokens) == 0 {
		return true
	}
	if tokens[0] == "kat." || len(tokens) > 1 && tokens[0] == "k." && strings.TrimSuffix(tokens[1], ".") == "o" {
		return true
	}
	for _, token := range tokens {
		if bareNumberToken.MatchString(token) {
			return true
		}
	}
	return false
}

func buildAddressIndex(rows []addressRow, counts map[buildingKey]int64) *addressIndex {
	index := &addressIndex{streets: map[string]*indexedStreet{}, byKey: map[buildingKey]int{}}
	weights := map[buildingKey]float64{}
	for _, row := range rows {
		key := buildingKey{row.code, row.number}
		position, ok := index.byKey[key]
		if !ok {
			position = len(index.buildings)
			index.byKey[key] = position
			index.buildings = append(index.buildings, indexedBuilding{key: key, totalCount: counts[key]})
		}
		building := &index.buildings[position]
		building.variants = append(building.variants, newAddressVariant(row))
		// Part-weighted mean of the variant centroids.
		weight := weights[key] + float64(row.parts)
		if weight > 0 {
			share := float64(row.parts) / weight
			building.longitude += (row.longitude - building.longitude) * share
			building.latitude += (row.latitude - building.latitude) * share
		}
		weights[key] = weight
	}
	streetSpellings := map[string]map[[2]string]int64{}
	for position := range index.buildings {
		building := &index.buildings[position]
		sort.SliceStable(building.variants, func(a, b int) bool { return building.variants[a].parts > building.variants[b].parts })
		seen := map[string]bool{}
		for _, variant := range building.variants {
			if !variant.summarizable {
				continue
			}
			if streetSpellings[variant.streetKey] == nil {
				streetSpellings[variant.streetKey] = map[[2]string]int64{}
			}
			streetSpellings[variant.streetKey][[2]string{variant.street, variant.settlement}] += variant.parts
			if seen[variant.streetKey] {
				continue
			}
			seen[variant.streetKey] = true
			street := index.streets[variant.streetKey]
			if street == nil {
				street = &indexedStreet{}
				index.streets[variant.streetKey] = street
			}
			street.buildings = append(street.buildings, position)
			street.totalCount += building.totalCount
		}
	}
	for key, spellings := range streetSpellings {
		best, bestParts := [2]string{}, int64(-1)
		for spelling, parts := range spellings {
			if strings.EqualFold(spelling[1], "ni podatka") || spelling[1] == "" {
				parts = 0
			}
			if parts > bestParts || parts == bestParts && spelling[0] < best[0] {
				best, bestParts = spelling, parts
			}
		}
		index.streets[key].street, index.streets[key].settlement = best[0], best[1]
	}
	return index
}

func hasWordPrefix(words []string, prefix string) bool {
	for _, word := range words {
		if strings.HasPrefix(word, prefix) {
			return true
		}
	}
	return false
}

// matchSettlements returns settlements whose name words start with the query words
// (the municipality name may be added: "Krivcevo Kamnik"): exact names first, then shorter names.
func (index *addressIndex) matchSettlements(query addressQuery, limit int) []SettlementSearchResult {
	if query.number >= 0 || query.cadastral || len(query.words) == 0 {
		return []SettlementSearchResult{}
	}
	type scored struct {
		settlement *indexedSettlement
		exact      bool
	}
	found := make([]scored, 0)
	wanted := strings.Join(query.words, " ")
	for position := range index.settlements {
		settlement := &index.settlements[position]
		inName, ok := false, true
		for _, word := range query.words {
			if hasWordPrefix(settlement.words, word) {
				inName = true
			} else if !hasWordPrefix(settlement.localWords, word) {
				ok = false
				break
			}
		}
		if ok && inName {
			name := strings.Join(settlement.words, " ")
			found = append(found, scored{settlement, name == wanted || name+" "+strings.Join(settlement.localWords, " ") == wanted})
		}
	}
	sort.SliceStable(found, func(a, b int) bool {
		if found[a].exact != found[b].exact {
			return found[a].exact
		}
		left, right := found[a].settlement.result.Name, found[b].settlement.result.Name
		if len(left) != len(right) {
			return len(left) < len(right)
		}
		return left < right
	})
	results := make([]SettlementSearchResult, 0, limit)
	for _, item := range found {
		if len(results) == limit {
			break
		}
		results = append(results, item.settlement.result)
	}
	return results
}

// matches tells whether every query word starts a word of the street or settlement,
// and whether at least one names the street (not only the settlement).
func (variant addressVariant) matches(words []string) (matched bool, namesStreet bool) {
	// A street named after its village ("Krivčevo, Krivčevo") or a rural address is named by the village.
	rural := variant.rural
	for _, word := range words {
		inStreet := hasWordPrefix(variant.streetWords, word) || rural && hasWordPrefix(variant.villageWords, word)
		inPlace := hasWordPrefix(variant.settlementWords, word)
		if !inStreet && !inPlace {
			return false, false
		}
		// "Ljubljana" names the town, not "Ob Kajuhovi ulici, Ljubljana".
		namesStreet = namesStreet || inStreet && (!inPlace || rural)
	}
	return true, namesStreet && variant.summarizable
}

// numberScore ranks a variant for a query: 2 = number and suffix, 1 = number, 0 = other.
func numberScore(variant addressVariant, query addressQuery) int {
	if variant.number != query.number {
		return 0
	}
	if variant.suffixNorm == query.suffix {
		return 2
	}
	return 1
}

// displaySuffix is the suffix shown for a building variant: a bare "15" whose other parts are registered
// as "15A" on the same street reads "15A", as on the building page.
func (building indexedBuilding) displaySuffix(variantIndex int) string {
	variant := building.variants[variantIndex]
	if variant.suffix != "" || variant.number < 0 {
		return variant.suffix
	}
	for _, other := range building.variants { // most parts first
		if other.suffix != "" && other.number == variant.number && other.streetKey == variant.streetKey {
			return other.suffix
		}
	}
	return ""
}

type searchHit struct {
	building int
	variant  int
}

type searchPlan struct {
	hits      []searchHit
	matchType string
	streets   []string // street keys, best first
}

func (index *addressIndex) plan(query addressQuery, limit int) searchPlan {
	if query.cadastral {
		if position, ok := index.byKey[buildingKey{query.cadastreCode, query.cadastreNo}]; ok {
			return searchPlan{hits: []searchHit{{position, 0}}, matchType: SearchMatchCadastral}
		}
	}
	if len(query.words) == 0 {
		return searchPlan{matchType: SearchMatchNone}
	}
	hits := make([]searchHit, 0, 64)
	streetCounts := map[string]bool{}
	for position := range index.buildings {
		building := &index.buildings[position]
		found := -1
		for variantIndex, variant := range building.variants {
			matched, namesStreet := variant.matches(query.words)
			if !matched {
				continue
			}
			if namesStreet {
				streetCounts[variant.streetKey] = true
			}
			// Prefer the variant with the requested number and suffix (a building can have two entrances,
			// and its parts can be registered as "15" and "15A").
			if found < 0 || query.number >= 0 && numberScore(variant, query) > numberScore(building.variants[found], query) {
				found = variantIndex
			}
		}
		if found >= 0 {
			hits = append(hits, searchHit{position, found})
		}
	}
	if len(hits) == 0 {
		return searchPlan{matchType: SearchMatchNone}
	}
	streets := make([]string, 0, len(streetCounts))
	for key := range streetCounts {
		if street := index.streets[key]; street != nil && !street.hidden {
			streets = append(streets, key)
		}
	}
	sort.Slice(streets, func(a, b int) bool {
		left, right := index.streets[streets[a]], index.streets[streets[b]]
		if left.totalCount != right.totalCount {
			return left.totalCount > right.totalCount
		}
		return streets[a] < streets[b]
	})
	if len(streets) > 3 {
		streets = streets[:3]
	}
	variantOf := func(hit searchHit) addressVariant { return index.buildings[hit.building].variants[hit.variant] }
	byCount := func(list []searchHit) {
		sort.SliceStable(list, func(a, b int) bool {
			left, right := index.buildings[list[a].building], index.buildings[list[b].building]
			if left.totalCount != right.totalCount {
				return left.totalCount > right.totalCount
			}
			lv, rv := variantOf(list[a]), variantOf(list[b])
			if lv.number != rv.number {
				return lv.number < rv.number
			}
			return lv.suffixNorm < rv.suffixNorm
		})
	}
	cut := func(list []searchHit) []searchHit {
		if len(list) > limit {
			return list[:limit]
		}
		return list
	}
	if query.number >= 0 {
		exact := make([]searchHit, 0)
		for _, hit := range hits {
			variant := variantOf(hit)
			if variant.number == query.number && (query.suffix == "" || variant.suffixNorm == query.suffix) {
				exact = append(exact, hit)
			}
		}
		if len(exact) == 0 && query.suffix != "" {
			// "Clevelandska ulica 15A" where the register only has "15": the bare number is the building.
			for _, hit := range hits {
				if variant := variantOf(hit); variant.number == query.number && variant.suffixNorm == "" {
					exact = append(exact, hit)
				}
			}
		}
		if len(exact) > 0 {
			byCount(exact)
			// "Partizanska cesta 5" lists number 5 itself before 5a.
			sort.SliceStable(exact, func(a, b int) bool {
				return (variantOf(exact[a]).suffixNorm == query.suffix) && variantOf(exact[b]).suffixNorm != query.suffix
			})
			return searchPlan{hits: cut(exact), matchType: SearchMatchAddress, streets: streets}
		}
		// No such number: the nearest numbers on the busiest matching street.
		if len(streets) > 0 {
			best := streets[0]
			nearest := make([]searchHit, 0)
			for _, position := range index.streets[best].buildings {
				building := index.buildings[position]
				for variantIndex, variant := range building.variants {
					if variant.streetKey == best && variant.number >= 0 {
						nearest = append(nearest, searchHit{position, variantIndex})
						break
					}
				}
			}
			if len(nearest) > 0 {
				distance := func(hit searchHit) int {
					value := variantOf(hit).number - query.number
					if value < 0 {
						return -value
					}
					return value
				}
				sort.SliceStable(nearest, func(a, b int) bool {
					if distance(nearest[a]) != distance(nearest[b]) {
						return distance(nearest[a]) < distance(nearest[b])
					}
					lv, rv := variantOf(nearest[a]), variantOf(nearest[b])
					if lv.number != rv.number {
						return lv.number < rv.number
					}
					return lv.suffixNorm < rv.suffixNorm
				})
				return searchPlan{hits: cut(nearest), matchType: SearchMatchNearest, streets: streets[:1]}
			}
		}
	}
	byCount(hits)
	return searchPlan{hits: cut(hits), matchType: SearchMatchStreet, streets: streets}
}

// releaseIndex is the address index built from one published release.
type releaseIndex struct {
	releaseID string
	index     *addressIndex
}

// newAddressIndexCache keeps the address index of the active release in memory. It checks the
// active release once a minute and rebuilds the index (about 5 s) only when a new release is
// published; searches keep using the previous index meanwhile. The build runs detached from
// any request, so a cancelled typeahead request never cancels or restarts it.
func newAddressIndexCache(r *StatisticsRepository) *memo.Value[*releaseIndex] {
	return memo.New(func(ctx context.Context, previous *releaseIndex, ok bool) (*releaseIndex, error) {
		var releaseID string
		if err := r.db.QueryRow(ctx, `
			SELECT coalesce((SELECT active_release_id::text FROM analytics.analytical_publication LIMIT 1), '')`,
		).Scan(&releaseID); err != nil {
			return nil, fmt.Errorf("load active release: %w", err)
		}
		if ok && previous.releaseID == releaseID {
			return previous, nil
		}
		index, err := loadAddressIndex(ctx, r.db)
		if err != nil {
			return nil, err
		}
		return &releaseIndex{releaseID: releaseID, index: index}, nil
	}, memo.Options{TTL: time.Minute, Timeout: 2 * time.Minute, RetryAfter: 30 * time.Second})
}

func (r *StatisticsRepository) addressIndex(ctx context.Context) (*addressIndex, error) {
	current, err := r.search.Get(ctx)
	if err != nil {
		return nil, err
	}
	return current.index, nil
}

// WarmSearchIndex loads the address index ahead of the first search, waiting up to ctx.
func (r *StatisticsRepository) WarmSearchIndex(ctx context.Context) error {
	return r.search.Warm(ctx)
}

func loadAddressIndex(ctx context.Context, db database.Querier) (*addressIndex, error) {
	counts := map[buildingKey]int64{}
	countRows, err := db.Query(ctx, `
		SELECT cadastral_municipality_code,building_number,count(*) FROM (
		  SELECT cadastral_municipality_code,building_number FROM analytics.sale_facts
		  UNION ALL SELECT cadastral_municipality_code,building_number FROM analytics.rental_facts) f
		WHERE cadastral_municipality_code IS NOT NULL AND building_number IS NOT NULL
		GROUP BY 1,2`)
	if err != nil {
		return nil, fmt.Errorf("load building transaction counts: %w", err)
	}
	for countRows.Next() {
		var key buildingKey
		var total int64
		if err := countRows.Scan(&key.code, &key.number, &total); err != nil {
			countRows.Close()
			return nil, fmt.Errorf("scan building transaction count: %w", err)
		}
		counts[key] = total
	}
	countRows.Close()
	if err := countRows.Err(); err != nil {
		return nil, err
	}
	rows, err := db.Query(ctx, `
		SELECT cadastral_municipality_code,building_number,coalesce(settlement,''),coalesce(street,''),
		  coalesce(house_number::text,''),coalesce(house_number_suffix,''),coalesce(municipality_name,''),count(*),
		  avg(ST_X(ST_Transform(location,4326))),avg(ST_Y(ST_Transform(location,4326)))
		FROM (
		  SELECT cadastral_municipality_code,building_number,settlement,street,house_number::text house_number,
		    house_number_suffix,municipality_name,location FROM building_parts
		  UNION ALL
		  SELECT cadastral_municipality_code,building_number,settlement,street,house_number::text,
		    house_number_suffix,municipality_name,location FROM rental_building_parts) p
		WHERE cadastral_municipality_code IS NOT NULL AND building_number IS NOT NULL
		  AND location IS NOT NULL AND (street IS NOT NULL OR settlement IS NOT NULL)
		GROUP BY 1,2,3,4,5,6,7`)
	if err != nil {
		return nil, fmt.Errorf("load building addresses: %w", err)
	}
	defer rows.Close()
	addresses := make([]addressRow, 0, 200000)
	for rows.Next() {
		var row addressRow
		if err := rows.Scan(&row.code, &row.number, &row.settlement, &row.street, &row.houseNumber,
			&row.suffix, &row.municipality, &row.parts, &row.longitude, &row.latitude); err != nil {
			return nil, fmt.Errorf("scan building address: %w", err)
		}
		addresses = append(addresses, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	index := buildAddressIndex(addresses, counts)
	settlementRows, err := db.Query(ctx, `
		SELECT s.id,s.name,m.id,coalesce(m.name,'')
		FROM analytics.geographic_units s
		LEFT JOIN analytics.geographic_units m ON m.id=s.parent_id
		WHERE s.level='settlement'`)
	if err != nil {
		return nil, fmt.Errorf("load settlements: %w", err)
	}
	defer settlementRows.Close()
	for settlementRows.Next() {
		var item SettlementSearchResult
		if err := settlementRows.Scan(&item.ID, &item.Name, &item.MunicipalityID, &item.Municipality); err != nil {
			return nil, fmt.Errorf("scan settlement: %w", err)
		}
		index.addSettlement(item)
	}
	if err := settlementRows.Err(); err != nil {
		return nil, err
	}
	index.hideJunkStreets()
	return index, nil
}

// streetTypeWords complete a short spelling of a street ("Celovška" → "Celovška cesta").
var streetTypeWords = []string{"cesta", "ulica", "trg", "pot", "nabrezje", "drevored", "steza", "breg", "klanec", "naselje"}

// junkStreetSales: below this many transactions (all time), a street in a settlement that is not in the
// settlement register is treated as a typo.
const junkStreetSales = 10

// hideJunkStreets hides misspelt street duplicates from the street list (their buildings stay searchable):
// a short spelling of a busier street of the same municipality ("Celovška, Ljubljabna" beside
// "Celovška cesta, Ljubljana"), and rarely used streets whose settlement is not a known settlement.
func (index *addressIndex) hideJunkStreets() {
	known := map[string]bool{}
	for _, settlement := range index.settlements {
		known[strings.Join(settlement.words, " ")] = true
	}
	for key, street := range index.streets {
		name, place, _ := strings.Cut(key, "|")
		for _, word := range streetTypeWords {
			if other := index.streets[name+" "+word+"|"+place]; other != nil && other.totalCount > street.totalCount {
				street.hidden = true
				break
			}
		}
		settlement := strings.Join(normalizeWords(street.settlement), " ")
		if len(known) > 0 && !known[settlement] && street.totalCount < junkStreetSales {
			street.hidden = true
		}
	}
}

func (index *addressIndex) addSettlement(item SettlementSearchResult) {
	index.settlements = append(index.settlements, indexedSettlement{result: item,
		words: normalizeWords(item.Name), localWords: normalizeWords(item.Municipality)})
}

func optionalText(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// SearchBuildings finds buildings by address (diacritics-insensitive, "c."/"ul." and "15a"/"15 a"
// tolerant), falls back to the nearest house numbers of the street, and summarises named streets.
// Only buildings with a recorded sale or rental are known: there is no address register in the database.
func (r *StatisticsRepository) SearchBuildings(
	ctx context.Context, search string, limit int, filter BuildingFilter,
) (BuildingSearch, error) {
	index, err := r.addressIndex(ctx)
	if err != nil {
		return BuildingSearch{}, err
	}
	query := parseAddressQuery(search)
	plan := index.plan(query, limit)
	result := BuildingSearch{Items: make([]BuildingSearchResult, 0, len(plan.hits)), MatchType: plan.matchType,
		Streets:     make([]StreetSearchResult, 0, len(plan.streets)),
		Settlements: index.matchSettlements(query, 5)}
	if query.number >= 0 && !query.cadastral {
		requested := strconv.Itoa(query.number) + query.suffix
		result.RequestedHouseNumber = &requested
	}
	if len(plan.hits) > 0 {
		codes, numbers := make([]int32, len(plan.hits)), make([]string, len(plan.hits))
		for position, hit := range plan.hits {
			building := index.buildings[hit.building]
			codes[position], numbers[position] = building.key.code, building.key.number
		}
		counts, err := r.buildingSearchCounts(ctx, codes, numbers, filter)
		if err != nil {
			return BuildingSearch{}, err
		}
		for _, hit := range plan.hits {
			building := index.buildings[hit.building]
			variant := building.variants[hit.variant]
			item := BuildingSearchResult{CadastralMunicipalityCode: building.key.code, BuildingNumber: building.key.number,
				Settlement: optionalText(variant.settlement), Street: optionalText(variant.street),
				HouseNumber: optionalText(variant.houseNumber), HouseNumberSuffix: optionalText(building.displaySuffix(hit.variant)),
				Longitude: building.longitude, Latitude: building.latitude,
				SaleCounts: map[string]int64{}, RentalCounts: map[string]int64{}}
			if count, ok := counts[building.key]; ok {
				item.SaleCount, item.RentalCount, item.SaleCounts, item.RentalCounts =
					count.SaleCount, count.RentalCount, count.SaleCounts, count.RentalCounts
			}
			result.Items = append(result.Items, item)
		}
		if plan.matchType == SearchMatchStreet {
			// Rank by the counts of the requested period.
			sort.SliceStable(result.Items, func(a, b int) bool {
				return result.Items[a].SaleCount+result.Items[a].RentalCount > result.Items[b].SaleCount+result.Items[b].RentalCount
			})
		}
	}
	for _, key := range plan.streets {
		street := index.streets[key]
		codes, numbers := make([]int32, len(street.buildings)), make([]string, len(street.buildings))
		for position, building := range street.buildings {
			codes[position], numbers[position] = index.buildings[building].key.code, index.buildings[building].key.number
		}
		summary := StreetSearchResult{Street: street.street, Settlement: street.settlement, BuildingCount: len(street.buildings)}
		if err := r.db.QueryRow(ctx, `
			WITH b AS MATERIALIZED (SELECT * FROM unnest($1::int[],$2::text[]) b(code,num)),
			sales AS MATERIALIZED (SELECT f.municipality_id FROM b CROSS JOIN LATERAL (
			    SELECT municipality_id FROM analytics.sale_facts f
			    WHERE f.cadastral_municipality_code=b.code AND f.building_number=b.num
			      AND ($3::date IS NULL OR f.contract_date>=$3) AND ($4::date IS NULL OR f.contract_date<=$4)) f)
			SELECT (SELECT count(*) FROM sales),
			  (SELECT count(*) FROM b CROSS JOIN LATERAL (
			    SELECT 1 FROM analytics.rental_facts f
			    WHERE f.cadastral_municipality_code=b.code AND f.building_number=b.num
			      AND ($3::date IS NULL OR f.contract_date>=$3) AND ($4::date IS NULL OR f.contract_date<=$4)) r),
			  (SELECT mode() WITHIN GROUP (ORDER BY municipality_id) FROM sales)`,
			codes, numbers, filter.FromDate, filter.ToDate).Scan(
			&summary.SaleCount, &summary.RentalCount, &summary.MunicipalityID); err != nil {
			return BuildingSearch{}, fmt.Errorf("count street transactions: %w", err)
		}
		result.Streets = append(result.Streets, summary)
	}
	return result, nil
}

func (r *StatisticsRepository) buildingSearchCounts(
	ctx context.Context, codes []int32, numbers []string, filter BuildingFilter,
) (map[buildingKey]BuildingSearchResult, error) {
	rows, err := r.db.Query(ctx, `
		SELECT b.code,b.num,coalesce(sales.total,0),coalesce(rentals.total,0),
		  coalesce(sales.by_group,'{}'::jsonb),coalesce(rentals.by_group,'{}'::jsonb)
		FROM unnest($1::int[],$2::text[]) b(code,num)
		LEFT JOIN LATERAL (
		  SELECT sum(group_count)::bigint total,jsonb_object_agg(property_group,group_count) by_group
		  FROM (SELECT property_group,count(*)::bigint group_count FROM analytics.sale_facts f
		    WHERE f.cadastral_municipality_code=b.code AND f.building_number=b.num
		      AND ($3::date IS NULL OR f.contract_date>=$3) AND ($4::date IS NULL OR f.contract_date<=$4)
		    GROUP BY property_group) grouped
		) sales ON true
		LEFT JOIN LATERAL (
		  SELECT sum(group_count)::bigint total,jsonb_object_agg(property_group,group_count) by_group
		  FROM (SELECT property_group,count(*)::bigint group_count FROM analytics.rental_facts f
		    WHERE f.cadastral_municipality_code=b.code AND f.building_number=b.num
		      AND ($3::date IS NULL OR f.contract_date>=$3) AND ($4::date IS NULL OR f.contract_date<=$4)
		    GROUP BY property_group) grouped
		) rentals ON true`, codes, numbers, filter.FromDate, filter.ToDate)
	if err != nil {
		return nil, fmt.Errorf("count building search transactions: %w", err)
	}
	defer rows.Close()
	counts := map[buildingKey]BuildingSearchResult{}
	for rows.Next() {
		var key buildingKey
		var item BuildingSearchResult
		var saleCounts, rentalCounts []byte
		if err := rows.Scan(&key.code, &key.number, &item.SaleCount, &item.RentalCount, &saleCounts, &rentalCounts); err != nil {
			return nil, fmt.Errorf("scan building search counts: %w", err)
		}
		if err := json.Unmarshal(saleCounts, &item.SaleCounts); err != nil {
			return nil, fmt.Errorf("decode building sale counts: %w", err)
		}
		if err := json.Unmarshal(rentalCounts, &item.RentalCounts); err != nil {
			return nil, fmt.Errorf("decode building rental counts: %w", err)
		}
		counts[key] = item
	}
	return counts, rows.Err()
}
