package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/metrics"
)

// httpMetrics are the request metrics, labelled by the matched route pattern (never the raw
// path, so ids and typos do not create new series).
type httpMetrics struct {
	requests *metrics.CounterVec
	duration *metrics.HistogramVec
	inFlight *metrics.GaugeValue
}

func newHTTPMetrics(registry *metrics.Registry) *httpMetrics {
	return &httpMetrics{
		requests: registry.NewCounterVec("sreo_http_requests_total",
			"HTTP requests by method, route pattern and status.", "method", "route", "status"),
		duration: registry.NewHistogramVec("sreo_http_request_duration_seconds",
			"HTTP request duration by method, route pattern and status.", metrics.DefaultDurationBuckets,
			"method", "route", "status"),
		inFlight: registry.NewGauge("sreo_http_requests_in_flight", "HTTP requests being served."),
	}
}

type routeKey struct{}

// matchedRoute carries the route pattern from the router back out to instrument.
type matchedRoute struct{ pattern string }

// instrument counts and times every request. It runs outside the router, so the router records
// the matched pattern in the matchedRoute it finds in the context (see recordRoute).
func instrument(m *httpMetrics, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		m.inFlight.Add(1)
		route := &matchedRoute{}
		recorder := &statusRecorder{ResponseWriter: w}
		defer func() {
			m.inFlight.Add(-1)
			status := "aborted" // the handler panicked with http.ErrAbortHandler before answering
			if recorder.status != 0 {
				status = strconv.Itoa(recorder.status)
			}
			label := routeLabel(route.pattern)
			m.requests.Inc(r.Method, label, status)
			m.duration.Observe(time.Since(started).Seconds(), r.Method, label, status)
		}()
		next.ServeHTTP(recorder, r.WithContext(context.WithValue(r.Context(), routeKey{}, route)))
	})
}

// recordRoute wraps the router: ServeMux sets r.Pattern on the request it routes, and this
// copies it to the matchedRoute of instrument (also when the handler panics).
func recordRoute(router *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if route, ok := r.Context().Value(routeKey{}).(*matchedRoute); ok {
			defer func() { route.pattern = r.Pattern }()
		}
		router.ServeHTTP(w, r)
	})
}

// routeLabel drops the method from a pattern ("GET /api/v1/meta" -> "/api/v1/meta") and names
// requests that matched no API route (the catch-all "/", preflights, redirects) "unmatched".
func routeLabel(pattern string) string {
	if _, path, found := strings.Cut(pattern, " "); found {
		pattern = path
	}
	if pattern == "" || pattern == "/" {
		return "unmatched"
	}
	return pattern
}
