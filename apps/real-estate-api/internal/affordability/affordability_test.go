package affordability

import (
	"math"
	"testing"
)

var rule = Rule{DSTIMax: 0.5, MinRemainingIncome: 745, RecommendedLTV: 0.8}

func TestInstalmentAppliesTheBindingLimit(t *testing.T) {
	for _, tc := range []struct {
		income, want float64
		floor        bool
	}{
		{1379.49, 634.49, true}, // below 2 × 745 the remaining-income floor binds
		{1490, 745, false},      // both limits coincide
		{2518.48, 1259.24, false},
		{700, 0, true}, // income below the floor allows no instalment
	} {
		got, floor := Instalment(tc.income, rule)
		if math.Abs(got-tc.want) > 0.005 || floor != tc.floor {
			t.Errorf("Instalment(%v) = %v, %v; want %v, %v", tc.income, got, floor, tc.want, tc.floor)
		}
	}
}

func TestPrincipalMatchesTheAnnuityFormula(t *testing.T) {
	// 634 €/month, 3.27 % fixed, 30 years ≈ €145,311 (worked example in the proposal).
	if got := math.Round(Principal(634, 3.27, 30)); got != 145311 {
		t.Fatalf("Principal = %v, want 145311", got)
	}
	if got := Principal(100, 0, 1); got != 1200 {
		t.Fatalf("zero-rate principal = %v, want 1200", got)
	}
	if Principal(0, 3, 30) != 0 || Principal(100, 3, 0) != 0 {
		t.Fatal("non-positive instalment or term must give zero")
	}
}

func TestComputeDerivesPriceDownPaymentAndArea(t *testing.T) {
	median := 2000.0
	rows := Compute([]Band{{ID: "p50", Income: 1379}}, rule, Rates{Fixed: 3.27, Variable: 3.47}, &median)
	row := rows[0]
	if row.Loan30Years != 145311 || row.PriceAtLTV != 181639 || row.DownPayment != 36328 {
		t.Fatalf("unexpected row %+v", row)
	}
	if row.Loan30Stress >= row.Loan30Years || row.Loan30Variable >= row.Loan30Years {
		t.Fatalf("higher rates must lower the loan: %+v", row)
	}
	if row.AffordableSqm == nil || *row.AffordableSqm != 91 {
		t.Fatalf("affordable m² = %v, want 91", row.AffordableSqm)
	}
	if row.TwoEarnersLoan30 != 290623 {
		t.Fatalf("two earners = %v", row.TwoEarnersLoan30)
	}
	if rows := Compute([]Band{{ID: "p50", Income: 1379}}, rule, Rates{Fixed: 3.27}, nil); rows[0].AffordableSqm != nil {
		t.Fatal("a suppressed median must not produce an area")
	}
}

func TestHouseholdAppliesLimitsPerBorrower(t *testing.T) {
	rule := Rule{DSTIMax: 0.5, MinRemainingIncome: 819, RecommendedLTV: 0.8}
	rates := Rates{Fixed: 3.3, Variable: 4}
	single := Household([]float64{1453}, rule, rates)
	couple := Household([]float64{1453, 1453}, rule, rates)
	if couple.Loan30Years != 2*single.Loan30Years && math.Abs(couple.Loan30Years-2*single.Loan30Years) > 1 {
		t.Fatalf("couple %v, single %v", couple.Loan30Years, single.Loan30Years)
	}
	// 1453 − 819 = 634 < 0,5 × 1453: the remaining-income floor binds.
	if single.MaxInstalment != 634 || !single.FloorBinding || single.Loan30Stress >= single.Loan30Years {
		t.Fatalf("single %+v", single)
	}
	// Uneven incomes: the higher earner is limited by DSTI, the lower one by the floor.
	mixed := Household([]float64{4000, 1000}, rule, rates)
	if mixed.MaxInstalment != 2000+181 {
		t.Fatalf("mixed instalment %v", mixed.MaxInstalment)
	}
}
