package analytics

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

type ContextBenchmark struct {
	Scope              string  `json:"scope"`
	Label              string  `json:"label"`
	GeographyID        *int64  `json:"geographyId,omitempty"`
	MedianAmountPerSQM float64 `json:"medianAmountPerSqm"`
	SampleSize         int64   `json:"sampleSize"`
	DifferencePercent  float64 `json:"differencePercent"`
	Percentile         float64 `json:"percentile"`
	Period             int     `json:"period"`
	RadiusMeters       *int    `json:"radiusMeters,omitempty"`
	Reliability        string  `json:"reliability"`
	IsPublishable      bool    `json:"isPublishable"`
	ComparisonProfile  string  `json:"comparisonProfile"`
	AreaTolerancePct   *int    `json:"areaTolerancePercent,omitempty"`
	BuildingAgeYears   *int    `json:"constructionYearTolerance,omitempty"`
}

type DirectComparable struct {
	TransactionID                 int64   `json:"transactionId"`
	ContractDate                  string  `json:"contractDate"`
	ContractYear                  int     `json:"contractYear"`
	Area                          float64 `json:"area"`
	Amount                        float64 `json:"amount"`
	AmountPerSQM                  float64 `json:"amountPerSqm"`
	AreaDifferencePercent         float64 `json:"areaDifferencePercent"`
	AmountPerSQMDifferencePercent float64 `json:"amountPerSqmDifferencePercent"`
	YearDifference                int     `json:"yearDifference"`
	MatchTier                     string  `json:"matchTier"`
	ConstructionYear              *int    `json:"constructionYear,omitempty"`
	BuildingPartNumber            *string `json:"buildingPartNumber,omitempty"`
	IsRepresentative              bool    `json:"isRepresentative"`
	OutlierStatus                 *string `json:"outlierStatus,omitempty"`
}

type TransactionContext struct {
	TransactionKind    string                 `json:"transactionKind"`
	TransactionID      int64                  `json:"transactionId"`
	ContractYear       int                    `json:"contractYear"`
	IncompletePeriod   bool                   `json:"incompletePeriod"`
	PropertyGroup      string                 `json:"propertyGroup"`
	ActualAmountPerSQM float64                `json:"actualAmountPerSqm"`
	DirectComparables  []DirectComparable     `json:"directComparables"`
	Benchmarks         []ContextBenchmark     `json:"benchmarks"`
	Valuation          *ContextValuation      `json:"valuation"`
	CurrentMarket      *CurrentMarketEstimate `json:"currentMarketEstimate,omitempty"`
	Quality            QualityDecision        `json:"quality"`
	OutlierStatus      *string                `json:"outlierStatus"`
	MethodologyVersion string                 `json:"methodologyVersion"`
}

type CurrentMarketEstimate struct {
	LowerTotal                float64  `json:"lowerTotal"`
	CentralTotal              float64  `json:"centralTotal"`
	UpperTotal                float64  `json:"upperTotal"`
	UnadjustedLowerTotal      float64  `json:"unadjustedLowerTotal"`
	UnadjustedCentralTotal    float64  `json:"unadjustedCentralTotal"`
	UnadjustedUpperTotal      float64  `json:"unadjustedUpperTotal"`
	LowerAmountPerSQM         float64  `json:"lowerAmountPerSqm"`
	CentralAmountPerSQM       float64  `json:"centralAmountPerSqm"`
	UpperAmountPerSQM         float64  `json:"upperAmountPerSqm"`
	UnadjustedLowerPerSQM     float64  `json:"unadjustedLowerAmountPerSqm"`
	UnadjustedCentralPerSQM   float64  `json:"unadjustedCentralAmountPerSqm"`
	UnadjustedUpperPerSQM     float64  `json:"unadjustedUpperAmountPerSqm"`
	ComparableCount           int      `json:"comparableCount"`
	MaximumRadiusMeters       int      `json:"maximumRadiusMeters"`
	AreaTolerancePercent      int      `json:"areaTolerancePercent"`
	ConstructionYearTolerance *int     `json:"constructionYearTolerance,omitempty"`
	LocationAdjustmentFactor  float64  `json:"locationAdjustmentFactor"`
	RawLocationFactor         float64  `json:"rawLocationAdjustmentFactor"`
	LocationAdjustmentApplied bool     `json:"locationAdjustmentApplied"`
	LocalAdjustmentSampleSize int      `json:"localAdjustmentSampleSize"`
	PackageCompositionMatched bool     `json:"packageCompositionMatched"`
	ReferenceYear             int      `json:"referenceYear"`
	Confidence                string   `json:"confidence"`
	Warnings                  []string `json:"warnings"`
	MethodologyVersion        string   `json:"methodologyVersion"`
}

// ContextValuation is the public, decision-useful subset of the model result.
// Training diagnostics remain available from the dedicated valuation endpoint.
type ContextValuation struct {
	PredictedAmountPerSQM float64  `json:"predictedAmountPerSqm"`
	LowerAmountPerSQM     float64  `json:"lowerAmountPerSqm"`
	UpperAmountPerSQM     float64  `json:"upperAmountPerSqm"`
	PredictedTotal        float64  `json:"predictedTotal"`
	LowerTotal            float64  `json:"lowerTotal"`
	UpperTotal            float64  `json:"upperTotal"`
	ModelVersion          string   `json:"modelVersion"`
	Reliability           string   `json:"reliability"`
	Warnings              []string `json:"warnings"`
}

func benchmarkDifference(actual, median float64) (float64, bool) {
	if actual <= 0 || median <= 0 {
		return 0, false
	}
	return (actual/median - 1) * 100, true
}

