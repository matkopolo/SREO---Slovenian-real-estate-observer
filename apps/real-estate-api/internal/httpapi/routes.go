package httpapi

import "net/http"

// routes is the single source of truth for HTTP method/path registration. The API is
// read-only: every route is a GET. Each route states its HTTP caching (caching.go): analytics
// answers are cached per active release, other sources by content, health checks not at all.
// The OpenAPI contract test compares these registrations with openapi.yaml.
func (s *server) routes() *http.ServeMux {
	router := http.NewServeMux()
	router.HandleFunc("GET /health/live", s.live)
	router.HandleFunc("GET /health/ready", s.ready)
	router.HandleFunc("GET /api/v1/meta", contentCached(publicCacheControl, s.meta))
	router.HandleFunc("GET /api/v1/data-status", contentCached(revalidateCacheControl, s.dataStatus))
	router.HandleFunc("GET /api/v1/economy/inflation", contentCached(publicCacheControl, s.inflation))
	router.HandleFunc("GET /api/v1/economy/inflation-factor", contentCached(publicCacheControl, s.inflationFactor))
	router.HandleFunc("GET /api/v1/affordability", contentCached(publicCacheControl, s.affordability))
	router.HandleFunc("GET /api/v1/affordability/municipalities", contentCached(publicCacheControl, s.affordabilityMunicipalities))
	router.HandleFunc("GET /api/v1/demographics", contentCached(publicCacheControl, s.demographics))
	router.HandleFunc("GET /api/v1/demographics/municipalities", contentCached(publicCacheControl, s.demographicsMunicipalities))
	router.HandleFunc("GET /api/v1/map/buildings", s.releaseCached(s.mapBuildings))
	router.HandleFunc("GET /api/v1/construction/summary", contentCached(publicCacheControl, s.constructionSummary))
	router.HandleFunc("GET /api/v1/construction/map", contentCached(publicCacheControl, s.constructionMap))
	router.HandleFunc("GET /api/v1/construction/buildings/{eid}", contentCached(publicCacheControl, s.constructionBuilding))
	router.HandleFunc("GET /api/v1/hazards/floods", contentCached(publicCacheControl, s.floodZones))
	router.HandleFunc("GET /api/v1/sales/statistics/resales", s.releaseCached(s.resaleSummary))
	router.HandleFunc("GET /api/v1/sales/transactions/{id}/history", s.releaseCached(s.propertyHistory))
	router.HandleFunc("GET /api/v1/geographies", contentCached(publicCacheControl, s.listGeographies))
	router.HandleFunc("GET /api/v1/geographies/boundaries", contentCached(publicCacheControl, s.geographyBoundaries))
	router.HandleFunc("GET /api/v1/geographies/{id}", contentCached(publicCacheControl, s.getGeography))
	router.HandleFunc("GET /api/v1/geographies/{id}/boundary", contentCached(publicCacheControl, s.geographyBoundary))
	router.HandleFunc("GET /api/v1/geographies/{id}/children", contentCached(publicCacheControl, s.geographyChildren))
	router.HandleFunc("GET /api/v1/statistics/overview", s.releaseCached(s.statisticsOverview))
	router.HandleFunc("GET /api/v1/statistics/timeseries", s.releaseCached(s.statisticsTimeSeries))
	router.HandleFunc("GET /api/v1/statistics/outliers", s.releaseCached(s.statisticsOutliers))
	router.HandleFunc("GET /api/v1/transactions/extremes", s.releaseCached(s.transactionExtremes))
	router.HandleFunc("GET /api/v1/transactions/recent", s.releaseCached(s.recentTransactions))
	router.HandleFunc("GET /api/v1/rentals/statistics/overview", s.releaseCached(s.rentalOverview))
	router.HandleFunc("GET /api/v1/rentals/statistics/timeseries", s.releaseCached(s.rentalTimeSeries))
	router.HandleFunc("GET /api/v1/rentals/statistics/outliers", s.releaseCached(s.rentalOutliers))
	router.HandleFunc("GET /api/v1/rentals/map/clusters", s.releaseCached(s.rentalMapClusters))
	router.HandleFunc("GET /api/v1/rentals/map/geographies", s.releaseCached(s.rentalMapGeographies))
	router.HandleFunc("GET /api/v1/rentals/map/properties", s.releaseCached(s.rentalMapProperties))
	router.HandleFunc("GET /api/v1/sales/transactions/{id}", s.releaseCached(s.saleTransaction))
	router.HandleFunc("GET /api/v1/sales/transactions/{id}/context", s.releaseCached(s.saleTransactionContext))
	router.HandleFunc("GET /api/v1/rentals/transactions/{id}", s.releaseCached(s.rentalTransaction))
	router.HandleFunc("GET /api/v1/rentals/transactions/{id}/context", s.releaseCached(s.rentalTransactionContext))
	router.HandleFunc("GET /api/v1/statistics/distribution", s.releaseCached(s.saleDistribution))
	router.HandleFunc("GET /api/v1/rentals/statistics/distribution", s.releaseCached(s.rentalDistribution))
	router.HandleFunc("GET /api/v1/buildings/{cadastralCode}/{buildingNumber}/statistics", s.releaseCached(s.buildingStatistics))
	router.HandleFunc("GET /api/v1/buildings/search", s.releaseCached(s.searchBuildings))
	router.HandleFunc("GET /api/v1/anomalies", s.releaseCached(s.anomalies))
	router.HandleFunc("GET /api/v1/anomalies/summary", s.releaseCached(s.anomalySummary))
	router.HandleFunc("GET /api/v1/indices", s.releaseCached(s.marketIndices))
	router.HandleFunc("GET /api/v1/valuations/{kind}/{id}", s.releaseCached(s.valuationPrediction))
	router.HandleFunc("GET /api/v1/map/clusters", s.releaseCached(s.mapClusters))
	router.HandleFunc("GET /api/v1/map/geographies", s.releaseCached(s.mapGeographies))
	router.HandleFunc("GET /api/v1/map/properties", s.releaseCached(s.mapProperties))
	router.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, r, http.StatusNotFound, "route_not_found", "route was not found")
	})
	return router
}
