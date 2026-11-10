package main

import (
	"maps"
	"slices"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/metrics"
)

// registerPoolMetrics exports the statistics of the main connection pool.
func registerPoolMetrics(registry *metrics.Registry, pool *pgxpool.Pool) {
	stat := func(read func(*pgxpool.Stat) float64) func() []metrics.Sample {
		return func() []metrics.Sample { return []metrics.Sample{{Value: read(pool.Stat())}} }
	}
	registry.NewFunc("sreo_db_pool_connections", "Database pool connections by state.", metrics.Gauge,
		[]string{"state"}, func() []metrics.Sample {
			s := pool.Stat()
			return []metrics.Sample{
				{LabelValues: []string{"acquired"}, Value: float64(s.AcquiredConns())},
				{LabelValues: []string{"idle"}, Value: float64(s.IdleConns())},
				{LabelValues: []string{"constructing"}, Value: float64(s.ConstructingConns())},
			}
		})
	registry.NewFunc("sreo_db_pool_max_connections", "Maximum size of the database pool.", metrics.Gauge, nil,
		stat(func(s *pgxpool.Stat) float64 { return float64(s.MaxConns()) }))
	registry.NewFunc("sreo_db_pool_acquires_total", "Successful connection acquisitions from the pool.", metrics.Counter, nil,
		stat(func(s *pgxpool.Stat) float64 { return float64(s.AcquireCount()) }))
	registry.NewFunc("sreo_db_pool_empty_acquires_total", "Acquisitions that waited because the pool had no idle connection.",
		metrics.Counter, nil, stat(func(s *pgxpool.Stat) float64 { return float64(s.EmptyAcquireCount()) }))
	registry.NewFunc("sreo_db_pool_canceled_acquires_total", "Acquisitions cancelled by their context.", metrics.Counter, nil,
		stat(func(s *pgxpool.Stat) float64 { return float64(s.CanceledAcquireCount()) }))
	registry.NewFunc("sreo_db_pool_acquire_duration_seconds_total", "Total time spent acquiring connections.", metrics.Counter, nil,
		stat(func(s *pgxpool.Stat) float64 { return s.AcquireDuration().Seconds() }))
}

// registerCacheMetrics exports the hits, misses and loads of the in-memory caches: the fixed
// ones by name, plus every cache reported by each extra source (the SURS CPI tables).
func registerCacheMetrics(registry *metrics.Registry, caches map[string]func() memo.Stats, extra ...func() map[string]memo.Stats) {
	snapshot := func() map[string]memo.Stats {
		all := map[string]memo.Stats{}
		for name, stats := range caches {
			all[name] = stats()
		}
		for _, source := range extra {
			maps.Copy(all, source())
		}
		return all
	}
	samples := func(pick func(memo.Stats) [2]uint64, outcomes [2]string) func() []metrics.Sample {
		return func() []metrics.Sample {
			all := snapshot()
			var result []metrics.Sample
			for _, name := range slices.Sorted(maps.Keys(all)) {
				values := pick(all[name])
				result = append(result,
					metrics.Sample{LabelValues: []string{name, outcomes[0]}, Value: float64(values[0])},
					metrics.Sample{LabelValues: []string{name, outcomes[1]}, Value: float64(values[1])})
			}
			return result
		}
	}
	registry.NewFunc("sreo_cache_requests_total", "In-memory cache reads: a hit is served at once, a miss waits for a load.",
		metrics.Counter, []string{"cache", "result"},
		samples(func(s memo.Stats) [2]uint64 { return [2]uint64{s.Hits, s.Misses} }, [2]string{"hit", "miss"}))
	registry.NewFunc("sreo_cache_loads_total", "In-memory cache loads by outcome.",
		metrics.Counter, []string{"cache", "result"},
		samples(func(s memo.Stats) [2]uint64 { return [2]uint64{s.Loads, s.Failures} }, [2]string{"ok", "error"}))
}
