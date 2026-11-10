package analytics

import (
	"reflect"
	"testing"
)

func TestParseAddressQuery(t *testing.T) {
	cases := []struct {
		raw    string
		words  []string
		number int
		suffix string
	}{
		{"Dunajska cesta 100", []string{"dunajska", "cesta"}, 100, ""},
		{"Celovška c. 15A", []string{"celovska", "cesta"}, 15, "a"},
		{"celovska cesta 15 a", []string{"celovska", "cesta"}, 15, "a"},
		{"Cankarjeva ul. 5, Maribor", []string{"cankarjeva", "ulica", "maribor"}, 5, ""},
		{"C. 4. julija 10", []string{"cesta", "4", "julija"}, 10, ""},
		{"Prešernov trg", []string{"presernov", "trg"}, -1, ""},
	}
	for _, tc := range cases {
		got := parseAddressQuery(tc.raw)
		if !reflect.DeepEqual(got.words, tc.words) || got.number != tc.number || got.suffix != tc.suffix {
			t.Errorf("%q → words %v number %d suffix %q", tc.raw, got.words, got.number, got.suffix)
		}
	}
	if query := parseAddressQuery("1730 123"); !query.cadastral || query.cadastreCode != 1730 || query.cadastreNo != "123" {
		t.Errorf("cadastral query = %+v", query)
	}
}

func testIndex() *addressIndex {
	rows := []addressRow{
		{code: 1, number: "10", settlement: "LJUBLJANA", street: "DUNAJSKA CESTA", houseNumber: "98", parts: 5},
		{code: 1, number: "11", settlement: "LJUBLJANA", street: "DUNAJSKA C.", houseNumber: "102", parts: 3},
		{code: 1, number: "12", settlement: "LJUBLJANA", street: "DUNAJSKA CESTA", houseNumber: "21", parts: 50},
		{code: 1, number: "13", settlement: "LJUBLJANA", street: "CELOVŠKA CESTA", houseNumber: "15", parts: 2},
		{code: 1, number: "14", settlement: "LJUBLJANA", street: "CELOVŠKA CESTA", houseNumber: "15", suffix: "A", parts: 4},
		{code: 1, number: "15", settlement: "Ljubljana", street: "Celovška cesta", houseNumber: "143", parts: 30},
		{code: 2, number: "1", settlement: "KOZJE", street: "KOZJE", houseNumber: "144", municipality: "KOZJE", parts: 1},
		{code: 2, number: "3", settlement: "KOZJE", houseNumber: "1", municipality: "KOZJE", parts: 1},
		{code: 2, number: "2", settlement: "LESIČNO", houseNumber: "3", municipality: "KOZJE", parts: 1},
		{code: 1, number: "16", settlement: "LJUBLJANA", street: "PREŠERNOV TRG", houseNumber: "1", parts: 2},
		{code: 1, number: "17", settlement: "Ni podatka", street: "celovška c.", houseNumber: "200", municipality: "LJUBLJANA", parts: 1},
		{code: 1, number: "18", settlement: "LJUBLJANA", street: "Garažna hiša B, Vojkova cesta 73, Ljubljana", parts: 9},
	}
	counts := map[buildingKey]int64{{1, "10"}: 5, {1, "11"}: 12, {1, "12"}: 134, {1, "13"}: 2, {1, "14"}: 4, {1, "15"}: 28, {2, "1"}: 1, {1, "16"}: 2}
	return buildAddressIndex(rows, counts)
}

func planNumbers(index *addressIndex, plan searchPlan) []string {
	numbers := make([]string, 0, len(plan.hits))
	for _, hit := range plan.hits {
		variant := index.buildings[hit.building].variants[hit.variant]
		numbers = append(numbers, variant.houseNumber+variant.suffix)
	}
	return numbers
}

