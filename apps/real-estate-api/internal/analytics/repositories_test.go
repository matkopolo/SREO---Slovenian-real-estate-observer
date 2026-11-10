package analytics

import "github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"

// allRepositories lets the integration tests call every repository method on one value.
type allRepositories struct {
	*SaleStatisticsRepository
	*RentalStatisticsRepository
	*DistributionRepository
	*MapRepository
	*TransactionRepository
	*BuildingRepository
	*ValuationRepository
	*ReleaseRepository
}

func newAllRepositories(db database.Querier) allRepositories {
	repositories := NewRepositories(db)
	return allRepositories{
		repositories.Sales, repositories.Rentals, repositories.Distributions, repositories.Maps,
		repositories.Transactions, repositories.Buildings, repositories.Valuations, repositories.Releases,
	}
}
