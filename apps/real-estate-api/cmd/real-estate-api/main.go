package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/config"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/economics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/httpapi"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/metrics"
)

func main() {
	if err := run(); err != nil {
		slog.Error("api stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger := newLogger(cfg.LogLevel)
	slog.SetDefault(logger)

	// signalCtx ends at the first SIGINT/SIGTERM and starts the graceful shutdown. processCtx is
	// the parent of everything that may outlive a request (cache loads, the requests themselves
	// through BaseContext); it is cancelled once the drain is over, so a slow query cannot keep
	// a connection, and with it the process, alive.
	signalCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	processCtx, stopProcess := context.WithCancel(context.Background())
	defer stopProcess()

	pool, err := database.Open(signalCtx, database.Options{
		URL: cfg.DatabaseURL, MaxConnections: cfg.DatabaseMaxConnections,
		StatementTimeout: cfg.DatabaseStatementTimeout, ApplicationName: cfg.ApplicationName,
	})
	if err != nil {
		return err
	}
	// Readiness pings through its own connection, so a saturated main pool does not make the
	// container look dead and get restarted.
	probe, err := database.OpenProbe(signalCtx, cfg.DatabaseURL, cfg.ApplicationName)
	if err != nil {
		pool.Close()
		return err
	}
	defer closeDatabase(logger, cfg.ShutdownTimeout, pool, probe)

	geographyRepository := geography.NewRepository(pool)
	repositories := analytics.NewRepositories(processCtx, pool)
	// Build the address search index now, so the first search after a restart is not slow.
	// The build is detached from this wait; this only bounds how long the warm-up waits.
	go func() {
		warmCtx, cancel := context.WithTimeout(processCtx, 3*time.Minute)
		defer cancel()
		if err := repositories.Buildings.WarmSearchIndex(warmCtx); err != nil {
			logger.Warn("search index warm-up failed; the first search will retry", "error", err)
		}
	}()
	economicsClient := economics.NewClient(processCtx, nil, "")
	registry := metrics.NewRegistry()
	metrics.RegisterRuntime(registry)
	registerPoolMetrics(registry, pool)
	registerCacheMetrics(registry, map[string]func() memo.Stats{
		"address_index":  repositories.Buildings.SearchIndexCacheStats,
		"active_release": repositories.Releases.ActiveReleaseCacheStats,
	}, economicsClient.CacheStats)
	handler, err := httpapi.New(httpapi.Dependencies{
		Logger:           logger,
		Database:         probe,
		Geographies:      geographyRepository,
		Statistics:       repositories.Sales,
		Rentals:          repositories.Rentals,
		Transactions:     repositories.Transactions,
		Histories:        repositories.Transactions,
		Distributions:    repositories.Distributions,
		Buildings:        repositories.Buildings,
		Anomalies:        repositories.Valuations,
		Models:           repositories.Valuations,
		Releases:         repositories.Releases,
		ActiveRelease:    repositories.Releases,
		Maps:             repositories.Maps,
		Economics:        economicsClient,
		Affordability:    affordability.NewRepository(pool),
		Construction:     construction.NewRepository(pool),
		Demography:       demography.NewRepository(processCtx, pool),
		Recent:           repositories.Transactions,
		Hazards:          repositories.Hazards,
		Metrics:          registry,
		RequestTimeout:   cfg.RequestTimeout,
		AllowedOrigins:   cfg.AllowedOrigins,
		Environment:      cfg.Environment,
		ApplicationName:  cfg.ApplicationName,
		ApplicationBuild: cfg.ApplicationBuild,
	})
	if err != nil {
		return err
	}

	server := &http.Server{
		Addr:              cfg.Address,
		Handler:           handler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       cfg.ReadTimeout,
		WriteTimeout:      cfg.WriteTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		MaxHeaderBytes:    maxHeaderBytes,
		BaseContext:       func(net.Listener) context.Context { return processCtx },
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("api listening", "address", cfg.Address, "environment", cfg.Environment,
			"request_timeout", cfg.RequestTimeout.String(), "statement_timeout", cfg.DatabaseStatementTimeout.String(),
			"max_connections", cfg.DatabaseMaxConnections)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-signalCtx.Done():
		logger.Info("shutdown requested")
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	// Restore the default signal handling now, so a second signal ends the process at once
	// instead of being swallowed while the drain runs.
	stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	err = server.Shutdown(shutdownCtx)
	// Requests still running after the drain, and cache loads, are cancelled here; their
	// connections return to the pools, which closeDatabase then closes.
	stopProcess()
	return err
}

// maxHeaderBytes bounds the request line and headers of one request.
const maxHeaderBytes = 1 << 20

// closeDatabase closes the pools, waiting at most timeout for connections that cancelled
// handlers or cache loads are still returning: a hung one must not keep the process alive.
func closeDatabase(logger *slog.Logger, timeout time.Duration, pools ...*pgxpool.Pool) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		for _, pool := range pools {
			pool.Close()
		}
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		logger.Warn("database pools did not close in time; exiting anyway", "timeout", timeout.String())
	}
}

func newLogger(level string) *slog.Logger {
	logLevel := slog.LevelInfo
	switch level {
	case "debug":
		logLevel = slog.LevelDebug
	case "warn":
		logLevel = slog.LevelWarn
	case "error":
		logLevel = slog.LevelError
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
}