func TestPlanNearestNumbers(t *testing.T) {
	index := testIndex()
	plan := index.plan(parseAddressQuery("Dunajska cesta 100"), 10)
	if plan.matchType != SearchMatchNearest {
		t.Fatalf("match type = %s", plan.matchType)
	}
	if got := planNumbers(index, plan); !reflect.DeepEqual(got, []string{"98", "102", "21"}) {
		t.Fatalf("nearest = %v", got)
	}
	if len(plan.streets) != 1 || index.streets[plan.streets[0]].street != "DUNAJSKA CESTA" {
		t.Fatalf("streets = %v", plan.streets)
	}
}

func TestPlanExactWithSuffixAndDiacritics(t *testing.T) {
	index := testIndex()
	for _, raw := range []string{"celovska c. 15a", "Celovška cesta 15 A"} {
		plan := index.plan(parseAddressQuery(raw), 10)
		if got := planNumbers(index, plan); plan.matchType != SearchMatchAddress || !reflect.DeepEqual(got, []string{"15A"}) {
			t.Fatalf("%q → %s %v", raw, plan.matchType, got)
		}
	}
	plan := index.plan(parseAddressQuery("Celovska cesta 15"), 10)
	if got := planNumbers(index, plan); !reflect.DeepEqual(got, []string{"15", "15A"}) {
		t.Fatalf("15 → %v", got)
	}
	plan = index.plan(parseAddressQuery("Presernov trg 1"), 10)
	if got := planNumbers(index, plan); plan.matchType != SearchMatchAddress || !reflect.DeepEqual(got, []string{"1"}) {
		t.Fatalf("Presernov trg 1 → %s %v", plan.matchType, got)
	}
}

func TestPlanStreetOrdersByTransactions(t *testing.T) {
	index := testIndex()
	plan := index.plan(parseAddressQuery("Celovška cesta"), 10)
	if plan.matchType != SearchMatchStreet {
		t.Fatalf("match type = %s", plan.matchType)
	}
	if got := planNumbers(index, plan); !reflect.DeepEqual(got, []string{"143", "15A", "15", "200"}) {
		t.Fatalf("street = %v", got)
	}
	street := index.streets[plan.streets[0]]
	if street.street != "Celovška cesta" && street.street != "CELOVŠKA CESTA" || street.settlement == "Ni podatka" || len(street.buildings) != 4 {
		t.Fatalf("street summary = %+v", street)
	}
	// A settlement alone names no street.
	if plan := index.plan(parseAddressQuery("Ljubljana"), 10); len(plan.streets) != 0 || len(plan.hits) == 0 {
		t.Fatalf("settlement streets = %v", plan.streets)
	}
	// An address without a street is found by its settlement but is not a street of its own.
	if plan := index.plan(parseAddressQuery("Kozje 1"), 10); len(plan.hits) != 1 || len(plan.streets) != 1 {
		t.Fatalf("settlement streets = %v", plan.streets)
	}
}

func TestPlanRuralAndNoMatch(t *testing.T) {
	index := testIndex()
	plan := index.plan(parseAddressQuery("Kozje 144"), 10)
	if got := planNumbers(index, plan); plan.matchType != SearchMatchAddress || !reflect.DeepEqual(got, []string{"144"}) {
		t.Fatalf("Kozje 144 → %s %v", plan.matchType, got)
	}
	// Villages of the municipality Kozje are not streets named "Kozje".
	if len(plan.streets) != 1 || index.streets[plan.streets[0]].settlement != "KOZJE" {
		t.Fatalf("Kozje 144 streets → %v", plan.streets)
	}
	if plan := index.plan(parseAddressQuery("Neobstoječa ulica 3"), 10); plan.matchType != SearchMatchNone || len(plan.hits) != 0 {
		t.Fatalf("unknown street → %+v", plan)
	}
	if plan := index.plan(parseAddressQuery("1 12"), 10); plan.matchType != SearchMatchCadastral || len(plan.hits) != 1 {
		t.Fatalf("cadastral → %+v", plan)
	}
}

