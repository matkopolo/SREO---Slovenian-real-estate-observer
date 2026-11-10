// Package demography turns published SURS population, deaths, migration and census housing
// stock into a demographic context for an area, including a modelled estimate of dwellings
// potentially released each year by older owners who live alone. It is context, not a
// forecast of listings or prices.
package demography

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

// ErrUnavailable means the SURS demographic tables are not stored yet.
var ErrUnavailable = errors.New("demographic context is unavailable")

// Unit identifies an area of the RPE hierarchy.
type Unit struct {
	ID         int64  `json:"id"`
	Level      string `json:"level"`
	Code       int    `json:"code"`
	Name       string `json:"name"`
	RegionCode int    `json:"-"` // statistical region of a municipality (its own code for a region)
}

// Series maps series name -> period -> value for one area (municipal values summed).
type Series map[string]map[string]float64

func (s Series) value(series, period string) (float64, bool) {
	value, ok := s[series][period]
	return value, ok
}

func (s Series) add(series, period string, value float64) {
	if s[series] == nil {
		s[series] = map[string]float64{}
	}
	s[series][period] += value
}

// Periods returns the sorted periods published for a series.
func (s Series) periods(series string) []string {
	periods := make([]string, 0, len(s[series]))
	for period := range s[series] {
		periods = append(periods, period)
	}
	sort.Strings(periods)
	return periods
}

// Dataset holds every stored SURS demographic series keyed by context-series geography key.
type Dataset struct {
	ByKey        map[string]Series
	Municipality map[int]Unit // by municipality code
	Regions      map[int]Unit // by region code
	Country      Unit
}

// AgeGroup is one population-pyramid bar.
type AgeGroup struct {
	Group      string   `json:"group"`
	Population float64  `json:"population"`
	Earlier    *float64 `json:"earlier"`
}

type Population struct {
	Total            float64  `json:"total"`
	Change5Years     *float64 `json:"change5Years"`
	Change10Years    *float64 `json:"change10Years"`
	Age0To14         float64  `json:"age0To14"`
	Age15To64        float64  `json:"age15To64"`
	Age25To34        float64  `json:"age25To34"`
	Age65Plus        float64  `json:"age65Plus"`
	Share65Plus      float64  `json:"share65Plus"`
	OldAgeDependency float64  `json:"oldAgeDependency"`
	// EnteringThirtiesPerYear approximates the yearly cohort reaching household-forming age (25–29 / 5).
	EnteringThirtiesPerYear float64 `json:"enteringThirtiesPerYear"`
}

type MigrationYear struct {
	Year          string   `json:"year"`
	Net           float64  `json:"net"`
	International *float64 `json:"international"`
	Internal      *float64 `json:"internal"`
	PerThousand   *float64 `json:"perThousand"`
}

type Housing struct {
	Year               string   `json:"year"`
	Dwellings          float64  `json:"dwellings"`
	Occupied           *float64 `json:"occupied"`
	Unoccupied         *float64 `json:"unoccupied"`
	Seasonal           *float64 `json:"seasonal"`
	Vacant             *float64 `json:"vacant"`
	SplitYear          *string  `json:"splitYear"` // census year of the seasonal/vacant split when 2021 has none
	OwnerOccupiedShare *float64 `json:"ownerOccupiedShare"`
	Households         *float64 `json:"households"`
	OnePersonShare     *float64 `json:"onePersonShare"`
	PersonsPerDwelling *float64 `json:"personsPerOccupiedDwelling"`
}

type ReleaseAge struct {
	Group      string  `json:"group"`
	Population float64 `json:"population"`
	DeathRate  float64 `json:"deathRate"`
	AloneShare float64 `json:"aloneShare"`
	Releases   float64 `json:"releases"`
}

type Releases struct {
	PerYear              float64      `json:"perYear"`
	PerThousandDwellings *float64     `json:"perThousandDwellings"`
	OwnerShare           float64      `json:"ownerShare"`
	DeathYears           string       `json:"deathYears"`
	DeathRatesFrom       string       `json:"deathRatesFrom"`
	Modelled             bool         `json:"modelled"`
	ByAge                []ReleaseAge `json:"byAge"`
}

