package analytics

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
	"time"
)

// previousCurrentMarketSearch is the search as it ran before the single-query rewrite: one
// query per tier (package match, start year, radius), each returning the nearest 250 rows.
func previousCurrentMarketSearch(all []marketCandidate, signature string, thisYear int) currentMarketSelection {
	query := func(radius, startYear int, requirePackageMatch bool) []marketCandidate {
		result := []marketCandidate{}
		for _, candidate := range all {
			if candidate.distance <= float64(radius) && candidate.contractDate.Year() >= startYear &&
				(!requirePackageMatch || candidate.packageSignature == signature) {
				result = append(result, candidate)
			}
			if len(result) == 250 {
				break
			}
		}
		return result
	}
	var selected []marketCandidate
	selectedRadius, selectedStartYear := 0, thisYear
	matched := true
	search := func(requirePackageMatch bool) {
		targetReached := false
		for _, startYear := range []int{thisYear, thisYear - 1} {
			for _, radius := range []int{1000, 2500, 5000, 10000, 20000} {
				candidates := query(radius, startYear, requirePackageMatch)
				if len(candidates) > len(selected) {
					selected, selectedRadius, selectedStartYear = candidates, radius, startYear
				}
				if len(candidates) >= currentMarketTargetSample {
					selected, selectedRadius, selectedStartYear = candidates, radius, startYear
					targetReached = true
					break
				}
			}
			if targetReached {
				break
			}
		}
	}
	search(true)
	if len(selected) < currentMarketMinimumSample {
		selected, matched = nil, false
		search(false)
	}
	if len(selected) < currentMarketMinimumSample {
		return currentMarketSelection{}
	}
	return currentMarketSelection{candidates: selected, radius: selectedRadius, startYear: selectedStartYear, packageMatched: matched}
}

// withLazySignatures strips the signatures from candidates and returns a loader that restores
// them per radius, counting the rows it had to sign.
func withLazySignatures(all []marketCandidate) ([]marketCandidate, func(int) error, *int) {
	stripped := make([]marketCandidate, len(all))
	copy(stripped, all)
	for index := range stripped {
		stripped[index].packageSignature = ""
	}
	signed := 0
	known := 0
	return stripped, func(radius int) error {
		for known < len(stripped) && stripped[known].distance <= float64(radius) {
			stripped[known].packageSignature = all[known].packageSignature
			known++
			signed++
		}
		return nil
	}, &signed
}

func randomCandidates(random *rand.Rand, count, thisYear int) []marketCandidate {
	candidates := make([]marketCandidate, count)
	for index := range candidates {
		year := thisYear - random.Intn(2)
		signature := "2"
		if random.Float64() < 0.3 {
			signature = "2,3"
		}
		candidates[index] = marketCandidate{
			transactionID:    int64(index + 1),
			distance:         float64(random.Intn(20001)),
			contractDate:     time.Date(year, time.Month(1+random.Intn(12)), 1, 0, 0, 0, 0, time.UTC),
			packageSignature: signature,
			amountPerSQM:     1000 + random.Float64()*4000,
			area:             50,
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].distance != candidates[j].distance {
			return candidates[i].distance < candidates[j].distance
		}
		return candidates[i].transactionID < candidates[j].transactionID
	})
	return candidates
}

func TestCurrentMarketSelectionMatchesThePerTierQueries(t *testing.T) {
	const thisYear = 2026
	random := rand.New(rand.NewSource(20261109))
	for iteration := range 400 {
		// Sizes around the sample thresholds and the 250-row tier limit.
		count := []int{0, 3, 8, 40, 60, 120, 300, 700, 1500}[iteration%9]
		all := randomCandidates(random, count, thisYear)
		if iteration%4 == 0 {
			// Dense clusters create distance ties.
			for index := range all {
				all[index].distance = float64(int(all[index].distance) / 2500 * 2500)
			}
			sort.SliceStable(all, func(i, j int) bool {
				if all[i].distance != all[j].distance {
					return all[i].distance < all[j].distance
				}
				return all[i].transactionID < all[j].transactionID
			})
		}
		want := previousCurrentMarketSearch(all, "2", thisYear)
		candidates, load, _ := withLazySignatures(all)
		got, err := selectCurrentCandidates(candidates, "2", thisYear, load, true)
		if err != nil {
			t.Fatal(err)
		}
		for _, candidate := range got.candidates {
			if candidate.packageSignature == "" {
				t.Fatalf("iteration %d: selected candidate %d without its signature", iteration, candidate.transactionID)
			}
		}
		if len(want.candidates) == 0 {
			if len(got.candidates) >= currentMarketMinimumSample {
				t.Fatalf("iteration %d: previous search found nothing, new found %d", iteration, len(got.candidates))
			}
			continue
		}
		if !reflect.DeepEqual(ids(want.candidates), ids(got.candidates)) || want.radius != got.radius ||
			want.startYear != got.startYear || want.packageMatched != got.packageMatched {
			t.Fatalf("iteration %d (%d candidates): want radius=%d year=%d matched=%v n=%d, got radius=%d year=%d matched=%v n=%d",
				iteration, count, want.radius, want.startYear, want.packageMatched, len(want.candidates),
				got.radius, got.startYear, got.packageMatched, len(got.candidates))
		}
	}
}