func TestMatchSettlements(t *testing.T) {
	index := testIndex()
	id := func(value int64) *int64 { return &value }
	index.addSettlement(SettlementSearchResult{ID: 1, Name: "Krivčevo", MunicipalityID: id(9), Municipality: "Kamnik"})
	index.addSettlement(SettlementSearchResult{ID: 2, Name: "Krivi Vrh", MunicipalityID: id(8), Municipality: "Sveta Ana"})
	index.addSettlement(SettlementSearchResult{ID: 3, Name: "Kamnik", MunicipalityID: id(9), Municipality: "Kamnik"})
	if got := index.matchSettlements(parseAddressQuery("krivcevo"), 5); len(got) != 1 || got[0].ID != 1 {
		t.Fatalf("krivcevo → %+v", got)
	}
	if got := index.matchSettlements(parseAddressQuery("Kriv"), 5); len(got) != 2 {
		t.Fatalf("kriv → %+v", got)
	}
	if got := index.matchSettlements(parseAddressQuery("Krivčevo, Kamnik"), 5); len(got) != 1 || got[0].ID != 1 {
		t.Fatalf("Krivčevo, Kamnik → %+v", got)
	}
	// A municipality name alone does not list every settlement in it.
	if got := index.matchSettlements(parseAddressQuery("Kamnik"), 5); len(got) != 1 || got[0].ID != 3 {
		t.Fatalf("kamnik → %+v", got)
	}
	if got := index.matchSettlements(parseAddressQuery("Kozje 144"), 5); len(got) != 0 {
		t.Fatalf("address query listed settlements: %+v", got)
	}
}

func suffixIndex() *addressIndex {
	rows := []addressRow{
		// One building, its parts registered both as "15" and "15 A" (the building page shows 15A).
		{code: 2680, number: "17", settlement: "LJUBLJANA", street: "CLEVELANDSKA ULICA", houseNumber: "15", municipality: "LJUBLJANA", parts: 8},
		{code: 2680, number: "17", settlement: "LJUBLJANA", street: "CLEVELANDSKA ULICA", houseNumber: "15", suffix: "A", municipality: "LJUBLJANA", parts: 5},
		{code: 2680, number: "9", settlement: "LJUBLJANA", street: "CLEVELANDSKA ULICA", houseNumber: "19", municipality: "LJUBLJANA", parts: 18},
		{code: 2680, number: "13", settlement: "LJUBLJANA", street: "CLEVELANDSKA ULICA", houseNumber: "27", municipality: "LJUBLJANA", parts: 40},
		{code: 1739, number: "1", settlement: "LJUBLJANA", street: "CELOVŠKA CESTA", houseNumber: "264", municipality: "LJUBLJANA", parts: 900},
		{code: 1739, number: "2", settlement: "LJUBLJABNA", street: "CELOVŠKA", houseNumber: "12", municipality: "LJUBLJANA", parts: 200},
		{code: 2636, number: "1", settlement: "LJUBLJANA", street: "BEŽIGRAD", houseNumber: "3", municipality: "LJUBLJANA", parts: 50},
		{code: 2636, number: "2", settlement: "LJUBLJANA", street: "k.o. Bežigrad", municipality: "LJUBLJANA", parts: 1},
		{code: 1739, number: "3", settlement: "LJUBLJANA", street: "k.o.Zgornja Šiška", municipality: "LJUBLJANA", parts: 33},
		{code: 1739, number: "4", settlement: "ŠIŠKAA", street: "VODNIKOVA ULICA", houseNumber: "300", municipality: "LJUBLJANA", parts: 2},
		{code: 1739, number: "5", settlement: "LJUBLJANA", street: "C. 1. MAJA", houseNumber: "4", municipality: "LJUBLJANA", parts: 2},
	}
	counts := map[buildingKey]int64{{2680, "17"}: 13, {2680, "9"}: 18, {2680, "13"}: 129, {1739, "1"}: 1641, {1739, "2"}: 698,
		{2636, "1"}: 75, {2636, "2"}: 1, {1739, "3"}: 40, {1739, "4"}: 2, {1739, "5"}: 2}
	index := buildAddressIndex(rows, counts)
	index.addSettlement(SettlementSearchResult{ID: 1, Name: "Ljubljana", Municipality: "Ljubljana"})
	index.hideJunkStreets()
	return index
}

