package analytics

import (
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

// queries is what every analytics repository shares: the connection and the remembered
// geography levels behind factFilter (sqlfilter.go). Repositories embed one *queries, so the
// level cache is shared by all of them.
type queries struct {
	db     database.Querier
	levels *geographyLevels
}

// SaleStatisticsRepository answers the sale overview, time series, outliers, extremes and
// municipality medians (StatisticsStore).
type SaleStatisticsRepository struct{ *queries }

// RentalStatisticsRepository answers the rental overview, time series, outliers and rental map
// layers (RentalStatisticsStore).
type RentalStatisticsRepository struct{ *queries }

// DistributionRepository answers the sale and rental histograms (DistributionStore).
type DistributionRepository struct{ *queries }

// MapRepository answers the sale map layers (MapStore).
type MapRepository struct{ *queries }

// TransactionRepository answers single agreements, their context and history, and the lists of
// recent agreements (TransactionDetailStore, HistoryStore, RecentStore).
type TransactionRepository struct {
	*queries
	now func() time.Time
}

// BuildingRepository answers building statistics and the address search (BuildingStore).
type BuildingRepository struct {
	*queries
	// search is the in-memory address index of SearchBuildings, reloaded per release.
	search *memo.Value[*releaseIndex]
}

// ValuationRepository answers the model outputs: market indices, valuation predictions and
// anomaly signals (ModelStore, AnomalyStore).
type ValuationRepository struct{ *queries }

// ReleaseRepository answers the analytical release status (ReleaseStore) and the id of the
// active release (ActiveReleaseStore).
type ReleaseRepository struct {
	*queries
	// active is the active release id, re-read every few seconds.
	active *memo.Value[string]
}

// Repositories are the analytics repositories, all reading through one connection.
type Repositories struct {
	Sales         *SaleStatisticsRepository
	Rentals       *RentalStatisticsRepository
	Distributions *DistributionRepository
	Maps          *MapRepository
	Transactions  *TransactionRepository
	Buildings     *BuildingRepository
	Valuations    *ValuationRepository
	Releases      *ReleaseRepository
}

// NewRepositories returns the repositories reading through db (a pool, or a test transaction).
func NewRepositories(db database.Querier) Repositories {
	shared := &queries{db: db, levels: &geographyLevels{byID: map[int64]string{}}}
	buildings := &BuildingRepository{queries: shared}
	buildings.search = newAddressIndexCache(buildings)
	releases := &ReleaseRepository{queries: shared}
	releases.active = newActiveReleaseCache(releases)
	return Repositories{
		Sales:         &SaleStatisticsRepository{shared},
		Rentals:       &RentalStatisticsRepository{shared},
		Distributions: &DistributionRepository{shared},
		Maps:          &MapRepository{shared},
		Transactions:  &TransactionRepository{queries: shared, now: time.Now},
		Buildings:     buildings,
		Valuations:    &ValuationRepository{shared},
		Releases:      releases,
	}
}

var (
	_ StatisticsStore        = (*SaleStatisticsRepository)(nil)
	_ RentalStatisticsStore  = (*RentalStatisticsRepository)(nil)
	_ DistributionStore      = (*DistributionRepository)(nil)
	_ MapStore               = (*MapRepository)(nil)
	_ TransactionDetailStore = (*TransactionRepository)(nil)
	_ HistoryStore           = (*TransactionRepository)(nil)
	_ RecentStore            = (*TransactionRepository)(nil)
	_ BuildingStore          = (*BuildingRepository)(nil)
	_ ModelStore             = (*ValuationRepository)(nil)
	_ AnomalyStore           = (*ValuationRepository)(nil)
	_ ReleaseStore           = (*ReleaseRepository)(nil)
	_ ActiveReleaseStore     = (*ReleaseRepository)(nil)
)
