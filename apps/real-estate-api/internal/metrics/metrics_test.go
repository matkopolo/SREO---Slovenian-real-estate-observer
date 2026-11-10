package metrics

import (
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestExpositionFormat(t *testing.T) {
	registry := NewRegistry()
	requests := registry.NewCounterVec("app_requests_total", "Requests.", "route", "status")
	duration := registry.NewHistogramVec("app_duration_seconds", "Duration.", []float64{0.25, 1}, "route")
	inFlight := registry.NewGauge("app_in_flight", "In flight.")
	registry.NewFunc("app_pool_conns", "Pool.", Gauge, []string{"state"}, func() []Sample {
		return []Sample{{LabelValues: []string{"idle"}, Value: 3}}
	})
	var wg sync.WaitGroup
	for range 10 {
		wg.Go(func() { requests.Inc("/a", "200") })
	}
	wg.Wait()
	requests.Inc(`/b"\`, "404")
	duration.Observe(0.25, "/a")
	duration.Observe(0.5, "/a")
	duration.Observe(3, "/a")
	inFlight.Add(2)
	inFlight.Add(-1)

	recorder := httptest.NewRecorder()
	registry.ServeHTTP(recorder, httptest.NewRequest("GET", "/metrics", nil))
	if got := recorder.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/plain; version=0.0.4") {
		t.Fatalf("content type %q", got)
	}
	want := `# HELP app_requests_total Requests.
# TYPE app_requests_total counter
app_requests_total{route="/a",status="200"} 10
app_requests_total{route="/b\"\\",status="404"} 1
# HELP app_duration_seconds Duration.
# TYPE app_duration_seconds histogram
app_duration_seconds_bucket{route="/a",le="0.25"} 1
app_duration_seconds_bucket{route="/a",le="1"} 2
app_duration_seconds_bucket{route="/a",le="+Inf"} 3
app_duration_seconds_sum{route="/a"} 3.75
app_duration_seconds_count{route="/a"} 3
# HELP app_in_flight In flight.
# TYPE app_in_flight gauge
app_in_flight 1
# HELP app_pool_conns Pool.
# TYPE app_pool_conns gauge
app_pool_conns{state="idle"} 3
`
	if got := recorder.Body.String(); got != want {
		t.Fatalf("exposition:\n%s\nwant:\n%s", got, want)
	}
}

func TestDuplicateAndWrongLabelsPanic(t *testing.T) {
	registry := NewRegistry()
	counter := registry.NewCounterVec("x_total", "X.", "a")
	for name, call := range map[string]func(){
		"duplicate":    func() { registry.NewGauge("x_total", "again") },
		"label values": func() { counter.Inc("1", "2") },
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Errorf("%s did not panic", name)
				}
			}()
			call()
		}()
	}
}