type Profile struct {
	Geography     Unit            `json:"geography"`
	Period        string          `json:"period"`
	EarlierPeriod *string         `json:"earlierPeriod"`
	Population    Population      `json:"population"`
	Pyramid       []AgeGroup      `json:"pyramid"`
	Migration     []MigrationYear `json:"migration"`
	Housing       *Housing        `json:"housing"`
	Releases      *Releases       `json:"releases"`
}

// Summary is the per-municipality subset used for maps.
type Summary struct {
	GeographyID             int64    `json:"geographyId"`
	Name                    string   `json:"name"`
	Population              float64  `json:"population"`
	Share65Plus             float64  `json:"share65Plus"`
	Change10Years           *float64 `json:"change10Years"`
	NetMigrationPerThousand *float64 `json:"netMigrationPerThousand"`
	ReleasesPerThousand     *float64 `json:"releasesPerThousandDwellings"`
	EnteringThirtiesPerYear float64  `json:"enteringThirtiesPerYear"`
	ReleasesPerYear         *float64 `json:"releasesPerYear"`
}

var pyramidGroups = func() []string {
	groups := make([]string, 0, 21)
	for start := 0; start < 100; start += 5 {
		groups = append(groups, fmt.Sprintf("%d_%d", start, start+4))
	}
	return append(groups, "100_plus")
}()

// releaseGroups are the 65+ groups of the living-alone table; 85+ pools the older groups.
var releaseGroups = []struct {
	name    string
	members []string
}{
	{"65_69", []string{"65_69"}}, {"70_74", []string{"70_74"}}, {"75_79", []string{"75_79"}},
	{"80_84", []string{"80_84"}}, {"85_plus", []string{"85_89", "90_94", "95_99", "100_plus"}},
}

func label(group string) string {
	return strings.NewReplacer("_plus", "+", "_", "–").Replace(group)
}

func ptr[T any](value T) *T { return &value }

func sum(series Series, period string, groups ...string) float64 {
	total := 0.0
	for _, group := range groups {
		value, _ := series.value("population_"+group, period)
		total += value
	}
	return total
}

func ratio(numerator, denominator float64) *float64 {
	if denominator <= 0 || math.IsNaN(numerator) {
		return nil
	}
	return ptr(numerator / denominator)
}

// shift returns the H1 period n years before period ("2026H1" -> "2016H1").
func shift(period string, years int) string {
	var year int
	if _, err := fmt.Sscanf(period, "%dH1", &year); err != nil {
		return ""
	}
	return fmt.Sprintf("%dH1", year-years)
}

func latestCensus(series Series, name string) (string, float64, bool) {
	periods := series.periods(name)
	if len(periods) == 0 {
		return "", 0, false
	}
	period := periods[len(periods)-1]
	return period, series[name][period], true
}