func ids(candidates []marketCandidate) []int64 {
	result := make([]int64, len(candidates))
	for index, candidate := range candidates {
		result[index] = candidate.transactionID
	}
	return result
}

func TestCurrentMarketSelectionSignsOnlyTheRadiusItNeeds(t *testing.T) {
	const thisYear = 2026
	all := make([]marketCandidate, 0, 400)
	for index := range 400 {
		// 60 same-package sales this year within 1 km, then 340 more out to 20 km.
		distance := float64(index * 50)
		all = append(all, marketCandidate{transactionID: int64(index + 1), distance: distance, packageSignature: "2",
			contractDate: time.Date(thisYear, 3, 1, 0, 0, 0, 0, time.UTC), amountPerSQM: 3000, area: 50})
	}
	candidates, load, signed := withLazySignatures(all)
	selection, err := selectCurrentCandidates(candidates, "2", thisYear, load, true)
	if err != nil {
		t.Fatal(err)
	}
	if selection.radius != 2500 || !selection.packageMatched || len(selection.candidates) != 51 {
		t.Fatalf("selection radius=%d matched=%v n=%d", selection.radius, selection.packageMatched, len(selection.candidates))
	}
	if *signed != 51 {
		t.Fatalf("signed %d rows, want only the 51 within 2.5 km", *signed)
	}
}

// With the composition as a preference the search goes on past a thin same-composition set and
// takes a larger mixed one; as a gate it stops at the first same-composition set of five.
func TestCurrentMarketSelectionCompositionPreferenceTakesTheLargerMixedSet(t *testing.T) {
	thisYear := 2026
	var candidates []marketCandidate
	for index := 0; index < 70; index++ {
		signature := "2"
		if index < 8 {
			signature = "2,3" // the subject's composition: eight, spread out to 20 km
		}
		candidates = append(candidates, marketCandidate{
			transactionID: int64(index + 1), distance: float64(index) * 280, packageSignature: signature,
			contractDate: time.Date(thisYear, 3, 1, 0, 0, 0, 0, time.UTC), amountPerSQM: 2000, area: 60,
		})
	}
	stripped, load, _ := withLazySignatures(candidates)
	gate, err := selectCurrentCandidates(stripped, "2,3", thisYear, load, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(gate.candidates) != 8 || !gate.packageMatched {
		t.Fatalf("gate: got %d candidates (matched=%v), want the 8 same-composition ones", len(gate.candidates), gate.packageMatched)
	}
	preference, err := selectCurrentCandidates(stripped, "2,3", thisYear, load, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(preference.candidates) != 70 || preference.packageMatched || preference.radius != 20000 {
		t.Fatalf("preference: got %d candidates (matched=%v, radius=%d), want all 70 mixed ones", len(preference.candidates), preference.packageMatched, preference.radius)
	}
	// A same-composition set that reaches the target is kept either way.
	for index := range candidates {
		candidates[index].packageSignature = "2,3"
	}
	stripped, load, _ = withLazySignatures(candidates)
	full, err := selectCurrentCandidates(stripped, "2,3", thisYear, load, false)
	if err != nil {
		t.Fatal(err)
	}
	if !full.packageMatched || len(full.candidates) < currentMarketTargetSample {
		t.Fatalf("full: got %d candidates (matched=%v)", len(full.candidates), full.packageMatched)
	}
}
