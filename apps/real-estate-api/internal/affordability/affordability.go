// Package affordability turns official wage statistics, average housing-loan rates and
// Banka Slovenije lending limits into an illustrative borrowing capacity per income band.
// It is a statistical illustration, never a credit offer or a personal assessment.
package affordability

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

// ErrUnavailable means the context series needed for the illustration are not stored yet.
var ErrUnavailable = errors.New("affordability context is unavailable")

// StressMarginPoints is the illustrative rate increase used for the stress scenario.
const StressMarginPoints = 1.0

// Rule holds the Banka Slovenije limits in force on a date.
type Rule struct {
	ValidFrom          string  `json:"validFrom"`
	DSTIMax            float64 `json:"dstiMax"`
	MinRemainingIncome float64 `json:"minRemainingIncome"`
	RecommendedLTV     float64 `json:"recommendedLtv"`
	SourceURL          string  `json:"sourceUrl"`
	Note               string  `json:"note"`
}

// Observation is one published value with its period and source table.
type Observation struct {
	Series      string  `json:"series"`
	Period      string  `json:"period"`
	Value       float64 `json:"value"`
	SourceTable string  `json:"sourceTable"`
}

// Band is one net monthly income level of a single borrower.
type Band struct {
	ID     string  `json:"id"`
	Income float64 `json:"netMonthlyIncome"`
}

// Row is the illustrative capacity of one income band.
type Row struct {
	Band             Band     `json:"band"`
	MaxInstalment    float64  `json:"maxInstalment"`
	FloorBinding     bool     `json:"floorBinding"`
	Loan20Years      float64  `json:"loan20Years"`
	Loan30Years      float64  `json:"loan30Years"`
	Loan30Variable   float64  `json:"loan30YearsVariable"`
	Loan30Stress     float64  `json:"loan30YearsStress"`
	PriceAtLTV       float64  `json:"priceAtRecommendedLtv"`
	DownPayment      float64  `json:"downPayment"`
	AffordableSqm    *float64 `json:"affordableSqm"`
	TwoEarnersLoan30 float64  `json:"twoEarnersLoan30Years"`
}

// Rates are the annual percentages used for the scenarios.
type Rates struct {
	Fixed    float64 // new housing loans, initial fixation over 10 years
	Variable float64 // new housing loans, floating or fixed up to 1 year
}

// Instalment is the largest monthly payment the rule allows for one borrower:
// at most DSTI × income, and the income left must not fall below the floor.
func Instalment(income float64, rule Rule) (float64, bool) {
	byRatio := rule.DSTIMax * income
	byFloor := income - rule.MinRemainingIncome
	if byFloor <= 0 {
		return 0, true
	}
	if byFloor < byRatio {
		return byFloor, true
	}
	return byRatio, false
}

// Principal is the present value of an annuity paying instalment monthly for years.
func Principal(instalment, annualPercent float64, years int) float64 {
	if instalment <= 0 || years <= 0 {
		return 0
	}
	months := float64(years * 12)
	rate := annualPercent / 100 / 12
	if rate == 0 {
		return instalment * months
	}
	return instalment * (1 - math.Pow(1+rate, -months)) / rate
}

// Compute builds one row per band. medianPerSqm may be nil (suppressed local median).
func Compute(bands []Band, rule Rule, rates Rates, medianPerSqm *float64) []Row {
	rows := make([]Row, 0, len(bands))
	for _, band := range bands {
		instalment, floor := Instalment(band.Income, rule)
		loan30 := Principal(instalment, rates.Fixed, 30)
		price := 0.0
		if rule.RecommendedLTV > 0 {
			price = loan30 / rule.RecommendedLTV
		}
		row := Row{
			Band: band, MaxInstalment: round(instalment), FloorBinding: floor,
			Loan20Years:      round(Principal(instalment, rates.Fixed, 20)),
			Loan30Years:      round(loan30),
			Loan30Variable:   round(Principal(instalment, rates.Variable, 30)),
			Loan30Stress:     round(Principal(instalment, rates.Fixed+StressMarginPoints, 30)),
			PriceAtLTV:       round(price),
			DownPayment:      round(price - loan30),
			TwoEarnersLoan30: round(2 * loan30),
		}
		if medianPerSqm != nil && *medianPerSqm > 0 {
			sqm := math.Round(price / *medianPerSqm)
			row.AffordableSqm = &sqm
		}
		rows = append(rows, row)
	}
	return rows
}

func round(value float64) float64 { return math.Round(value) }

// HouseholdResult sums the per-borrower limits: Banka Slovenije applies DSTI and the
// remaining-income floor to each borrower separately.
type HouseholdResult struct {
	Incomes        []float64 `json:"netIncomes"`
	MaxInstalment  float64   `json:"maxInstalment"`
	FloorBinding   bool      `json:"floorBinding"`
	Loan20Years    float64   `json:"loan20Years"`
	Loan30Years    float64   `json:"loan30Years"`
	Loan30Stress   float64   `json:"loan30YearsStress"`
	MaxLoanToValue float64   `json:"recommendedLtv"`
}