// Compute builds the profile of an area. local holds the area's (summed) series, deathArea the
// series of the area whose deaths and population give the age-specific death rates, and
// national the Slovenian series (living-alone shares by age are published nationally only).
func Compute(unit Unit, local, deathArea, national Series, deathRatesFrom string) (Profile, error) {
	populationPeriods := local.periods("population_total")
	if len(populationPeriods) == 0 {
		return Profile{}, ErrUnavailable
	}
	period := populationPeriods[len(populationPeriods)-1]
	profile := Profile{Geography: unit, Period: period}
	total, _ := local.value("population_total", period)
	population := Population{Total: total}
	if earlier, ok := local.value("population_total", shift(period, 5)); ok && earlier > 0 {
		population.Change5Years = ptr(total/earlier - 1)
	}
	earlierPeriod := shift(period, 10)
	if earlier, ok := local.value("population_total", earlierPeriod); ok && earlier > 0 {
		population.Change10Years = ptr(total/earlier - 1)
		profile.EarlierPeriod = &earlierPeriod
	}
	population.Age0To14 = sum(local, period, "0_4", "5_9", "10_14")
	population.Age15To64 = sum(local, period, "15_19", "20_24", "25_29", "30_34", "35_39", "40_44", "45_49", "50_54", "55_59", "60_64")
	population.Age25To34 = sum(local, period, "25_29", "30_34")
	population.Age65Plus = sum(local, period, "65_69", "70_74", "75_79", "80_84", "85_89", "90_94", "95_99", "100_plus")
	population.EnteringThirtiesPerYear = sum(local, period, "25_29") / 5
	if total > 0 {
		population.Share65Plus = population.Age65Plus / total
	}
	if population.Age15To64 > 0 {
		population.OldAgeDependency = population.Age65Plus / population.Age15To64
	}
	profile.Population = population

	for _, group := range pyramidGroups {
		bar := AgeGroup{Group: label(group), Population: sum(local, period, group)}
		if profile.EarlierPeriod != nil {
			if value, ok := local.value("population_"+group, earlierPeriod); ok {
				bar.Earlier = ptr(value)
			}
		}
		profile.Pyramid = append(profile.Pyramid, bar)
	}

	for _, year := range local.periods("net_migration_total") {
		net, _ := local.value("net_migration_total", year)
		row := MigrationYear{Year: year, Net: net}
		if value, ok := local.value("net_migration_international", year); ok {
			row.International = ptr(value)
		}
		if value, ok := local.value("net_migration_internal", year); ok {
			row.Internal = ptr(value)
		}
		if people, ok := local.value("population_total", year+"H1"); ok && people > 0 {
			row.PerThousand = ptr(net / people * 1000)
		}
		profile.Migration = append(profile.Migration, row)
	}

	if year, dwellings, ok := latestCensus(local, "dwellings_total"); ok {
		housing := &Housing{Year: year, Dwellings: dwellings}
		if value, ok := local.value("dwellings_occupied", year); ok {
			housing.Occupied = ptr(value)
		}
		if value, ok := local.value("dwellings_unoccupied", year); ok {
			housing.Unoccupied = ptr(value)
		}
		// SURS left the 2021 seasonal/vacant split empty; fall back to the latest year that has it.
		if splitYear, vacant, ok := latestCensus(local, "dwellings_vacant"); ok {
			housing.Vacant = ptr(vacant)
			if value, ok := local.value("dwellings_seasonal", splitYear); ok {
				housing.Seasonal = ptr(value)
			}
			housing.SplitYear = &splitYear
		}
		owners, _ := local.value("dwellings_owner_occupied", year)
		tenureTotal, _ := local.value("occupied_dwellings_tenure_total", year)
		housing.OwnerOccupiedShare = ratio(owners, tenureTotal)
		if households, ok := local.value("households_total", year); ok {
			housing.Households = ptr(households)
			onePerson, _ := local.value("households_one_person", year)
			housing.OnePersonShare = ratio(onePerson, households)
		}
		if housing.Occupied != nil {
			if people, ok := local.value("population_total", fmt.Sprintf("%sH1", year)); ok {
				housing.PersonsPerDwelling = ratio(people, *housing.Occupied)
			}
		}
		profile.Housing = housing
		profile.Releases = releases(population, local, deathArea, national, period, housing, unit.Level != "country", deathRatesFrom)
	}
	return profile, nil
}

func releases(population Population, local, deathArea, national Series, period string, housing *Housing, modelled bool, from string) *Releases {
	if housing.OwnerOccupiedShare == nil {
		return nil
	}
	deathYears := deathArea.periods("deaths_total")
	if len(deathYears) > 3 {
		deathYears = deathYears[len(deathYears)-3:]
	}
	aloneYear, _, ok := latestCensus(national, "living_alone_total")
	if len(deathYears) == 0 || !ok {
		return nil
	}
	result := &Releases{OwnerShare: *housing.OwnerOccupiedShare, Modelled: modelled, DeathRatesFrom: from,
		DeathYears: deathYears[0] + "–" + deathYears[len(deathYears)-1]}
	if len(deathYears) == 1 {
		result.DeathYears = deathYears[0]
	}
	for _, group := range releaseGroups {
		deaths, exposed := 0.0, 0.0
		for _, year := range deathYears {
			for _, member := range group.members {
				value, _ := deathArea.value("deaths_"+member, year)
				deaths += value
			}
			exposed += sum(deathArea, year+"H1", group.members...)
		}
		alone, _ := national.value("living_alone_"+group.name, aloneYear)
		persons, _ := national.value("persons_"+group.name, aloneYear)
		if exposed <= 0 || persons <= 0 {
			return nil
		}
		row := ReleaseAge{Group: label(group.name), Population: sum(local, period, group.members...),
			DeathRate: deaths / exposed, AloneShare: alone / persons}
		row.Releases = row.Population * row.DeathRate * row.AloneShare * result.OwnerShare
		result.PerYear += row.Releases
		result.ByAge = append(result.ByAge, row)
	}
	result.PerThousandDwellings = ratio(result.PerYear*1000, housing.Dwellings)
	return result
}

