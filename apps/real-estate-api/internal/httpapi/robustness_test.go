package httpapi

import (
	"context"
	"math"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
)

// switchingActiveRelease reports whichever release id is current when asked.
type switchingActiveRelease struct{ id *atomic.Pointer[string] }

func (store switchingActiveRelease) ActiveReleaseID(context.Context) (string, error) {
	return *store.id.Load(), nil
}

// TestReleaseETagFollowsAConcurrentReleaseSwitch runs revalidations while the active release
// switches (under -race): a 304 only ever confirms the tag the client sent, every 200 carries a
// tag of one of the two releases, and once the switch is over the old tag no longer validates.
func TestReleaseETagFollowsAConcurrentReleaseSwitch(t *testing.T) {
	first, second := "release-1", "release-2"
	var current atomic.Pointer[string]
	current.Store(&first)
	handler := handlerWith(func(d *Dependencies) { d.ActiveRelease = switchingActiveRelease{&current} })
	path := "/api/v1/statistics/overview?propertyGroup=apartment"
	oldTag := get(handler, path).Header().Get("ETag")
	if !strings.HasPrefix(oldTag, `W/"release-1.`) {
		t.Fatalf("etag=%q", oldTag)
	}
	var wg sync.WaitGroup
	var notModified, fresh atomic.Int32
	for range 8 {
		wg.Go(func() {
			for range 50 {
				response := get(handler, path, "If-None-Match", oldTag)
				tag := response.Header().Get("ETag")
				switch response.Code {
				case http.StatusNotModified:
					if tag != oldTag {
						t.Errorf("304 with etag %q for If-None-Match %q", tag, oldTag)
					}
					notModified.Add(1)
				case http.StatusOK:
					if !strings.HasPrefix(tag, `W/"release-1.`) && !strings.HasPrefix(tag, `W/"release-2.`) {
						t.Errorf("200 with etag %q", tag)
					}
					fresh.Add(1)
				default:
					t.Errorf("status=%d", response.Code)
				}
			}
		})
	}
	wg.Go(func() { current.Store(&second) })
	wg.Wait()
	after := get(handler, path, "If-None-Match", oldTag)
	if after.Code != http.StatusOK || !strings.HasPrefix(after.Header().Get("ETag"), `W/"release-2.`) {
		t.Fatalf("after the switch: status=%d etag=%q", after.Code, after.Header().Get("ETag"))
	}
	if fresh.Load() == 0 {
		t.Fatal("no request saw the new release")
	}
}

// TestUnencodableAnswerIsAnErrorNotATruncatedBody: a NaN from the database must not become a
// cacheable 200 with half a body.
func TestUnencodableAnswerIsAnErrorNotATruncatedBody(t *testing.T) {
	nan := math.NaN()
	handler := handlerWith(func(d *Dependencies) {
		d.Statistics = fakeStatistics{overview: analytics.Overview{MedianPrice: &nan}}
	})
	response := get(handler, "/api/v1/statistics/overview")
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"internal_error"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("ETag") != "" || response.Header().Get("Cache-Control") != noStoreCacheControl {
		t.Fatalf("headers=%v, want no ETag and no-store", response.Header())
	}
}

// computedDemography answers with the real Compute on a dataset without migration or census
// series, so the contract check sees what production emits for such an area.
type computedDemography struct{ fakeDemography }

func (store computedDemography) Profile(context.Context, *int64) (demography.Profile, error) {
	data := demography.Series{"population_total": {"2026H1": 1000}}
	return demography.Compute(demography.Unit{ID: 70, Level: "municipality", Code: 70, Name: "Maribor"}, data, data, data, "Slovenija")
}

func TestDemographicsWithoutMigrationMatchTheContract(t *testing.T) {
	schemas := newContractSchemas(t, loadContract(t))
	handler := handlerWith(func(d *Dependencies) { d.Demography = computedDemography{} })
	response := get(handler, "/api/v1/demographics?geographyId=70")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	schemas.validate(t, "/api/v1/demographics", response)
}

func TestBoundingBoxEdgeCases(t *testing.T) {
	handler := handlerWith(nil)
	tests := []struct {
		name, path string
		status     int
		code       string
	}{
		{"exact maximum span", "/api/v1/map/clusters?bbox=-180,-90,-172,-82", http.StatusOK, ""},
		{"span over the cap", "/api/v1/map/clusters?bbox=5,40,14,47", http.StatusBadRequest, "bbox_too_large"},
		{"longitude out of range", "/api/v1/map/clusters?bbox=179,0,181,1", http.StatusBadRequest, "invalid_bbox"},
		{"latitude out of range", "/api/v1/map/properties?bbox=14,89,15,91", http.StatusBadRequest, "invalid_bbox"},
		{"zero height", "/api/v1/map/properties?bbox=14,46,15,46", http.StatusBadRequest, "invalid_bbox"},
		{"three coordinates", "/api/v1/rentals/map/clusters?bbox=14,46,15", http.StatusBadRequest, "invalid_bbox"},
		{"not numbers", "/api/v1/rentals/map/properties?bbox=a,b,c,d", http.StatusBadRequest, "invalid_bbox"},
		{"boundaries cap", "/api/v1/geographies/boundaries?level=municipality&bbox=5,40,14,47", http.StatusBadRequest, "bbox_too_large"},
		{"construction cap", "/api/v1/construction/map?bbox=5,40,14,47&zoom=8", http.StatusBadRequest, "bbox_too_large"},
		{"flood cap is tighter", "/api/v1/hazards/floods?bbox=14.4,46.0,14.7,46.1", http.StatusBadRequest, "bbox_too_large"},
		{"flood view", "/api/v1/hazards/floods?bbox=14.4,46.0,14.6,46.1", http.StatusOK, ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := get(handler, test.path)
			if response.Code != test.status || (test.code != "" && !strings.Contains(response.Body.String(), `"`+test.code+`"`)) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestPagingAndRangeParameterEdgeCases(t *testing.T) {
	handler := handlerWith(nil)
	tests := []struct {
		name, path string
		status     int
	}{
		{"limit at minimum", "/api/v1/statistics/outliers?limit=1", http.StatusOK},
		{"limit zero", "/api/v1/statistics/outliers?limit=0", http.StatusBadRequest},
		{"limit over maximum", "/api/v1/statistics/outliers?limit=101", http.StatusBadRequest},
		{"limit not a number", "/api/v1/statistics/outliers?limit=ten", http.StatusBadRequest},
		{"offset at maximum", "/api/v1/statistics/outliers?offset=100000", http.StatusOK},
		{"offset over maximum", "/api/v1/statistics/outliers?offset=100001", http.StatusBadRequest},
		{"negative offset", "/api/v1/statistics/outliers?offset=-1", http.StatusBadRequest},
		{"from after to", "/api/v1/statistics/overview?from=2024-02-01&to=2024-01-01", http.StatusBadRequest},
		{"same day range", "/api/v1/statistics/overview?from=2024-01-01&to=2024-01-01", http.StatusOK},
		{"area over maximum", "/api/v1/statistics/overview?maxArea=1000001", http.StatusBadRequest},
		{"area at maximum", "/api/v1/statistics/overview?maxArea=1000000", http.StatusOK},
		{"income over maximum", "/api/v1/affordability?netIncome=100001", http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if response := get(handler, test.path); response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}
