package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

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

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := database.Open(ctx, database.Options{
		URL: cfg.DatabaseURL, MaxConnections: cfg.DatabaseMaxConnections,
		StatementTimeout: cfg.DatabaseStatementTimeout, ApplicationName: cfg.ApplicationName,
	})
	if err != nil {
		return err
	}
	defer pool.Close()
	// Readiness pings through its own connection, so a saturated main pool does not make the
	// container look dead and get restarted.
	probe, err := database.OpenProbe(ctx, cfg.DatabaseURL, cfg.ApplicationName)
	if err != nil {
		return err
	}
	defer probe.Close()

	geographyRepository := geography.NewRepository(pool)
	repositories := analytics.NewRepositories(pool)
	// Build the address search index now, so the first search after a restart is not slow.
	// The build is detached from this context; this only bounds how long the warm-up waits.
	go func() {
		warmCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		if err := repositories.Buildings.WarmSearchIndex(warmCtx); err != nil {
			logger.Warn("search index warm-up failed; the first search will retry", "error", err)
		}
	}()
	economicsClient := economics.NewClient(nil, "")
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
		Demography:       demography.NewRepository(pool),
		Recent:           repositories.Transactions,
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
		MaxHeaderBytes:    1 << 20,
	}

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("api listening", "address", cfg.Address, "environment", cfg.Environment,
			"request_timeout", cfg.RequestTimeout.String(), "statement_timeout", cfg.DatabaseStatementTimeout.String(),
			"max_connections", cfg.DatabaseMaxConnections)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		logger.Info("shutdown requested")
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	return server.Shutdown(shutdownCtx)
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