// SummaryOf condenses a profile for the municipal map.
func SummaryOf(profile Profile) Summary {
	summary := Summary{GeographyID: profile.Geography.ID, Name: profile.Geography.Name,
		Population: profile.Population.Total, Share65Plus: profile.Population.Share65Plus,
		Change10Years: profile.Population.Change10Years, EnteringThirtiesPerYear: profile.Population.EnteringThirtiesPerYear}
	// Five-year average net migration per 1,000 residents keeps one-off years from dominating.
	recent := profile.Migration
	if len(recent) > 5 {
		recent = recent[len(recent)-5:]
	}
	rates, count := 0.0, 0
	for _, year := range recent {
		// Years above ±100 per 1,000 are registry artefacts (e.g. mass re-registrations), not migration.
		if year.PerThousand != nil && math.Abs(*year.PerThousand) <= 100 {
			rates += *year.PerThousand
			count++
		}
	}
	if count > 0 {
		summary.NetMigrationPerThousand = ptr(rates / float64(count))
	}
	if profile.Releases != nil {
		summary.ReleasesPerThousand = profile.Releases.PerThousandDwellings
		summary.ReleasesPerYear = ptr(profile.Releases.PerYear)
	}
	return summary
}

// Store serves demographic profiles.
type Store interface {
	Profile(ctx context.Context, geographyID *int64) (Profile, error)
	Municipalities(ctx context.Context) ([]Summary, error)
}

// ErrUnsupportedLevel means profiles exist only for Slovenia, regions and municipalities.
var ErrUnsupportedLevel = errors.New("demographics are published for Slovenia, statistical regions and municipalities")

// ErrNotFound means the geography does not exist.
var ErrNotFound = errors.New("geography not found")

// Repository reads the SURS series once and keeps them in memory for ten minutes; a failed
// reload keeps serving the previous dataset.
type Repository struct {
	pool    database.Querier
	dataset *memo.Value[*Dataset]
}

func NewRepository(pool database.Querier) *Repository {
	r := &Repository{pool: pool}
	r.dataset = memo.New(func(ctx context.Context, _ *Dataset, _ bool) (*Dataset, error) {
		return r.loadDataset(ctx)
	}, memo.Options{TTL: 10 * time.Minute, Timeout: time.Minute, RetryAfter: 30 * time.Second})
	return r
}

