package metrics

import (
	"runtime"
	"time"
)

// RegisterRuntime adds the Go runtime and process basics: goroutines, heap and start time.
func RegisterRuntime(r *Registry) {
	started := float64(time.Now().Unix())
	r.NewFunc("go_goroutines", "Number of goroutines that currently exist.", Gauge, nil, func() []Sample {
		return []Sample{{Value: float64(runtime.NumGoroutine())}}
	})
	r.NewFunc("go_memstats_heap_alloc_bytes", "Bytes of allocated heap objects.", Gauge, nil, func() []Sample {
		var stats runtime.MemStats
		runtime.ReadMemStats(&stats)
		return []Sample{{Value: float64(stats.HeapAlloc)}}
	})
	r.NewFunc("process_start_time_seconds", "Start time of the process since the Unix epoch in seconds.", Gauge, nil, func() []Sample {
		return []Sample{{Value: started}}
	})
}
