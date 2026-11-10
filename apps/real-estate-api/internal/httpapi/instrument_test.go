package httpapi

import (
	"net/http"
	"strings"
	"testing"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/metrics"
)

func TestMetricsCountRequestsByRoutePattern(t *testing.T) {
	registry := metrics.NewRegistry()
	handler := handlerWith(func(d *Dependencies) { d.Metrics = registry })
	etag := get(handler, "/api/v1/sales/transactions/7").Header().Get("ETag")
	get(handler, "/api/v1/sales/transactions/8")
	get(handler, "/api/v1/sales/transactions/7", "If-None-Match", etag)
	get(handler, "/no/such/route")

	exposition := get(handler, "/metrics")
	if exposition.Code != http.StatusOK || !strings.HasPrefix(exposition.Header().Get("Content-Type"), "text/plain; version=0.0.4") {
		t.Fatalf("status=%d headers=%v", exposition.Code, exposition.Header())
	}
	body := exposition.Body.String()
	for _, want := range []string{
		`sreo_http_requests_total{method="GET",route="/api/v1/sales/transactions/{id}",status="200"} 2`,
		`sreo_http_requests_total{method="GET",route="/api/v1/sales/transactions/{id}",status="304"} 1`,
		`sreo_http_requests_total{method="GET",route="unmatched",status="404"} 1`,
		`sreo_http_request_duration_seconds_count{method="GET",route="/api/v1/sales/transactions/{id}",status="200"} 2`,
		"sreo_http_requests_in_flight 0",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
	if strings.Contains(body, `route="/metrics"`) {
		t.Error("the metrics endpoint should not count itself")
	}
}

func TestRouteLabel(t *testing.T) {
	for pattern, want := range map[string]string{
		"GET /api/v1/meta": "/api/v1/meta",
		"/":                "unmatched",
		"":                 "unmatched",
	} {
		if got := routeLabel(pattern); got != want {
			t.Errorf("routeLabel(%q)=%q, want %q", pattern, got, want)
		}
	}
}