func (r *Repository) loadDataset(ctx context.Context) (*Dataset, error) {
	data := &Dataset{ByKey: map[string]Series{}, Municipality: map[int]Unit{}, Regions: map[int]Unit{}}
	units, err := r.pool.Query(ctx, `
		SELECT g.id, g.level, g.code, g.name, coalesce(p.code, g.code)
		FROM analytics.geographic_units g
		LEFT JOIN analytics.geographic_units p ON p.id = g.parent_id AND p.level = 'statistical_region'
		WHERE g.level IN ('country', 'statistical_region', 'municipality')`)
	if err != nil {
		return nil, fmt.Errorf("demography units: %w", err)
	}
	for units.Next() {
		var unit Unit
		if err := units.Scan(&unit.ID, &unit.Level, &unit.Code, &unit.Name, &unit.RegionCode); err != nil {
			units.Close()
			return nil, fmt.Errorf("scan demography unit: %w", err)
		}
		switch unit.Level {
		case "country":
			data.Country = unit
		case "statistical_region":
			data.Regions[unit.Code] = unit
		default:
			data.Municipality[unit.Code] = unit
		}
	}
	units.Close()
	if err := units.Err(); err != nil {
		return nil, fmt.Errorf("demography units: %w", err)
	}
	rows, err := r.pool.Query(ctx, `
		SELECT series, geography_key, period, value::float8 FROM analytics.context_series
		WHERE source = 'surs' AND (series LIKE 'population\_%' OR series LIKE 'deaths\_%'
		   OR series LIKE 'net\_migration\_%' OR series LIKE 'dwellings\_%' OR series LIKE 'households\_%'
		   OR series = 'occupied_dwellings_tenure_total' OR series LIKE 'living\_alone\_%' OR series LIKE 'persons\_%')`)
	if err != nil {
		return nil, fmt.Errorf("demography series: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var series, key, period string
		var value float64
		if err := rows.Scan(&series, &key, &period, &value); err != nil {
			return nil, fmt.Errorf("scan demography series: %w", err)
		}
		if data.ByKey[key] == nil {
			data.ByKey[key] = Series{}
		}
		data.ByKey[key].add(series, period, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("demography series: %w", err)
	}
	if len(data.ByKey["SI"]) == 0 {
		return nil, ErrUnavailable
	}
	return data, nil
}

// regionSeries sums a region's municipalities (SURS publishes most tables per municipality)
// and adds the region's own published series (deaths).
func (d *Dataset) regionSeries(code int) Series {
	result := Series{}
	for _, unit := range d.Municipality {
		if unit.RegionCode != code {
			continue
		}
		for series, periods := range d.ByKey[fmt.Sprintf("municipality:%d", unit.Code)] {
			if strings.HasPrefix(series, "deaths_") || series == "net_migration_per_1000" {
				continue
			}
			for period, value := range periods {
				result.add(series, period, value)
			}
		}
	}
	for series, periods := range d.ByKey[fmt.Sprintf("region:%d", code)] {
		for period, value := range periods {
			result.add(series, period, value)
		}
	}
	return result
}

// ProfileOf computes the profile of a unit from a loaded dataset.
func (d *Dataset) ProfileOf(unit Unit) (Profile, error) {
	national := d.ByKey["SI"]
	switch unit.Level {
	case "country":
		return Compute(unit, national, national, national, "Slovenija")
	case "statistical_region":
		region := d.regionSeries(unit.Code)
		return Compute(unit, region, region, national, unit.Name)
	case "municipality":
		region := d.regionSeries(unit.RegionCode)
		from := "Slovenija"
		deathArea := national
		if len(region["deaths_total"]) > 0 {
			deathArea, from = region, d.Regions[unit.RegionCode].Name
		}
		return Compute(unit, d.ByKey[fmt.Sprintf("municipality:%d", unit.Code)], deathArea, national, from)
	}
	return Profile{}, ErrUnsupportedLevel
}

func (r *Repository) Profile(ctx context.Context, geographyID *int64) (Profile, error) {
	data, err := r.dataset.Get(ctx)
	if err != nil {
		return Profile{}, err
	}
	if geographyID == nil || *geographyID == data.Country.ID {
		return data.ProfileOf(data.Country)
	}
	for _, unit := range data.Regions {
		if unit.ID == *geographyID {
			return data.ProfileOf(unit)
		}
	}
	for _, unit := range data.Municipality {
		if unit.ID == *geographyID {
			return data.ProfileOf(unit)
		}
	}
	var level string
	err = r.pool.QueryRow(ctx, `SELECT level FROM analytics.geographic_units WHERE id = $1`, *geographyID).Scan(&level)
	if errors.Is(err, pgx.ErrNoRows) {
		return Profile{}, ErrNotFound
	}
	if err != nil {
		return Profile{}, fmt.Errorf("demography geography: %w", err)
	}
	return Profile{}, ErrUnsupportedLevel
}

func (r *Repository) Municipalities(ctx context.Context) ([]Summary, error) {
	data, err := r.dataset.Get(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]Summary, 0, len(data.Municipality))
	for _, unit := range data.Municipality {
		profile, err := data.ProfileOf(unit)
		if err != nil {
			continue // a municipality without published population (none today) is skipped
		}
		items = append(items, SummaryOf(profile))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}
