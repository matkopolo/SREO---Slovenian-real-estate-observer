package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/economics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/metrics"
)

type databasePinger interface {
	Ping(context.Context) error
}

// Dependencies are everything the HTTP API needs. Every store is required.
type Dependencies struct {
	Logger *slog.Logger
	// Database is pinged by the readiness check; use a pool reserved for it.
	Database      databasePinger
	Geographies   geography.Store
	Statistics    analytics.StatisticsStore
	Rentals       analytics.RentalStatisticsStore
	Transactions  analytics.TransactionDetailStore
	Histories     analytics.HistoryStore
	Distributions analytics.DistributionStore
	Buildings     analytics.BuildingStore
	Anomalies     analytics.AnomalyStore
	Models        analytics.ModelStore
	Releases      analytics.ReleaseStore
	// ActiveRelease names the active analytical release; the analytics ETags derive from it.
	ActiveRelease analytics.ActiveReleaseStore
	Maps          analytics.MapStore
	Economics     economics.Store
	Affordability affordability.Store
	Construction  construction.Store
	Demography    demography.Store
	Recent        analytics.RecentStore
	Hazards       analytics.HazardStore
	// Metrics receives the request metrics and is served at GET /metrics (outside /api/, so the
	// frontend's proxy never exposes it).
	Metrics *metrics.Registry
	// RequestTimeout is each request's deadline; zero means none.
	RequestTimeout   time.Duration
	AllowedOrigins   []string
	Environment      string
	ApplicationName  string
	ApplicationBuild string
	// Now replaces time.Now (tests of year boundaries).
	Now func() time.Time
}

type server struct {
	database           databasePinger
	geographies        geography.Store
	statistics         analytics.StatisticsStore
	rentals            analytics.RentalStatisticsStore
	transactions       analytics.TransactionDetailStore
	histories          analytics.HistoryStore
	distributions      analytics.DistributionStore
	buildings          analytics.BuildingStore
	anomaliesStore     analytics.AnomalyStore
	models             analytics.ModelStore
	releases           analytics.ReleaseStore
	activeRelease      analytics.ActiveReleaseStore
	maps               analytics.MapStore
	economics          economics.Store
	affordabilityStore affordability.Store
	construction       construction.Store
	demography         demography.Store
	recent             analytics.RecentStore
	hazards            analytics.HazardStore
	environment        string
	applicationName    string
	applicationBuild   string
	now                func() time.Time
	// instance identifies this build and process in release ETags.
	instance string
}

// New returns the API handler. It fails when a dependency is missing, so handlers never
// check for nil stores.
func New(dependencies Dependencies) (http.Handler, error) {
	if err := dependencies.validate(); err != nil {
		return nil, err
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	s := &server{
		database:           dependencies.Database,
		geographies:        dependencies.Geographies,
		statistics:         dependencies.Statistics,
		rentals:            dependencies.Rentals,
		transactions:       dependencies.Transactions,
		histories:          dependencies.Histories,
		distributions:      dependencies.Distributions,
		buildings:          dependencies.Buildings,
		anomaliesStore:     dependencies.Anomalies,
		models:             dependencies.Models,
		releases:           dependencies.Releases,
		activeRelease:      dependencies.ActiveRelease,
		maps:               dependencies.Maps,
		economics:          dependencies.Economics,
		affordabilityStore: dependencies.Affordability,
		construction:       dependencies.Construction,
		demography:         dependencies.Demography,
		recent:             dependencies.Recent,
		hazards:            dependencies.Hazards,
		environment:        dependencies.Environment,
		applicationName:    dependencies.ApplicationName,
		applicationBuild:   dependencies.ApplicationBuild,
		now:                now,
		instance:           digest([]byte(dependencies.ApplicationBuild + "|" + time.Now().UTC().Format(time.RFC3339Nano)))[:8],
	}
	api := instrument(newHTTPMetrics(dependencies.Metrics),
		middleware(dependencies.Logger, dependencies.AllowedOrigins, dependencies.RequestTimeout, recordRoute(s.routes())))
	root := http.NewServeMux()
	root.Handle("GET /metrics", dependencies.Metrics)
	root.Handle("/", api)
	return root, nil
}

// validate reports every nil interface or pointer field of the dependencies.
func (dependencies Dependencies) validate() error {
	var missing []error
	value := reflect.ValueOf(dependencies)
	for index := range value.NumField() {
		field := value.Field(index)
		if (field.Kind() == reflect.Interface || field.Kind() == reflect.Pointer) && field.IsNil() {
			missing = append(missing, fmt.Errorf("httpapi: dependency %s is missing", value.Type().Field(index).Name))
		}
	}
	return errors.Join(missing...)
}

func (s *server) live(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) ready(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.database.Ping(ctx); err != nil {
		requestLog(r).Warn("readiness check failed", "error", err)
		writeError(w, r, http.StatusServiceUnavailable, "not_ready", "database is unavailable")
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]string{
		"status":      "ok",
		"application": s.applicationName,
		"build":       s.applicationBuild,
		"environment": s.environment,
	})
}

func (s *server) meta(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]any{
		"apiVersion":       "v1",
		"transactionKinds": []string{"sale", "rent"},
		"intervals":        []string{"month", "quarter", "year"},
		"geographyLevels":  []string{"country", "statistical_region", "municipality", "city_district", "local_community", "settlement"},
		"propertyGroups":   []string{"apartment", "house", "land", "commercial", "garage", "room", "mixed", "unknown"},
	})
}

func (s *server) dataStatus(w http.ResponseWriter, r *http.Request) {
	status, err := s.releases.DataStatus(r.Context())
	if err != nil {
		s.fail(w, r, "load the data status", err)
		return
	}
	writeJSON(w, r, http.StatusOK, status)
}

var _ databasePinger = (*pgxpool.Pool)(nil)
