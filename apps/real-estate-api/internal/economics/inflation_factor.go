package economics

import (
	"errors"
	"fmt"
	"time"
)

// ErrIncompleteSeries means the published monthly CPI series does not cover the whole interval.
var ErrIncompleteSeries = errors.New("monthly CPI series is incomplete")

// chainMonthlyRatios multiplies the month-on-month ratios from the month of from to the month
// of to. It fails with ErrIncompleteSeries when a month in between (or an endpoint) is missing.
func chainMonthlyRatios(ratios map[string]float64, from, to time.Time) (InflationFactor, error) {
	result := InflationFactor{From: monthStart(from).Format("2006-01-02"), To: monthStart(to).Format("2006-01-02"), Factor: 1, Source: "SURS H281S · INDEKS=1"}
	if from.After(to) {
		return result, errors.New("reversed CPI interval")
	}
	// Require the endpoint months to have been published, even for same-month sales.
	if _, ok := ratios[result.From]; !ok {
		return result, fmt.Errorf("%w: missing month %s", ErrIncompleteSeries, result.From)
	}
	if _, ok := ratios[result.To]; !ok {
		return result, fmt.Errorf("%w: missing month %s", ErrIncompleteSeries, result.To)
	}
	for month := monthStart(from).AddDate(0, 1, 0); !month.After(monthStart(to)); month = month.AddDate(0, 1, 0) {
		v, ok := ratios[month.Format("2006-01-02")]
		if !ok || v <= 0 {
			return result, fmt.Errorf("%w: missing month %s", ErrIncompleteSeries, month.Format("2006-01-02"))
		}
		result.Factor *= v
		result.Months++
	}
	return result, nil
}