func Household(incomes []float64, rule Rule, rates Rates) HouseholdResult {
	result := HouseholdResult{Incomes: incomes, MaxLoanToValue: rule.RecommendedLTV}
	for _, income := range incomes {
		instalment, floor := Instalment(income, rule)
		result.MaxInstalment += instalment
		result.FloorBinding = result.FloorBinding || floor
		result.Loan20Years += Principal(instalment, rates.Fixed, 20)
		result.Loan30Years += Principal(instalment, rates.Fixed, 30)
		result.Loan30Stress += Principal(instalment, rates.Fixed+StressMarginPoints, 30)
	}
	result.MaxInstalment, result.Loan20Years = round(result.MaxInstalment), round(result.Loan20Years)
	result.Loan30Years, result.Loan30Stress = round(result.Loan30Years), round(result.Loan30Stress)
	return result
}

// Store reads the stored context series.
type Store interface {
	Rule(ctx context.Context, on time.Time) (Rule, error)
	Wages(ctx context.Context, geographyKey string) ([]Observation, error)
	Latest(ctx context.Context, series string) (Observation, error)
	AllWages(ctx context.Context) (map[string][]Observation, error)
}

// Repository implements Store on PostgreSQL.
type Repository struct{ pool database.Querier }

func NewRepository(pool database.Querier) *Repository { return &Repository{pool: pool} }

func (r *Repository) Rule(ctx context.Context, on time.Time) (Rule, error) {
	var rule Rule
	var validFrom time.Time
	err := r.pool.QueryRow(ctx, `
		SELECT valid_from, dsti_max::float8, min_remaining_income::float8,
		       recommended_ltv_primary::float8, source_url, note
		FROM analytics.lending_rules WHERE valid_from <= $1
		ORDER BY valid_from DESC LIMIT 1`, on).Scan(
		&validFrom, &rule.DSTIMax, &rule.MinRemainingIncome, &rule.RecommendedLTV, &rule.SourceURL, &rule.Note)
	if errors.Is(err, pgx.ErrNoRows) {
		return Rule{}, ErrUnavailable
	}
	if err != nil {
		return Rule{}, fmt.Errorf("lending rule: %w", err)
	}
	rule.ValidFrom = validFrom.Format("2006-01-02")
	return rule, nil
}

// Wages returns the newest period of the wage distribution for one geography key.
func (r *Repository) Wages(ctx context.Context, geographyKey string) ([]Observation, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT series, period, value::float8, source_table
		FROM analytics.context_series
		WHERE source = 'surs' AND geography_key = $1 AND series LIKE 'net\_wage\_%'
		  AND series <> 'net_wage_mean_monthly'
		  AND period = (SELECT max(period) FROM analytics.context_series
		                WHERE source = 'surs' AND geography_key = $1 AND series = 'net_wage_p50')
		ORDER BY series LIMIT 20`, geographyKey)
	if err != nil {
		return nil, fmt.Errorf("wage distribution: %w", err)
	}
	observations, err := pgx.CollectRows(rows, pgx.RowToStructByPos[Observation])
	if err != nil {
		return nil, fmt.Errorf("wage distribution: %w", err)
	}
	return observations, nil
}

// AllWages returns the newest wage distribution of every geography key in one query.
func (r *Repository) AllWages(ctx context.Context) (map[string][]Observation, error) {
	rows, err := r.pool.Query(ctx, `
		WITH latest AS (
			SELECT geography_key, max(period) AS period FROM analytics.context_series
			WHERE source = 'surs' AND series = 'net_wage_p50' GROUP BY geography_key
		)
		SELECT c.geography_key, c.series, c.period, c.value::float8, c.source_table
		FROM analytics.context_series c JOIN latest l USING (geography_key, period)
		WHERE c.source = 'surs' AND c.series LIKE 'net\_wage\_%' AND c.series <> 'net_wage_mean_monthly'
		ORDER BY 1, 2`)
	if err != nil {
		return nil, fmt.Errorf("all wage distributions: %w", err)
	}
	defer rows.Close()
	wages := map[string][]Observation{}
	for rows.Next() {
		var key string
		var observation Observation
		if err := rows.Scan(&key, &observation.Series, &observation.Period, &observation.Value, &observation.SourceTable); err != nil {
			return nil, fmt.Errorf("scan wage distribution: %w", err)
		}
		wages[key] = append(wages[key], observation)
	}
	return wages, rows.Err()
}

// Latest returns the newest observation of a national series.
func (r *Repository) Latest(ctx context.Context, series string) (Observation, error) {
	var observation Observation
	err := r.pool.QueryRow(ctx, `
		SELECT series, period, value::float8, source_table FROM analytics.context_series
		WHERE series = $1 AND geography_key = 'SI' ORDER BY period DESC LIMIT 1`, series).Scan(
		&observation.Series, &observation.Period, &observation.Value, &observation.SourceTable)
	if errors.Is(err, pgx.ErrNoRows) {
		return Observation{}, ErrUnavailable
	}
	if err != nil {
		return Observation{}, fmt.Errorf("context series %s: %w", series, err)
	}
	return observation, nil
}
