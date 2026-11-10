// Package database opens the PostgreSQL pools of the API and defines the query surface
// shared by repositories.
package database

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Querier is what repositories need from the database. Both *pgxpool.Pool and pgx.Tx
// implement it, so integration tests can run a repository inside a rolled-back transaction.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// BeginReadOnly starts a read-only transaction with the given isolation level on a pool,
// or a savepoint when the querier already is a transaction (integration tests).
func BeginReadOnly(ctx context.Context, db Querier, isolation pgx.TxIsoLevel) (pgx.Tx, error) {
	switch source := db.(type) {
	case interface {
		BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
	}:
		return source.BeginTx(ctx, pgx.TxOptions{IsoLevel: isolation, AccessMode: pgx.ReadOnly})
	case interface {
		Begin(context.Context) (pgx.Tx, error)
	}:
		return source.Begin(ctx)
	default:
		return nil, fmt.Errorf("begin transaction: %T cannot start transactions", db)
	}
}

// SupportsConcurrency reports whether independent queries may run in parallel on db: true for
// a pool, false for a transaction (one connection).
func SupportsConcurrency(db Querier) bool {
	_, ok := db.(*pgxpool.Pool)
	return ok
}

// Options configure the main connection pool.
type Options struct {
	URL            string
	MaxConnections int32
	// StatementTimeout cancels any single statement that runs longer (PostgreSQL statement_timeout).
	StatementTimeout time.Duration
	ApplicationName  string
}

// Open connects the main pool and verifies that the schema the API reads is present.
func Open(ctx context.Context, options Options) (*pgxpool.Pool, error) {
	config, err := poolConfig(options.URL, options.ApplicationName, options.StatementTimeout)
	if err != nil {
		return nil, err
	}
	config.MaxConns = options.MaxConnections
	config.MinConns = 2
	if config.MinConns > config.MaxConns {
		config.MinConns = config.MaxConns
	}
	config.MaxConnLifetime = time.Hour
	config.MaxConnIdleTime = 15 * time.Minute
	config.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create database pool: %w", err)
	}
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(checkCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	if err := verifySchema(checkCtx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// OpenProbe opens a one-connection pool used only by the readiness check, so a busy main
// pool cannot make an overloaded but healthy API look dead.
func OpenProbe(ctx context.Context, url, applicationName string) (*pgxpool.Pool, error) {
	config, err := poolConfig(url, applicationName+"-probe", 2*time.Second)
	if err != nil {
		return nil, err
	}
	config.MaxConns = 1
	config.MinConns = 0
	config.MaxConnIdleTime = time.Minute
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, fmt.Errorf("create readiness pool: %w", err)
	}
	return pool, nil
}

func poolConfig(url, applicationName string, statementTimeout time.Duration) (*pgxpool.Config, error) {
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse database configuration: %w", err)
	}
	params := config.ConnConfig.RuntimeParams
	if applicationName != "" {
		params["application_name"] = applicationName
	}
	if statementTimeout > 0 {
		params["statement_timeout"] = strconv.FormatInt(statementTimeout.Milliseconds(), 10)
	}
	// A transaction left open by a cancelled request must not hold a connection for long.
	params["idle_in_transaction_session_timeout"] = "30000"
	// The fact views carry high cost estimates, so PostgreSQL JIT-compiles even 100 ms queries
	// and spends 50–200 ms doing it; measured on the full data every API query is faster without.
	params["jit"] = "off"
	return config, nil
}

func verifySchema(ctx context.Context, pool *pgxpool.Pool) error {
	var ready bool
	if err := pool.QueryRow(ctx, `
		SELECT to_regclass('analytics.geographic_units') IS NOT NULL
		   AND to_regclass('analytics.sale_facts') IS NOT NULL
		   AND to_regclass('analytics.sale_outlier_evaluations') IS NOT NULL
		   AND to_regclass('analytics.rental_facts') IS NOT NULL
		   AND to_regclass('analytics.anomaly_signals') IS NOT NULL
		   AND to_regclass('analytics.valuation_predictions') IS NOT NULL
		   AND to_regclass('analytics.market_indices') IS NOT NULL
		   AND EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')`,
	).Scan(&ready); err != nil {
		return fmt.Errorf("verify database schema: %w", err)
	}
	if !ready {
		return fmt.Errorf("verify database schema: required API migration or PostGIS extension is missing")
	}
	return nil
}