func TestPlanMatchesRegisteredSuffix(t *testing.T) {
	index := suffixIndex()
	for _, raw := range []string{"Clevelandska ulica 15A", "clevelandska 15 a", "Clevelandska ulica 15a"} {
		plan := index.plan(parseAddressQuery(raw), 10)
		if got := planNumbers(index, plan); plan.matchType != SearchMatchAddress || !reflect.DeepEqual(got, []string{"15A"}) {
			t.Fatalf("%q → %s %v", raw, plan.matchType, got)
		}
	}
	// The bare number shows the suffix the building page uses.
	plan := index.plan(parseAddressQuery("Clevelandska ulica 15"), 10)
	if len(plan.hits) != 1 || index.buildings[plan.hits[0].building].displaySuffix(plan.hits[0].variant) != "A" {
		t.Fatalf("15 → %+v", plan)
	}
	// Only the bare number is registered: "19A" is the building "19", still an address match.
	plan = index.plan(parseAddressQuery("Clevelandska ulica 19A"), 10)
	if got := planNumbers(index, plan); plan.matchType != SearchMatchAddress || !reflect.DeepEqual(got, []string{"19"}) {
		t.Fatalf("19A → %s %v", plan.matchType, got)
	}
	// A suffix with neither form registered stays a miss with the nearest numbers.
	if plan := index.plan(parseAddressQuery("Clevelandska ulica 21A"), 10); plan.matchType != SearchMatchNearest {
		t.Fatalf("21A → %s", plan.matchType)
	}
}

func TestPlanHidesJunkStreets(t *testing.T) {
	index := suffixIndex()
	names := func(raw string) []string {
		plan := index.plan(parseAddressQuery(raw), 10)
		out := make([]string, 0, len(plan.streets))
		for _, key := range plan.streets {
			out = append(out, index.streets[key].street+", "+index.streets[key].settlement)
		}
		return out
	}
	if got := names("celovska"); !reflect.DeepEqual(got, []string{"CELOVŠKA CESTA, LJUBLJANA"}) {
		t.Fatalf("celovska streets = %v", got)
	}
	if got := names("Bezigrad"); !reflect.DeepEqual(got, []string{"BEŽIGRAD, LJUBLJANA"}) {
		t.Fatalf("bezigrad streets = %v", got)
	}
	if got := names("siska"); len(got) != 0 {
		t.Fatalf("siska streets = %v", got)
	}
	if got := names("vodnikova"); len(got) != 0 {
		t.Fatalf("rare street in an unknown settlement listed: %v", got)
	}
	if got := names("c. 1. maja"); !reflect.DeepEqual(got, []string{"C. 1. MAJA, LJUBLJANA"}) {
		t.Fatalf("dotted number street = %v", got)
	}
	// The buildings themselves stay searchable.
	if plan := index.plan(parseAddressQuery("k.o.Zgornja Šiška"), 10); len(plan.hits) != 1 {
		t.Fatalf("junk street building not found: %+v", plan)
	}
}

func TestJunkStreetName(t *testing.T) {
	for street, want := range map[string]bool{"k.o. Bežigrad": true, "K.o.zgornja Šiška": true, "Vojkova 73": true, "kat.občina vič": true,
		"C. 1. maja": false, "Cesta 24. junija": false, "Celovška cesta": false, "Ulica K. Destovnika": false} {
		if got := junkStreetName(street); got != want {
			t.Errorf("junkStreetName(%q) = %v", street, got)
		}
	}
}
