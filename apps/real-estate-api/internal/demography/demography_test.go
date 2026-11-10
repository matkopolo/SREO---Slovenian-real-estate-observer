package demography

import (
	"math"
	"testing"
)

func series(rows map[string]map[string]float64) Series { return Series(rows) }

func near(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9*math.Max(1, math.Abs(want)) {
		t.Fatalf("%s = %v, want %v", name, got, want)
	}
}

func fixture() Series {
	data := series(map[string]map[string]float64{
		"population_total":                {"2016H1": 900, "2021H1": 950, "2024H1": 990, "2025H1": 995, "2026H1": 1000},
		"population_25_29":                {"2026H1": 50},
		"population_30_34":                {"2026H1": 60},
		"population_65_69":                {"2024H1": 100, "2025H1": 100, "2026H1": 100},
		"population_90_94":                {"2024H1": 10, "2025H1": 10, "2026H1": 20},
		"deaths_total":                    {"2023": 9, "2024": 9, "2025": 9},
		"deaths_65_69":                    {"2024": 1, "2025": 1},
		"deaths_90_94":                    {"2024": 2, "2025": 2},
		"net_migration_total":             {"2025": 10},
		"dwellings_total":                 {"2018": 380, "2021": 400},
		"dwellings_occupied":              {"2021": 320},
		"dwellings_vacant":                {"2018": 50},
		"dwellings_seasonal":              {"2018": 5},
		"dwellings_owner_occupied":        {"2021": 240},
		"occupied_dwellings_tenure_total": {"2021": 320},
		"households_total":                {"2021": 330},
		"households_one_person":           {"2021": 110},
		"living_alone_total":              {"2021": 1},
		"persons_65_69":                   {"2021": 100}, "living_alone_65_69": {"2021": 20},
		"persons_70_74": {"2021": 1}, "persons_75_79": {"2021": 1}, "persons_80_84": {"2021": 1},
		"persons_85_plus": {"2021": 100}, "living_alone_85_plus": {"2021": 50},
	})
	// Groups without deaths still need exposure for a defined rate.
	for _, group := range []string{"70_74", "75_79", "80_84"} {
		data["population_"+group] = map[string]float64{"2023H1": 1, "2024H1": 1, "2025H1": 1}
	}
	return data
}

func TestComputeProfileAndModelledReleases(t *testing.T) {
	data := fixture()
	profile, err := Compute(Unit{ID: 7, Level: "municipality", Name: "Test"}, data, data, data, "Testna regija")
	if err != nil {
		t.Fatal(err)
	}
	if profile.Period != "2026H1" || profile.EarlierPeriod == nil || *profile.EarlierPeriod != "2016H1" {
		t.Fatalf("periods: %s %v", profile.Period, profile.EarlierPeriod)
	}
	near(t, "change10", *profile.Population.Change10Years, 1000.0/900-1)
	near(t, "change5", *profile.Population.Change5Years, 1000.0/950-1)
	near(t, "65+", profile.Population.Age65Plus, 120)
	near(t, "share65", profile.Population.Share65Plus, 0.12)
	near(t, "cohort", profile.Population.EnteringThirtiesPerYear, 10)
	if len(profile.Migration) != 1 || profile.Migration[0].PerThousand == nil {
		t.Fatalf("migration: %+v", profile.Migration)
	}
	near(t, "migration per 1000", *profile.Migration[0].PerThousand, 10.0/995*1000)
	housing := profile.Housing
	if housing.Year != "2021" || *housing.SplitYear != "2018" || *housing.Vacant != 50 {
		t.Fatalf("housing: %+v", housing)
	}
	near(t, "owner share", *housing.OwnerOccupiedShare, 0.75)

	// Three death years are requested; only the stored ones (2023–2025 in deaths_total) count.
	releases := profile.Releases
	if releases == nil || !releases.Modelled || releases.DeathYears != "2023–2025" || releases.DeathRatesFrom != "Testna regija" {
		t.Fatalf("releases: %+v", releases)
	}
	// 65–69: deaths 2 over exposure 100+100 (2023H1 missing) = 0.01; alone 0.2; owners 0.75; pop 100.
	near(t, "65–69 releases", releases.ByAge[0].Releases, 100*0.01*0.2*0.75)
	// 85+: deaths 4 over exposure 10+10 = 0.2; alone 0.5; pop 20.
	near(t, "85+ releases", releases.ByAge[4].Releases, 20*0.2*0.5*0.75)
	near(t, "total", releases.PerYear, 0.15+1.5)
	near(t, "per 1000 dwellings", *releases.PerThousandDwellings, 1.65/400*1000)

	summary := SummaryOf(profile)
	if summary.GeographyID != 7 || summary.ReleasesPerYear == nil || summary.NetMigrationPerThousand == nil {
		t.Fatalf("summary: %+v", summary)
	}
}

func TestComputeWithoutPopulationIsUnavailable(t *testing.T) {
	if _, err := Compute(Unit{Level: "country"}, Series{}, Series{}, Series{}, ""); err != ErrUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func TestRegionSumsMunicipalitiesAndKeepsRegionalDeaths(t *testing.T) {
	data := &Dataset{
		ByKey: map[string]Series{
			"municipality:1": {"population_total": {"2026H1": 10}, "net_migration_per_1000": {"2025": 5}},
			"municipality:2": {"population_total": {"2026H1": 20}},
			"municipality:3": {"population_total": {"2026H1": 99}},
			"region:4":       {"deaths_total": {"2025": 3}},
		},
		Municipality: map[int]Unit{1: {Code: 1, RegionCode: 4}, 2: {Code: 2, RegionCode: 4}, 3: {Code: 3, RegionCode: 5}},
	}
	region := data.regionSeries(4)
	near(t, "population", region["population_total"]["2026H1"], 30)
	near(t, "deaths", region["deaths_total"]["2025"], 3)
	if _, ok := region["net_migration_per_1000"]; ok {
		t.Fatal("rates must not be summed")
	}
}
