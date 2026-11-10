package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

// countingStatistics counts the overview queries, to prove a 304 runs none.
type countingStatistics struct {
	fakeStatistics
	overviews *atomic.Int32
}

func (store countingStatistics) Overview(ctx context.Context, filter analytics.StatisticsFilter) (analytics.Overview, error) {
	store.overviews.Add(1)
	return store.fakeStatistics.Overview(ctx, filter)
}

func get(handler http.Handler, path string, header ...string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, path, nil)
	for index := 0; index+1 < len(header); index += 2 {
		request.Header.Set(header[index], header[index+1])
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestReleaseETagAnswersNotModifiedWithoutQuerying(t *testing.T) {
	var overviews atomic.Int32
	handler := handlerWith(func(d *Dependencies) {
		d.Statistics = countingStatistics{fakeStatistics: d.Statistics.(fakeStatistics), overviews: &overviews}
	})
	first := get(handler, "/api/v1/statistics/overview?propertyGroup=apartment&from=2024-01-01")
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || !strings.HasPrefix(etag, `W/"release-1.`) {
		t.Fatalf("status=%d etag=%q", first.Code, etag)
	}
	if got := first.Header().Get("Cache-Control"); got != publicCacheControl {
		t.Fatalf("Cache-Control=%q", got)
	}

	// The same question with its parameters reordered is the same resource.
	second := get(handler, "/api/v1/statistics/overview?from=2024-01-01&propertyGroup=apartment", "If-None-Match", etag)
	if second.Code != http.StatusNotModified || second.Body.Len() != 0 {
		t.Fatalf("status=%d body=%q", second.Code, second.Body.String())
	}
	if second.Header().Get("ETag") != etag || second.Header().Get("Cache-Control") != publicCacheControl {
		t.Fatalf("304 headers: %v", second.Header())
	}
	if overviews.Load() != 1 {
		t.Fatalf("overview queried %d times; the 304 must not query", overviews.Load())
	}

	// A different question has a different tag.
	other := get(handler, "/api/v1/statistics/overview?propertyGroup=house&from=2024-01-01", "If-None-Match", etag)
	if other.Code != http.StatusOK || other.Header().Get("ETag") == etag {
		t.Fatalf("other query: status=%d etag=%q", other.Code, other.Header().Get("ETag"))
	}
}

func TestReleaseETagChangesWithTheRelease(t *testing.T) {
	path := "/api/v1/statistics/overview"
	before := get(handlerWith(nil), path).Header().Get("ETag")
	newRelease := handlerWith(func(d *Dependencies) { d.ActiveRelease = fakeActiveRelease{id: "release-2"} })
	after := get(newRelease, path, "If-None-Match", before)
	if after.Code != http.StatusOK || after.Header().Get("ETag") == before || !strings.HasPrefix(after.Header().Get("ETag"), `W/"release-2.`) {
		t.Fatalf("status=%d before=%q after=%q", after.Code, before, after.Header().Get("ETag"))
	}
}

func TestReleaseCachingSkipsErrorsAndMissingReleases(t *testing.T) {
	invalid := get(handlerWith(nil), "/api/v1/statistics/overview?from=2024-13-01")
	if invalid.Code != http.StatusBadRequest || invalid.Header().Get("ETag") != "" || invalid.Header().Get("Cache-Control") != noStoreCacheControl {
		t.Fatalf("error answer: status=%d headers=%v", invalid.Code, invalid.Header())
	}
	for name, release := range map[string]fakeActiveRelease{
		"lookup fails":   {err: errors.New("database unavailable")},
		"none published": {},
	} {
		handler := handlerWith(func(d *Dependencies) { d.ActiveRelease = release })
		response := get(handler, "/api/v1/statistics/overview", "If-None-Match", "*")
		if response.Code != http.StatusOK || response.Header().Get("ETag") != "" || response.Header().Get("Cache-Control") != "" {
			t.Fatalf("%s: status=%d headers=%v", name, response.Code, response.Header())
		}
	}
}

func TestContentETagForSourcesOutsideTheRelease(t *testing.T) {
	handler := handlerWith(nil)
	path := "/api/v1/economy/inflation?from=2024-01-01&to=2024-06-30&interval=month"
	first := get(handler, path)
	etag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || !strings.HasPrefix(etag, `W/"`) || strings.Contains(etag, "release-1") {
		t.Fatalf("status=%d etag=%q body=%s", first.Code, etag, first.Body.String())
	}
	if first.Header().Get("Cache-Control") != publicCacheControl || first.Body.Len() == 0 {
		t.Fatalf("headers=%v body=%q", first.Header(), first.Body.String())
	}
	second := get(handler, path, "If-None-Match", `"unrelated", `+etag)
	if second.Code != http.StatusNotModified || second.Body.Len() != 0 || second.Header().Get("ETag") != etag {
		t.Fatalf("status=%d etag=%q body=%q", second.Code, second.Header().Get("ETag"), second.Body.String())
	}
	failing := handlerWith(func(d *Dependencies) { d.Economics = fakeEconomics{err: errors.New("SURS down")} })
	failed := get(failing, path, "If-None-Match", etag)
	if failed.Code < 500 || failed.Header().Get("ETag") != "" || failed.Header().Get("Cache-Control") != noStoreCacheControl ||
		!strings.Contains(failed.Body.String(), `"error"`) {
		t.Fatalf("error answer: status=%d headers=%v body=%s", failed.Code, failed.Header(), failed.Body.String())
	}
}

func TestDataStatusRevalidatesAndHealthIsNotCached(t *testing.T) {
	handler := handlerWith(nil)
	status := get(handler, "/api/v1/data-status")
	if status.Header().Get("Cache-Control") != revalidateCacheControl || status.Header().Get("ETag") == "" {
		t.Fatalf("data-status headers=%v", status.Header())
	}
	if again := get(handler, "/api/v1/data-status", "If-None-Match", status.Header().Get("ETag")); again.Code != http.StatusNotModified {
		t.Fatalf("data-status revalidation status=%d", again.Code)
	}
	live := get(handler, "/health/live")
	if live.Header().Get("ETag") != "" || live.Header().Get("Cache-Control") != "" {
		t.Fatalf("health headers=%v", live.Header())
	}
}

func TestETagMatches(t *testing.T) {
	tests := []struct {
		header, etag string
		want         bool
	}{
		{"", `W/"a"`, false},
		{`W/"a"`, `W/"a"`, true},
		{`"a"`, `W/"a"`, true},
		{`"b", W/"a"`, `W/"a"`, true},
		{`"b"`, `W/"a"`, false},
		{"*", `W/"a"`, true},
	}
	for _, test := range tests {
		if got := etagMatches(test.header, test.etag); got != test.want {
			t.Errorf("etagMatches(%q, %q)=%v", test.header, test.etag, got)
		}
	}
}