func benchmarkReliability(sample int64) string {
	switch {
	case sample < 5:
		return "unavailable"
	case sample < 10:
		return "very_low"
	case sample < 30:
		return "low"
	default:
		return "moderate"
	}
}

type contextSubject struct {
	year             int
	propertyGroup    string
	actual           float64
	quality          QualityDecision
	outlierStatus    *string
	regionID         *int64
	municipalityID   *int64
	cityDistrictID   *int64
	localCommunityID *int64
	settlementID     *int64
	area             float64
	cadastralCode    *int32
	buildingNumber   *string
	constructionYear *int
	packageSignature string
}

func (r *StatisticsRepository) TransactionContext(
	ctx context.Context, kind string, id int64,
) (TransactionContext, error) {
	factTable, amountColumn := "analytics.sale_facts", "price_per_sqm"
	cohortTable := "analytics.sale_facts_strict_land"
	outlierTable := "analytics.sale_outlier_evaluations"
	if kind == "rent" {
		factTable, cohortTable = "analytics.rental_facts", "analytics.rental_facts"
		amountColumn = "monthly_rent_per_sqm"
		outlierTable = "analytics.rental_outlier_evaluations"
	} else if kind != "sale" {
		return TransactionContext{}, ErrTransactionNotFound
	}
	now := r.now()
	tx, err := database.BeginReadOnly(ctx, r.db, pgx.RepeatableRead)
	if err != nil {
		return TransactionContext{}, fmt.Errorf("begin transaction context: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var subject contextSubject
	packageSignatureExpression := "analytics.sale_package_signature(fact.transaction_id)"
	if kind == "rent" {
		packageSignatureExpression = "analytics.rental_package_signature(fact.transaction_id)"
	}
	query := fmt.Sprintf(`
		SELECT extract(year FROM fact.contract_date)::integer,fact.property_group,
		  fact.%s::float8,fact.is_quality_eligible,
		  fact.representative_eligible,fact.quality_reasons,
		  coalesce(signal.flags,ARRAY[]::text[]),evaluation.status,
		  fact.statistical_region_id,fact.municipality_id,fact.city_district_id,
		  fact.local_community_id,fact.settlement_id,fact.area::float8,
		  fact.cadastral_municipality_code,fact.building_number,
		  fact.construction_year,%s
		FROM %s fact
		LEFT JOIN %s evaluation USING(transaction_id)
		LEFT JOIN analytics.anomaly_signals signal
		  ON signal.transaction_kind='%s' AND signal.transaction_id=fact.transaction_id
		WHERE fact.transaction_id=$1 AND fact.contract_date IS NOT NULL
		  AND fact.%s>0`, amountColumn, packageSignatureExpression,
		factTable, outlierTable, kind, amountColumn)
	err = tx.QueryRow(ctx, query, id).Scan(
		&subject.year, &subject.propertyGroup, &subject.actual,
		&subject.quality.IsQualityEligible, &subject.quality.IsRepresentative,
		&subject.quality.Reasons, &subject.quality.AnomalyFlags,
		&subject.outlierStatus, &subject.regionID,
		&subject.municipalityID, &subject.cityDistrictID,
		&subject.localCommunityID, &subject.settlementID, &subject.area,
		&subject.cadastralCode, &subject.buildingNumber, &subject.constructionYear,
		&subject.packageSignature,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return TransactionContext{}, ErrTransactionNotFound
	}
	if err != nil {
		return TransactionContext{}, fmt.Errorf("load context subject: %w", err)
	}
	result := TransactionContext{
		TransactionKind: kind, TransactionID: id, ContractYear: subject.year,
		IncompletePeriod: subject.year == now.Year(),
		PropertyGroup:    subject.propertyGroup, ActualAmountPerSQM: subject.actual,
		DirectComparables: []DirectComparable{}, Benchmarks: []ContextBenchmark{},
		Quality:            subject.quality,
		OutlierStatus:      subject.outlierStatus,
		MethodologyVersion: "physical-similarity-context-v3",
	}

	if subject.cadastralCode != nil && subject.buildingNumber != nil {
		direct, loadErr := loadDirectComparables(ctx, tx, directComparableQuery{
			table: factTable, amountColumn: amountColumn,
			transactionKind: kind,
			totalColumn:     map[string]string{"sale": "price", "rent": "monthly_rent_ex_vat"}[kind],
			outlierTable:    outlierTable, subjectID: id, actual: subject.actual,
			area: subject.area, propertyGroup: subject.propertyGroup, year: subject.year,
			cadastralCode: *subject.cadastralCode, buildingNumber: *subject.buildingNumber,
		})
		if loadErr != nil {
			return TransactionContext{}, loadErr
		}
		result.DirectComparables = direct
	}

	for _, profile := range nearbyBenchmarkProfiles(subject.constructionYear) {
		benchmark, ok, loadErr := loadNearbyBenchmark(ctx, tx, benchmarkQuery{
			table: cohortTable, subjectTable: factTable, amountColumn: amountColumn,
			subjectID: id, actual: subject.actual, subjectArea: subject.area,
			subjectConstructionYear: subject.constructionYear, profile: profile,
			propertyGroup: subject.propertyGroup, year: subject.year, scope: "nearby",
		}, nearbyBenchmarkRadii)
		if loadErr != nil {
			return TransactionContext{}, loadErr
		}
		if ok {
			result.Benchmarks = append(result.Benchmarks, benchmark)
			break
		}
	}

	geographies := []struct {
		scope, column, label string
		id                   *int64
	}{
		{"city_district", "city_district_id", "Mestna četrt", subject.cityDistrictID},
		{"local_community", "local_community_id", "Krajevna skupnost", subject.localCommunityID},
		{"settlement", "settlement_id", "Naselje", subject.settlementID},
		{"municipality", "municipality_id", "Občina", subject.municipalityID},
		{"statistical_region", "statistical_region_id", "Statistična regija", subject.regionID},
	}
	for _, geography := range geographies {
		if geography.id == nil {
			continue
		}
		profile := unadjustedBenchmarkProfile()
		if geography.scope != "municipality" && geography.scope != "statistical_region" {
			profile = matchedGeographyProfile(subject.constructionYear)
		}
		benchmark, ok, loadErr := loadContextBenchmark(ctx, tx, benchmarkQuery{
			table: cohortTable, subjectTable: factTable, amountColumn: amountColumn,
			subjectID: id, actual: subject.actual, subjectArea: subject.area,
			subjectConstructionYear: subject.constructionYear, profile: profile,
			propertyGroup: subject.propertyGroup, year: subject.year,
			scope: geography.scope, label: geography.label,
			geographyColumn: geography.column, geographyID: geography.id,
		})
		if loadErr != nil {
			return TransactionContext{}, loadErr
		}
		if ok {
			result.Benchmarks = append(result.Benchmarks, benchmark)
		}
	}
	country, ok, err := loadContextBenchmark(ctx, tx, benchmarkQuery{
		table: cohortTable, subjectTable: factTable, amountColumn: amountColumn,
		subjectID: id, actual: subject.actual,
		subjectArea: subject.area, subjectConstructionYear: subject.constructionYear,
		profile:       unadjustedBenchmarkProfile(),
		propertyGroup: subject.propertyGroup, year: subject.year,
		scope: "country", label: "Slovenija",
	})
	if err != nil {
		return TransactionContext{}, err
	}
	if ok {
		result.Benchmarks = append(result.Benchmarks, country)
	}

	currentMarket, estimateErr := loadCurrentMarketEstimate(ctx, tx, currentMarketQuery{
		table: cohortTable, subjectTable: factTable, amountColumn: amountColumn,
		transactionKind: kind,
		subjectID:       id, propertyGroup: subject.propertyGroup, area: subject.area,
		constructionYear: subject.constructionYear,
		packageSignature: subject.packageSignature,
		municipalityID:   subject.municipalityID,
		now:              now,
	})
	if estimateErr != nil {
		return TransactionContext{}, estimateErr
	}
	result.CurrentMarket = currentMarket

	valuation, valuationErr := r.ValuationPrediction(ctx, kind, id)
	if valuationErr == nil {
		result.Valuation = &ContextValuation{
			PredictedAmountPerSQM: valuation.PredictedAmountPerSQM,
			LowerAmountPerSQM:     valuation.LowerAmountPerSQM,
			UpperAmountPerSQM:     valuation.UpperAmountPerSQM,
			PredictedTotal:        valuation.PredictedTotal,
			LowerTotal:            valuation.LowerTotal,
			UpperTotal:            valuation.UpperTotal,
			ModelVersion:          valuation.ModelVersion,
			Reliability:           valuation.Reliability,
			Warnings:              valuation.Warnings,
		}
	} else if !errors.Is(valuationErr, ErrPredictionNotFound) {
		return TransactionContext{}, valuationErr
	}
	return result, tx.Commit(ctx)
}

type currentMarketQuery struct {
	table, subjectTable, amountColumn, propertyGroup string
	transactionKind, packageSignature                string
	subjectID                                        int64
	area                                             float64
	constructionYear                                 *int
	municipalityID                                   *int64
	// now is the reference time: the current year and the age of each comparable.
	now time.Time
}

type marketCandidate struct {
	transactionID                int64
	amountPerSQM, area, distance float64
	constructionYear             *int
	contractDate                 time.Time
	packageSignature             string
	municipalityID               *int64
}

const (
	currentMarketMinimumSample = 5
	currentMarketTargetSample  = 50
	// currentMarketCandidateLimit is the most comparables one search tier uses.
	currentMarketCandidateLimit = 250
	locationMinimumLocalSample  = 20
	locationMinimumTotalSample  = 50
	locationShrinkageStrength   = 30.0
)

// currentMarketRadii are the search tiers, narrowest first; the last is the widest search.
var currentMarketRadii = []int{1000, 2500, 5000, 10000, 20000}

// currentMarketSelection is the comparable set chosen for the estimate.
type currentMarketSelection struct {
	candidates     []marketCandidate
	radius         int
	startYear      int
	packageMatched bool
}

// selectCurrentCandidates picks the comparable set from candidates sorted by distance (then
// transaction id). It tries, in order, comparables of the same package composition and then any
// composition; within each, this calendar year before also the previous one; and widening
// radii. A tier uses its nearest currentMarketCandidateLimit comparables. The first tier that
// reaches the target sample wins; otherwise the largest tier seen (the earliest on ties).
//
// Package signatures are costly to compute, so they are loaded on demand: loadSignatures(r)
// must fill packageSignature for every candidate within r metres. The chosen comparables always
// have their signatures (the weights use them).
func selectCurrentCandidates(
	candidates []marketCandidate, packageSignature string, thisYear int, loadSignatures func(radius int) error,
) (currentMarketSelection, error) {
	var selected currentMarketSelection
	search := func(requirePackageMatch bool) error {
		for _, startYear := range []int{thisYear, thisYear - 1} {
			for _, radius := range currentMarketRadii {
				if requirePackageMatch {
					if err := loadSignatures(radius); err != nil {
						return err
					}
				}
				tier := currentMarketTier(candidates, packageSignature, requirePackageMatch, startYear, radius)
				if len(tier) > len(selected.candidates) || len(tier) >= currentMarketTargetSample {
					selected = currentMarketSelection{candidates: tier, radius: radius, startYear: startYear,
						packageMatched: requirePackageMatch}
				}
				if len(tier) >= currentMarketTargetSample {
					return nil
				}
			}
		}
		return nil
	}
	if err := search(true); err != nil {
		return currentMarketSelection{}, err
	}
	if len(selected.candidates) < currentMarketMinimumSample {
		selected = currentMarketSelection{}
		if err := search(false); err != nil {
			return currentMarketSelection{}, err
		}
	}
	if len(selected.candidates) >= currentMarketMinimumSample && !selected.packageMatched {
		if err := loadSignatures(selected.radius); err != nil {
			return currentMarketSelection{}, err
		}
		selected.candidates = currentMarketTier(candidates, packageSignature, false, selected.startYear, selected.radius)
	}
	return selected, nil
}

// currentMarketTier is one search tier: the nearest comparables within radius contracted from
// startYear on, optionally of the subject's package composition.
func currentMarketTier(
	candidates []marketCandidate, packageSignature string, requirePackageMatch bool, startYear, radius int,
) []marketCandidate {
	tier := []marketCandidate{}
	for _, candidate := range candidates {
		if candidate.distance > float64(radius) {
			break // sorted by distance
		}
		if candidate.contractDate.Year() < startYear ||
			(requirePackageMatch && candidate.packageSignature != packageSignature) {
			continue
		}
		tier = append(tier, candidate)
		if len(tier) == currentMarketCandidateLimit {
			break
		}
	}
	return tier
}

func loadCurrentMarketEstimate(
	ctx context.Context, tx database.Querier, input currentMarketQuery,
) (*CurrentMarketEstimate, error) {
	if input.area <= 0 {
		return nil, nil
	}
	thisYear := input.now.Year()
	profile := nearbyBenchmarkProfiles(input.constructionYear)[0]
	candidates, err := queryCurrentCandidates(ctx, tx, input, profile)
	if err != nil {
		return nil, err
	}
	selection, err := selectCurrentCandidates(candidates, input.packageSignature, thisYear,
		signatureLoader(ctx, tx, input.transactionKind, candidates))
	if err != nil {
		return nil, err
	}
	selected, selectedRadius := selection.candidates, selection.radius
	if len(selected) < currentMarketMinimumSample {
		return nil, nil
	}

	weighted := make([]weightedValue, 0, len(selected))
	localCurrent := 0
	for _, candidate := range selected {
		if input.municipalityID != nil && candidate.municipalityID != nil &&
			*input.municipalityID == *candidate.municipalityID {
			localCurrent++
		}
		areaTolerance := float64(profile.areaTolerancePercent) / 100
		areaScore := math.Max(0, 1-math.Abs(candidate.area/input.area-1)/areaTolerance)
		ageScore := .5
		if input.constructionYear != nil && candidate.constructionYear != nil &&
			profile.constructionYearTolerance > 0 {
			ageScore = math.Max(0, 1-math.Abs(float64(*candidate.constructionYear-*input.constructionYear))/
				float64(profile.constructionYearTolerance))
		}
		distanceScore := math.Max(0, 1-candidate.distance/20000)
		recencyScore := math.Max(0, 1-input.now.Sub(candidate.contractDate).Hours()/(24*730))
		packageScore := 0.0
		if candidate.packageSignature == input.packageSignature {
			packageScore = 1
		}
		weight := 35*areaScore + 25*ageScore + 20*distanceScore + 10*recencyScore + 10*packageScore
		weighted = append(weighted, weightedValue{candidate.amountPerSQM, math.Max(weight, 1)})
	}

	locationFactor, rawLocationFactor, localSample, adjustmentErr := currentMarketLocationFactor(
		ctx, tx, input, profile, selectedRadius, localCurrent,
	)
	if adjustmentErr != nil {
		return nil, adjustmentErr
	}
	unadjustedLower := weightedQuantile(weighted, .25)
	unadjustedCentral := weightedQuantile(weighted, .5)
	unadjustedUpper := weightedQuantile(weighted, .75)
	lower := unadjustedLower * locationFactor
	central := unadjustedCentral * locationFactor
	upper := unadjustedUpper * locationFactor
	warnings := []string{"statistična tržna ocena, ne uradna cenitev", "tekoče leto še ni zaključeno"}
	if selection.startYear < thisYear {
		warnings = append(warnings, "za doseganje ciljnega vzorca so vključeni tudi posli prejšnjega koledarskega leta")
	}
	if len(selected) < currentMarketTargetSample {
		warnings = append(warnings, "cilj 50 primerljivih poslov ni bil dosežen znotraj največ 20 km")
	}
	if locationFactor != 1 {
		warnings = append(warnings, "uporabljena zgodovinska prilagoditev med domačo občino in okoliškim trgom")
	} else if rawLocationFactor != 1 {
		warnings = append(warnings, "lokalna prilagoditev ni uporabljena zaradi premajhnega podpornega vzorca")
	}
	if !selection.packageMatched {
		warnings = append(warnings, "premalo poslov z enako sestavo vrst sestavin paketa; uporabljena je mešana sestava paketov")
	}
	confidence := "very_low"
	if len(selected) >= 20 {
		confidence = "low"
	}
	if len(selected) >= currentMarketTargetSample && selectedRadius <= 10000 && profile.areaTolerancePercent == 15 {
		confidence = "moderate"
	}
	var ageTolerance *int
	if profile.constructionYearTolerance > 0 {
		ageTolerance = &profile.constructionYearTolerance
	}
	return &CurrentMarketEstimate{
		LowerTotal: lower * input.area, CentralTotal: central * input.area, UpperTotal: upper * input.area,
		UnadjustedLowerTotal: unadjustedLower * input.area, UnadjustedCentralTotal: unadjustedCentral * input.area,
		UnadjustedUpperTotal: unadjustedUpper * input.area,
		LowerAmountPerSQM:    lower, CentralAmountPerSQM: central, UpperAmountPerSQM: upper,
		UnadjustedLowerPerSQM: unadjustedLower, UnadjustedCentralPerSQM: unadjustedCentral,
		UnadjustedUpperPerSQM: unadjustedUpper,
		ComparableCount:       len(selected), MaximumRadiusMeters: selectedRadius,
		AreaTolerancePercent:      profile.areaTolerancePercent,
		ConstructionYearTolerance: ageTolerance, LocationAdjustmentFactor: locationFactor,
		RawLocationFactor: rawLocationFactor, LocationAdjustmentApplied: locationFactor != 1,
		LocalAdjustmentSampleSize: localSample, PackageCompositionMatched: selection.packageMatched,
		ReferenceYear: thisYear,
		Confidence:    confidence, Warnings: warnings,
		MethodologyVersion: "adaptive-current-market-v4",
	}, nil
}

// queryCurrentCandidates loads, in one query, every comparable any search tier of
// selectCurrentCandidates can use: the widest radius and the earliest start year, sorted by
// distance. Package signatures are not computed here (see signatureLoader).
func queryCurrentCandidates(
	ctx context.Context, tx database.Querier, input currentMarketQuery, profile benchmarkProfile,
) ([]marketCandidate, error) {
	thisYear := input.now.Year()
	var args queryArgs
	subject := args.add(input.subjectID)
	ageClause := "TRUE"
	if profile.constructionYearTolerance > 0 && input.constructionYear != nil {
		ageClause = fmt.Sprintf("fact.construction_year IS NOT NULL AND abs(fact.construction_year-%s)<=%d",
			args.add(*input.constructionYear), profile.constructionYearTolerance)
	}
	query := fmt.Sprintf(`
	SELECT fact.transaction_id,fact.%[1]s::float8,fact.area::float8,
	  ST_Distance(fact.location,subject.location)::float8 distance,fact.construction_year,
	  fact.contract_date,fact.municipality_id
	FROM %[2]s fact CROSS JOIN (SELECT location FROM %[3]s WHERE transaction_id=%[4]s) subject
	WHERE fact.transaction_id<>%[4]s AND fact.property_group=%[5]s
	  AND fact.contract_date>=make_date(%[6]s-1,1,1) AND fact.contract_date<make_date(%[6]s+1,1,1)
	  AND fact.representative_eligible AND fact.%[1]s>0 AND fact.area>0
	  AND subject.location IS NOT NULL AND fact.location IS NOT NULL
	  AND ST_DWithin(fact.location,subject.location,%[7]s)
	  AND abs(fact.area/%[8]s-1)<=%[9]f AND %[10]s
	  AND fact.transaction_id NOT IN (
	    SELECT candidate_transaction_id FROM analytics.near_duplicate_candidates
	    WHERE transaction_kind='%[11]s')
	ORDER BY distance,fact.transaction_id`,
		input.amountColumn, input.table, input.subjectTable, subject,
		args.add(input.propertyGroup), args.add(thisYear),
		args.add(currentMarketRadii[len(currentMarketRadii)-1]), args.add(input.area),
		float64(profile.areaTolerancePercent)/100, ageClause, input.transactionKind)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("load current market candidates: %w", err)
	}
	defer rows.Close()
	result := []marketCandidate{}
	for rows.Next() {
		var candidate marketCandidate
		if err := rows.Scan(&candidate.transactionID, &candidate.amountPerSQM, &candidate.area, &candidate.distance,
			&candidate.constructionYear, &candidate.contractDate, &candidate.municipalityID); err != nil {
			return nil, fmt.Errorf("scan current market candidate: %w", err)
		}
		result = append(result, candidate)
	}
	return result, rows.Err()
}

// signatureLoader returns the loadSignatures callback of selectCurrentCandidates: it computes
// the package signatures of the candidates within a radius that are still unknown, in one query.
func signatureLoader(
	ctx context.Context, tx database.Querier, kind string, candidates []marketCandidate,
) func(radius int) error {
	loaded := 0 // candidates are sorted by distance: the first loaded ones are known
	return func(radius int) error {
		end := loaded
		for end < len(candidates) && candidates[end].distance <= float64(radius) {
			end++
		}
		if end == loaded {
			return nil
		}
		ids := make([]int64, 0, end-loaded)
		for _, candidate := range candidates[loaded:end] {
			ids = append(ids, candidate.transactionID)
		}
		rows, err := tx.Query(ctx, fmt.Sprintf(`SELECT id,%s FROM unnest($1::bigint[]) id`,
			packageSignatureExpression(kind, "id")), ids)
		if err != nil {
			return fmt.Errorf("load package signatures: %w", err)
		}
		defer rows.Close()
		signatures := make(map[int64]string, len(ids))
		for rows.Next() {
			var id int64
			var signature string
			if err := rows.Scan(&id, &signature); err != nil {
				return fmt.Errorf("scan package signature: %w", err)
			}
			signatures[id] = signature
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("load package signatures: %w", err)
		}
		for index := loaded; index < end; index++ {
			candidates[index].packageSignature = signatures[candidates[index].transactionID]
		}
		loaded = end
		return nil
	}
}

// The near-duplicate exclusions in this file are written as NOT IN (a hashed anti-join over the
// candidate ids, about 50 ms) rather than NOT EXISTS: near_duplicate_candidates has no index
// led by candidate_transaction_id, so a per-row NOT EXISTS probes the primary key at ~10 ms
// per comparable. candidate_transaction_id is part of the primary key, so it is never NULL
// and NOT IN keeps NOT EXISTS semantics.
func packageSignatureExpression(kind, transactionExpression string) string {
	if kind == "rent" {
		return fmt.Sprintf("analytics.rental_package_signature(%s)", transactionExpression)
	}
	return fmt.Sprintf("analytics.sale_package_signature(%s)", transactionExpression)
}

func currentMarketLocationFactor(
	ctx context.Context, tx database.Querier, input currentMarketQuery, profile benchmarkProfile,
	radius, localCurrent int,
) (float64, float64, int, error) {
	if input.municipalityID == nil || localCurrent >= 5 {
		return 1, 1, localCurrent, nil
	}
	args := []any{input.subjectID, input.propertyGroup, input.now.Year() - 3,
		input.now.Year(), input.area, radius, *input.municipalityID}
	ageClause := "TRUE"
	if profile.constructionYearTolerance > 0 && input.constructionYear != nil {
		args = append(args, *input.constructionYear)
		ageClause = fmt.Sprintf("fact.construction_year IS NOT NULL AND abs(fact.construction_year-$%d)<=%d",
			len(args), profile.constructionYearTolerance)
	}
	query := fmt.Sprintf(`SELECT count(*) FILTER(WHERE fact.municipality_id=$7)::integer,
	  count(*)::integer,
	  percentile_cont(.5) WITHIN GROUP(ORDER BY fact.%s) FILTER(WHERE fact.municipality_id=$7)::float8,
	  percentile_cont(.5) WITHIN GROUP(ORDER BY fact.%s)::float8
	FROM %s fact CROSS JOIN (SELECT location FROM %s WHERE transaction_id=$1) subject
	WHERE fact.property_group=$2 AND extract(year FROM fact.contract_date)>=$3
	  AND extract(year FROM fact.contract_date)<$4 AND fact.representative_eligible
	  AND fact.%s>0 AND fact.area>0 AND fact.location IS NOT NULL
	  AND ST_DWithin(fact.location,subject.location,$6)
	  AND abs(fact.area/$5-1)<=%f AND %s
	  AND fact.transaction_id NOT IN (
	    SELECT candidate_transaction_id FROM analytics.near_duplicate_candidates
	    WHERE transaction_kind='%s')`, input.amountColumn, input.amountColumn,
		input.table, input.subjectTable, input.amountColumn,
		float64(profile.areaTolerancePercent)/100, ageClause, input.transactionKind)
	var localN, allN int
	var localMedian, allMedian *float64
	if err := tx.QueryRow(ctx, query, args...).Scan(&localN, &allN, &localMedian, &allMedian); err != nil {
		return 1, 1, 0, fmt.Errorf("load current market location adjustment: %w", err)
	}
	if localMedian == nil || allMedian == nil || *allMedian <= 0 {
		return 1, 1, localN, nil
	}
	rawFactor := math.Max(.65, math.Min(1.35, *localMedian / *allMedian))
	if localN < locationMinimumLocalSample || allN < locationMinimumTotalSample {
		return 1, rawFactor, localN, nil
	}
	return shrinkLocationFactor(rawFactor, localN), rawFactor, localN, nil
}

func shrinkLocationFactor(rawFactor float64, localSample int) float64 {
	weight := float64(localSample) / (float64(localSample) + locationShrinkageStrength)
	shrunkFactor := 1 + weight*(rawFactor-1)
	return math.Max(.8, math.Min(1.2, shrunkFactor))
}

type weightedValue struct{ value, weight float64 }

func weightedQuantile(values []weightedValue, quantile float64) float64 {
	sort.Slice(values, func(i, j int) bool { return values[i].value < values[j].value })
	var total float64
	for _, value := range values {
		total += value.weight
	}
	target, cumulative := total*quantile, 0.0
	for _, value := range values {
		cumulative += value.weight
		if cumulative >= target {
			return value.value
		}
	}
	return values[len(values)-1].value
}

type directComparableQuery struct {
	table, amountColumn, totalColumn, outlierTable, propertyGroup, buildingNumber string
	transactionKind                                                               string
	subjectID                                                                     int64
	actual, area                                                                  float64
	year                                                                          int
	cadastralCode                                                                 int32
}

func loadDirectComparables(
	ctx context.Context, tx database.Querier, input directComparableQuery,
) ([]DirectComparable, error) {
	query := fmt.Sprintf(`
		SELECT fact.transaction_id,fact.contract_date::text,
		  extract(year FROM fact.contract_date)::integer,fact.area::float8,
		  fact.%s::float8,fact.%s::float8,
		  100.0*(fact.area/$4-1)::float8,
		  100.0*(fact.%s/$3-1)::float8,
		  abs(extract(year FROM fact.contract_date)::integer-$5),
		  CASE
		    WHEN extract(year FROM fact.contract_date)::integer=$5
		      AND abs(fact.area/$4-1)<=.15 THEN 1
		    WHEN abs(extract(year FROM fact.contract_date)::integer-$5)=1
		      AND abs(fact.area/$4-1)<=.15 THEN 2
		    WHEN extract(year FROM fact.contract_date)::integer=$5 THEN 3
		    ELSE 99
		  END match_tier,
		  fact.construction_year,fact.building_part_number,
		  fact.representative_eligible,evaluation.status
		FROM %s fact
		LEFT JOIN %s evaluation USING(transaction_id)
		WHERE fact.transaction_id<>$1 AND fact.property_group=$2
		  AND fact.cadastral_municipality_code=$6 AND fact.building_number=$7
		  AND fact.contract_date>=make_date($5-1,1,1)
		  AND fact.contract_date<make_date($5+2,1,1)
		  AND fact.is_quality_eligible AND fact.area>0 AND fact.%s>0
		  AND fact.%s>0
		  AND (extract(year FROM fact.contract_date)::integer=$5
		    OR abs(fact.area/$4-1)<=.15)
		  AND fact.transaction_id NOT IN (
		    SELECT candidate_transaction_id FROM analytics.near_duplicate_candidates
		    WHERE transaction_kind='%s')
		ORDER BY match_tier,abs(fact.area/$4-1),
		  abs(fact.contract_date-make_date($5,7,1)),fact.transaction_id
		LIMIT 8`, input.totalColumn, input.amountColumn, input.amountColumn,
		input.table, input.outlierTable, input.amountColumn, input.totalColumn,
		input.transactionKind)
	rows, err := tx.Query(ctx, query, input.subjectID, input.propertyGroup,
		input.actual, input.area, input.year, input.cadastralCode, input.buildingNumber)
	if err != nil {
		return nil, fmt.Errorf("load direct comparables: %w", err)
	}
	defer rows.Close()
	comparables := []DirectComparable{}
	for rows.Next() {
		var comparable DirectComparable
		var tier int
		if err := rows.Scan(
			&comparable.TransactionID, &comparable.ContractDate,
			&comparable.ContractYear, &comparable.Area, &comparable.Amount,
			&comparable.AmountPerSQM, &comparable.AreaDifferencePercent,
			&comparable.AmountPerSQMDifferencePercent, &comparable.YearDifference,
			&tier, &comparable.ConstructionYear, &comparable.BuildingPartNumber,
			&comparable.IsRepresentative, &comparable.OutlierStatus,
		); err != nil {
			return nil, fmt.Errorf("scan direct comparable: %w", err)
		}
		comparable.MatchTier = directComparableTier(tier)
		comparables = append(comparables, comparable)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate direct comparables: %w", err)
	}
	return comparables, nil
}

func directComparableTier(tier int) string {
	switch tier {
	case 1:
		return "same_building_same_year_area_15"
	case 2:
		return "same_building_adjacent_year_area_15"
	case 3:
		return "same_building_same_year"
	default:
		return "same_building_other"
	}
}

type benchmarkProfile struct {
	name                      string
	areaTolerancePercent      int
	constructionYearTolerance int
}

func nearbyBenchmarkProfiles(constructionYear *int) []benchmarkProfile {
	if constructionYear == nil {
		return []benchmarkProfile{{name: "area_15", areaTolerancePercent: 15}}
	}
	return []benchmarkProfile{
		{name: "area_15_age_8", areaTolerancePercent: 15, constructionYearTolerance: 8},
	}
}

func matchedGeographyProfile(constructionYear *int) benchmarkProfile {
	if constructionYear == nil {
		return benchmarkProfile{name: "area_15", areaTolerancePercent: 15}
	}
	return benchmarkProfile{name: "area_15_age_8", areaTolerancePercent: 15, constructionYearTolerance: 8}
}

func unadjustedBenchmarkProfile() benchmarkProfile {
	return benchmarkProfile{name: "unadjusted"}
}

type benchmarkQuery struct {
	table, subjectTable, amountColumn, propertyGroup, scope, label string
	subjectID                                                      int64
	year                                                           int
	actual                                                         float64
	geographyColumn                                                string
	geographyID                                                    *int64
	radius                                                         int
	subjectArea                                                    float64
	subjectConstructionYear                                        *int
	profile                                                        benchmarkProfile
}

// benchmarkPredicate is the population of a benchmark beyond the common conditions: its
// geography (or none for the country) and the profile's area and construction-year tolerances.
func benchmarkPredicate(input benchmarkQuery, args *queryArgs) string {
	predicate := "TRUE"
	if input.geographyID != nil {
		predicate = fmt.Sprintf("fact.%s=%s", input.geographyColumn, args.add(*input.geographyID))
	}
	if input.profile.areaTolerancePercent > 0 && input.subjectArea > 0 {
		predicate += fmt.Sprintf(" AND abs(fact.area/%s-1)<=%f", args.add(input.subjectArea),
			float64(input.profile.areaTolerancePercent)/100)
	}
	if input.profile.constructionYearTolerance > 0 && input.subjectConstructionYear != nil {
		predicate += fmt.Sprintf(" AND fact.construction_year IS NOT NULL AND abs(fact.construction_year-%s)<=%d",
			args.add(*input.subjectConstructionYear), input.profile.constructionYearTolerance)
	}
	return predicate
}

// benchmarkFrom is the common population of every benchmark: representative comparables of
// the subject's property group and contract year, without the subject. It adds $1..$4.
func benchmarkFrom(input benchmarkQuery, args *queryArgs) (subject, actual, conditions string) {
	subject = args.add(input.subjectID)
	group := args.add(input.propertyGroup)
	year := args.add(input.year)
	actual = args.add(input.actual)
	conditions = fmt.Sprintf(`fact.transaction_id<>%[1]s AND fact.property_group=%[2]s
		  AND fact.contract_date>=make_date(%[3]s,1,1) AND fact.contract_date<make_date(%[3]s+1,1,1)
		  AND fact.representative_eligible AND fact.%[4]s>0`, subject, group, year, input.amountColumn)
	return subject, actual, conditions
}

func loadContextBenchmark(
	ctx context.Context, tx database.Querier, input benchmarkQuery,
) (ContextBenchmark, bool, error) {
	var args queryArgs
	_, actual, conditions := benchmarkFrom(input, &args)
	predicate := benchmarkPredicate(input, &args)
	label := "NULL::text"
	if input.geographyID != nil {
		label = fmt.Sprintf("(SELECT name FROM analytics.geographic_units WHERE id=%s)", args.add(*input.geographyID))
	}
	query := fmt.Sprintf(`
		SELECT count(*)::bigint,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY fact.%[1]s)::float8,
		  100.0*count(*) FILTER(WHERE fact.%[1]s<=%[2]s)/NULLIF(count(*),0)::float8,
		  %[6]s
		FROM %[3]s fact
		WHERE %[4]s AND %[5]s`, input.amountColumn, actual, input.table, conditions, predicate, label)
	var sample int64
	var median, percentile *float64
	var name *string
	if err := tx.QueryRow(ctx, query, args...).Scan(&sample, &median, &percentile, &name); err != nil {
		return ContextBenchmark{}, false, fmt.Errorf("load %s context benchmark: %w", input.scope, err)
	}
	if name != nil {
		input.label = *name
	}
	return newContextBenchmark(input, sample, median, percentile)
}

// nearbyBenchmarkRadii are the nearby search radii, narrowest first.
var nearbyBenchmarkRadii = []int{500, 1000, 2500, 5000}

// loadNearbyBenchmark computes the nearby benchmark for every radius in one query and returns
// the narrowest radius with a usable sample.
func loadNearbyBenchmark(
	ctx context.Context, tx database.Querier, input benchmarkQuery, radii []int,
) (ContextBenchmark, bool, error) {
	var args queryArgs
	subject, actual, conditions := benchmarkFrom(input, &args)
	predicate := benchmarkPredicate(input, &args)
	query := fmt.Sprintf(`
		SELECT radius.meters,count(fact.transaction_id)::bigint,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY fact.%[1]s)::float8,
		  100.0*count(fact.transaction_id) FILTER(WHERE fact.%[1]s<=%[2]s)/NULLIF(count(fact.transaction_id),0)::float8
		FROM unnest(%[7]s::int[]) radius(meters)
		LEFT JOIN %[3]s fact ON %[4]s AND %[5]s
		  AND fact.location IS NOT NULL
		  AND ST_DWithin(fact.location,(SELECT location FROM %[6]s WHERE transaction_id=%[8]s),radius.meters)
		GROUP BY radius.meters ORDER BY radius.meters`,
		input.amountColumn, actual, input.table, conditions, predicate, input.subjectTable,
		args.add(radii), subject)
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return ContextBenchmark{}, false, fmt.Errorf("load nearby context benchmark: %w", err)
	}
	type radiusSample struct {
		radius             int
		sample             int64
		median, percentile *float64
	}
	var samples []radiusSample
	for rows.Next() {
		var item radiusSample
		if err := rows.Scan(&item.radius, &item.sample, &item.median, &item.percentile); err != nil {
			rows.Close()
			return ContextBenchmark{}, false, fmt.Errorf("scan nearby context benchmark: %w", err)
		}
		samples = append(samples, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return ContextBenchmark{}, false, fmt.Errorf("load nearby context benchmark: %w", err)
	}
	for _, item := range samples {
		radiusInput := input
		radiusInput.radius = item.radius
		radiusInput.label = fmt.Sprintf("Primerljivi posli v krogu %s", formatRadius(item.radius))
		benchmark, ok, err := newContextBenchmark(radiusInput, item.sample, item.median, item.percentile)
		if err != nil || ok {
			return benchmark, ok, err
		}
	}
	return ContextBenchmark{}, false, nil
}

// newContextBenchmark applies the minimum sample (5) and builds the benchmark; ok is false
// when there is no usable comparison.
func newContextBenchmark(input benchmarkQuery, sample int64, median, percentile *float64) (ContextBenchmark, bool, error) {
	if sample < 5 || median == nil || percentile == nil {
		return ContextBenchmark{}, false, nil
	}
	difference, valid := benchmarkDifference(input.actual, *median)
	if !valid {
		return ContextBenchmark{}, false, nil
	}
	benchmark := ContextBenchmark{
		Scope: input.scope, Label: input.label, GeographyID: input.geographyID,
		MedianAmountPerSQM: *median, SampleSize: sample,
		DifferencePercent: difference, Percentile: *percentile,
		Period: input.year, Reliability: benchmarkReliability(sample),
		IsPublishable:     sample >= descriptivePublicationThreshold,
		ComparisonProfile: input.profile.name,
	}
	if input.profile.areaTolerancePercent > 0 {
		benchmark.AreaTolerancePct = &input.profile.areaTolerancePercent
	}
	if input.profile.constructionYearTolerance > 0 {
		benchmark.BuildingAgeYears = &input.profile.constructionYearTolerance
	}
	if input.scope == "nearby" {
		radius := input.radius
		benchmark.RadiusMeters = &radius
	}
	return benchmark, true, nil
}

func formatRadius(radius int) string {
	if radius >= 1000 {
		return fmt.Sprintf("%.1f km", float64(radius)/1000)
	}
	return fmt.Sprintf("%d m", radius)
}
