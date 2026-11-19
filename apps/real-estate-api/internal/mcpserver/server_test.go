package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// recorder keeps the last query string of each API path the tools called.
type recorder struct {
	mu      sync.Mutex
	queries map[string]string
	calls   map[string]int
}

func (r *recorder) record(path, query string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries[path] = query
	r.calls[path]++
}

func (r *recorder) query(path string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.queries[path]
}

func (r *recorder) count(path string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls[path]
}

// override replaces the stub's answer for one path.
type override struct {
	path    string
	handler http.HandlerFunc
}

// stubAPI answers the endpoints the tools call, recording the query of each path.
func stubAPI(t *testing.T, overrides ...override) (*httptest.Server, *recorder) {
	t.Helper()
	recorded := &recorder{queries: map[string]string{}, calls: map[string]int{}}
	mux := http.NewServeMux()
	overridden := map[string]bool{}
	for _, o := range overrides {
		overridden[o.path] = true
		handler := o.handler
		mux.HandleFunc("GET "+o.path, func(w http.ResponseWriter, r *http.Request) {
			recorded.record(r.URL.Path, r.URL.RawQuery)
			handler(w, r)
		})
	}
	answer := func(path string, body any) {
		if overridden[path] {
			return
		}
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			recorded.record(r.URL.Path, r.URL.RawQuery)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(body)
		})
	}
	answer("/api/v1/data-status", map[string]any{"status": "current", "activeRelease": map[string]any{"id": "r1", "analyticsSaleThrough": "2026-10-01T00:00:00Z"}})
	answer("/api/v1/meta", map[string]any{"application": "real-estate-api", "build": "test"})
	mux.HandleFunc("GET /api/v1/geographies", func(w http.ResponseWriter, r *http.Request) {
		recorded.record(r.URL.Path+"?"+r.URL.Query().Get("level"), r.URL.RawQuery)
		items := map[string][]map[string]any{
			"municipality": {{"id": 108, "level": "municipality", "name": "Ruše"}, {"id": 61, "level": "municipality", "name": "Ljubljana"}},
			"settlement":   {{"id": 5001, "level": "settlement", "name": "Ruše"}, {"id": 5002, "level": "settlement", "name": "Rušečica"}},
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items[r.URL.Query().Get("level")]})
	})
	answer("/api/v1/statistics/overview", map[string]any{"transactionCount": 40, "medianPricePerSqm": 2100.5, "isPublishable": true})
	answer("/api/v1/rentals/statistics/overview", map[string]any{"transactionCount": 12, "medianRentPerSqm": 9.5})
	answer("/api/v1/statistics/timeseries", map[string]any{"items": []any{}})
	answer("/api/v1/statistics/distribution", map[string]any{"bins": []any{}})
	answer("/api/v1/transactions/recent", map[string]any{"items": []any{}, "count": 0, "total": 0})
	answer("/api/v1/buildings/search", map[string]any{"items": []any{}})
	answer("/api/v1/buildings/665/2257/statistics", map[string]any{"cadastralCode": 665, "buildingNumber": "2257"})
	answer("/api/v1/sales/transactions/972894", map[string]any{"transactionId": 972894, "price": 139000.0, "building": map[string]any{"flood": nil}})
	answer("/api/v1/sales/transactions/972894/context", map[string]any{"currentMarketEstimate": map[string]any{"centralTotal": 143808.0}})
	answer("/api/v1/sales/transactions/972894/history", map[string]any{"items": []any{}})
	answer("/api/v1/rentals/transactions/5", map[string]any{"transactionId": 5})
	answer("/api/v1/affordability", map[string]any{"bands": []any{}})
	answer("/api/v1/affordability/municipalities", map[string]any{"items": []any{}})
	answer("/api/v1/indices", map[string]any{"items": []any{}, "count": 0})
	answer("/api/v1/demographics", map[string]any{"population": []any{}})
	mux.HandleFunc("GET /api/v1/sales/transactions/1", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"code":"transaction_not_found","message":"transaction was not found"}}`))
	})
	answer("/api/v1/hazards/floods", map[string]any{"type": "FeatureCollection", "truncated": false, "features": []map[string]any{
		{"properties": map[string]any{"kind": "zone", "hazardClass": "Pm"}, "geometry": map[string]any{"type": "Polygon", "coordinates": []any{}}},
		{"properties": map[string]any{"kind": "zone", "hazardClass": "Pm"}, "geometry": map[string]any{"type": "Polygon", "coordinates": []any{}}},
		{"properties": map[string]any{"kind": "study", "hazardClass": nil}, "geometry": map[string]any{"type": "Polygon", "coordinates": []any{}}},
	}})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server, recorded
}

func newService(t *testing.T, apiURL, docsDir string) *Service {
	t.Helper()
	client, err := NewClient(apiURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	return NewService(client, Options{DocsDir: docsDir, SiteURL: "https://sreo.test/"})
}

// connect runs the MCP server over in-memory transports and returns a connected client session.
func connect(t *testing.T, apiURL, docsDir string) *mcp.ClientSession {
	t.Helper()
	server := newService(t, apiURL, docsDir).Server()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	ctx := context.Background()
	if _, err := server.Connect(ctx, serverTransport, nil); err != nil {
		t.Fatal(err)
	}
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func call(t *testing.T, session *mcp.ClientSession, name string, args map[string]any) (map[string]any, *mcp.CallToolResult) {
	t.Helper()
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: protocol error %v", name, err)
	}
	body, _ := result.StructuredContent.(map[string]any)
	return body, result
}

// failure calls a tool that must fail and returns the message, whether the input was rejected
// by the schema (a protocol error) or by the handler (a tool error).
func failure(t *testing.T, session *mcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		return err.Error()
	}
	if !result.IsError {
		t.Fatalf("%s(%v) succeeded, want an error", name, args)
	}
	text, _ := result.Content[0].(*mcp.TextContent)
	if text == nil {
		t.Fatalf("%s: error without text: %v", name, result.Content)
	}
	return text.Text
}

func TestToolsAreListedReadOnlyWithSchemas(t *testing.T) {
	api, _ := stubAPI(t)
	session := connect(t, api.URL, "")
	listed, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	schemas := map[string]map[string]any{}
	for _, tool := range listed.Tools {
		schema, _ := tool.InputSchema.(map[string]any)
		schemas[tool.Name] = schema
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint {
			t.Errorf("%s is not marked read-only", tool.Name)
		}
		if schema == nil {
			t.Errorf("%s has no input schema", tool.Name)
		}
		if tool.Title == "" {
			t.Errorf("%s has no title", tool.Name)
		}
	}
	for _, want := range []string{"find_areas", "search_addresses", "building", "sale", "rental", "market_overview", "price_trend",
		"price_distribution", "recent_sales", "affordability", "municipality_affordability", "price_index", "demographics",
		"property_history", "flood_zones", "data_status"} {
		if schemas[want] == nil {
			t.Errorf("tool %s is missing", want)
		}
	}
	if len(listed.Tools) != 16 {
		t.Errorf("tools=%d, want 16", len(listed.Tools))
	}
	// Enums and bounds reach the client, and the embedded market input is flattened.
	properties := func(tool string) map[string]any {
		p, _ := schemas[tool]["properties"].(map[string]any)
		return p
	}
	level, _ := properties("find_areas")["level"].(map[string]any)
	if enum, _ := level["enum"].([]any); len(enum) != len(geographyLevels) {
		t.Errorf("find_areas.level enum=%v", level)
	}
	limit, _ := properties("search_addresses")["limit"].(map[string]any)
	if limit["maximum"] != float64(maxSearchLimit) {
		t.Errorf("search_addresses.limit=%v, want maximum %d", limit, maxSearchLimit)
	}
	if _, ok := properties("price_trend")["geographyId"]; !ok {
		t.Errorf("price_trend lacks the shared market properties: %v", properties("price_trend"))
	}
	number, _ := properties("building")["buildingNumber"].(map[string]any)
	if number["pattern"] != buildingNumberPattern.String() {
		t.Errorf("building.buildingNumber=%v, want the digits pattern", number)
	}
}

func TestFindAreasFoldsDiacriticsAndRanksExactNamesFirst(t *testing.T) {
	api, _ := stubAPI(t)
	session := connect(t, api.URL, "")
	body, _ := call(t, session, "find_areas", map[string]any{"query": "ruse"})
	items, _ := body["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items=%v, want Ruše (municipality), Ruše (settlement) and Rušečica", items)
	}
	first, _ := items[0].(map[string]any)
	if first["name"] != "Ruše" {
		t.Errorf("first=%v, want an exact match first", first)
	}
	last, _ := items[2].(map[string]any)
	if last["name"] != "Rušečica" {
		t.Errorf("last=%v, want the partial match last", last)
	}
	if body["source"] != Attribution {
		t.Error("answer lacks the source notice")
	}
	if _, ok := body["hint"]; ok {
		t.Error("a complete list carries no hint")
	}
	body, _ = call(t, session, "find_areas", map[string]any{"query": "ruše", "level": "municipality"})
	if body["count"] != float64(1) {
		t.Errorf("count=%v, want 1 municipality", body["count"])
	}
}

func TestMarketOverviewDefaultsToTheSitePeriods(t *testing.T) {
	api, queries := stubAPI(t)
	session := connect(t, api.URL, "")
	body, _ := call(t, session, "market_overview", map[string]any{"geographyId": 108})
	// Cutoff 2026-10-01, lagged three months to July: the last full quarter ends 2026-06-30.
	sales := queries.query("/api/v1/statistics/overview")
	if !strings.Contains(sales, "from=2025-07-01") || !strings.Contains(sales, "to=2026-06-30") {
		t.Errorf("sales query=%q, want the twelve months to 2026-06-30", sales)
	}
	if !strings.Contains(sales, "geographyId=108") || !strings.Contains(sales, "propertyGroup=apartment") {
		t.Errorf("sales query=%q, want the area and the default property group", sales)
	}
	// Rents: the last calendar year mostly reported (nine months of lag, then the year before), 2025 for an October 2026 cutoff.
	if rents := queries.query("/api/v1/rentals/statistics/overview"); !strings.Contains(rents, "from=2025-01-01") {
		t.Errorf("rent query=%q, want calendar year 2025", rents)
	}
	if body["link"] != "https://sreo.test/#?g=108" {
		t.Errorf("link=%v", body["link"])
	}
	if _, ok := body["rentals"]; !ok {
		t.Error("answer lacks the rental overview")
	}
}

func TestSaleWithContextAndNotFound(t *testing.T) {
	api, _ := stubAPI(t)
	session := connect(t, api.URL, "")
	body, _ := call(t, session, "sale", map[string]any{"transactionId": 972894, "includeContext": true})
	if _, ok := body["context"].(map[string]any); !ok {
		t.Errorf("answer lacks the context: %v", body)
	}
	_, result := call(t, session, "sale", map[string]any{"transactionId": 1})
	if !result.IsError {
		t.Fatal("a missing sale must be a tool error")
	}
	text, _ := result.Content[0].(*mcp.TextContent)
	if text == nil || !strings.Contains(text.Text, "not in the published data") {
		t.Errorf("error text=%v", result.Content)
	}
}

func TestFloodZonesSummarisesClasses(t *testing.T) {
	api, queries := stubAPI(t)
	session := connect(t, api.URL, "")
	body, _ := call(t, session, "flood_zones", map[string]any{"west": 15.2, "south": 46.2, "east": 15.3, "north": 46.26})
	classes, _ := body["classes"].(map[string]any)
	if classes["Pm"] != float64(2) {
		t.Errorf("classes=%v, want two Pm polygons", classes)
	}
	if body["hasStudiedArea"] != true || body["studyAreas"] != float64(1) || body["countsPartial"] != false {
		t.Errorf("hasStudiedArea=%v studyAreas=%v countsPartial=%v", body["hasStudiedArea"], body["studyAreas"], body["countsPartial"])
	}
	if _, ok := body["polygons"]; ok {
		t.Error("polygons returned without includeGeometry")
	}
	if q := queries.query("/api/v1/hazards/floods"); !strings.Contains(q, "bbox=15.20000%2C46.20000%2C15.30000%2C46.26000") || !strings.Contains(q, "detail=low") {
		t.Errorf("query=%q", q)
	}
	if text := failure(t, session, "flood_zones", map[string]any{"west": 15.3, "south": 46.2, "east": 15.2, "north": 46.26}); !strings.Contains(text, "west must be less than east") {
		t.Errorf("inverted bbox: %s", text)
	}
	if text := failure(t, session, "flood_zones", map[string]any{"west": 15.0, "south": 46.2, "east": 15.3, "north": 46.26}); !strings.Contains(text, "0.26") {
		t.Errorf("wide bbox: %s", text)
	}
}

func TestResourcesIncludeTheEmbeddedAboutAndTheDocsOnDisk(t *testing.T) {
	api, _ := stubAPI(t)
	docs := t.TempDir()
	if err := os.WriteFile(filepath.Join(docs, "statistical-methodology.md"), []byte("# Methodology\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	session := connect(t, api.URL, docs)
	listed, err := session.ListResources(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	sizes := map[string]int64{}
	for _, resource := range listed.Resources {
		sizes[resource.URI] = resource.Size
	}
	if _, ok := sizes["sreo://about"]; !ok || sizes["sreo://docs/methodology"] != 14 {
		t.Errorf("resources=%v, want about and the one document on disk with its size", sizes)
	}
	if _, ok := sizes["sreo://docs/licensing"]; ok {
		t.Error("a document missing on disk was listed")
	}
	if sizes["sreo://about"] != int64(len(aboutText)) {
		t.Errorf("about size=%d", sizes["sreo://about"])
	}
	read, err := session.ReadResource(context.Background(), &mcp.ReadResourceParams{URI: "sreo://docs/methodology"})
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Contents) != 1 || !strings.HasPrefix(read.Contents[0].Text, "# Methodology") {
		t.Errorf("contents=%v", read.Contents)
	}
}

func TestSalesWindowFollowsTheQuarterLag(t *testing.T) {
	cases := []struct{ cutoff, from, to string }{
		{"2026-10-01", "2025-07-01", "2026-06-30"},
		{"2026-07-15", "2025-04-01", "2026-03-31"},
		{"2026-01-05", "2024-10-01", "2025-09-30"},
	}
	for _, c := range cases {
		cutoff, _ := time.Parse("2006-01-02", c.cutoff)
		got := salesWindow(cutoff)
		if got.from != c.from || got.to != c.to {
			t.Errorf("cutoff %s: got %s–%s, want %s–%s", c.cutoff, got.from, got.to, c.from, c.to)
		}
	}
}

func TestClientRejectsRelativeURLs(t *testing.T) {
	if _, err := NewClient("localhost:8080", nil); err == nil {
		t.Error("a URL without a scheme must be rejected")
	}
}

// TestToolQueries pins the query each tool sends to the API: names, defaults, clamps and the
// parameters that must be left out when empty.
func TestToolQueries(t *testing.T) {
	cases := []struct {
		tool    string
		args    map[string]any
		path    string
		want    []string
		notWant []string
	}{
		{"search_addresses", map[string]any{"query": "Hmeljarska 8"}, "/api/v1/buildings/search", []string{"q=Hmeljarska+8", "limit=10"}, nil},
		{"building", map[string]any{"cadastralCode": 665, "buildingNumber": "2257"}, "/api/v1/buildings/665/2257/statistics", nil, []string{"propertyGroup"}},
		{"building", map[string]any{"cadastralCode": 665, "buildingNumber": "2257", "propertyGroup": "house"}, "/api/v1/buildings/665/2257/statistics", []string{"propertyGroup=house"}, nil},
		{"rental", map[string]any{"transactionId": 5}, "/api/v1/rentals/transactions/5", nil, nil},
		{"market_overview", map[string]any{"propertyGroup": "house", "minArea": 80, "maxArea": 200}, "/api/v1/statistics/overview",
			[]string{"propertyGroup=house", "minArea=80", "maxArea=200", "from=2025-07-01", "to=2026-06-30"}, []string{"geographyId"}},
		{"price_trend", map[string]any{"geographyId": 61}, "/api/v1/statistics/timeseries", []string{"interval=year", "from=2016-07-01", "to=2026-06-30", "geographyId=61"}, nil},
		{"price_trend", map[string]any{"interval": "quarter", "from": "2020-01-01", "to": "2021-12-31"}, "/api/v1/statistics/timeseries", []string{"interval=quarter", "from=2020-01-01", "to=2021-12-31"}, nil},
		{"price_distribution", map[string]any{}, "/api/v1/statistics/distribution", []string{"metric=pricePerSqm", "propertyGroup=apartment"}, nil},
		{"price_distribution", map[string]any{"metric": "price"}, "/api/v1/statistics/distribution", []string{"metric=price"}, nil},
		{"recent_sales", map[string]any{"geographyId": 108}, "/api/v1/transactions/recent", []string{"transactionKind=sale", "limit=20", "from=2025-07-01", "to=2026-06-30"}, []string{"offset", "propertyGroup", "street"}},
		{"recent_sales", map[string]any{"transactionKind": "rent", "propertyGroup": "room", "limit": 100, "offset": 40, "street": " Cesta "}, "/api/v1/transactions/recent",
			[]string{"transactionKind=rent", "propertyGroup=room", "limit=100", "offset=40", "street=Cesta", "from=2025-01-01", "to=2025-12-31"}, nil},
		{"affordability", map[string]any{"geographyId": 108, "netIncome": 1800.5, "coBorrowerIncome": 1200}, "/api/v1/affordability", []string{"geographyId=108", "netIncome=1800.5", "coBorrowerIncome=1200"}, []string{"propertyGroup"}},
		{"municipality_affordability", map[string]any{"propertyGroup": "house"}, "/api/v1/affordability/municipalities", []string{"propertyGroup=house"}, nil},
		{"price_index", map[string]any{}, "/api/v1/indices", []string{"method=hedonic", "propertyGroup=apartment", "transactionKind=sale"}, nil},
		{"price_index", map[string]any{"transactionKind": "rent", "propertyGroup": "room"}, "/api/v1/indices", []string{"method=hedonic", "propertyGroup=room", "transactionKind=rent"}, nil},
		{"demographics", map[string]any{}, "/api/v1/demographics", nil, []string{"geographyId"}},
		{"demographics", map[string]any{"geographyId": 61}, "/api/v1/demographics", []string{"geographyId=61"}, nil},
		{"property_history", map[string]any{"transactionId": 972894}, "/api/v1/sales/transactions/972894/history", nil, nil},
		{"data_status", map[string]any{}, "/api/v1/meta", nil, nil},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("%s %v", c.tool, c.args), func(t *testing.T) {
			api, queries := stubAPI(t)
			session := connect(t, api.URL, "")
			body, result := call(t, session, c.tool, c.args)
			if result.IsError {
				t.Fatalf("tool error: %v", result.Content)
			}
			if body["source"] != Attribution {
				t.Error("answer lacks the source notice")
			}
			if queries.count(c.path) != 1 {
				t.Fatalf("%s was called %d times", c.path, queries.count(c.path))
			}
			got := queries.query(c.path)
			for _, want := range c.want {
				if !strings.Contains(got, want) {
					t.Errorf("query=%q lacks %q", got, want)
				}
			}
			for _, unwanted := range c.notWant {
				if strings.Contains(got, unwanted) {
					t.Errorf("query=%q carries %q", got, unwanted)
				}
			}
		})
	}
	t.Run("price_index notes a missing index", func(t *testing.T) {
		api, _ := stubAPI(t)
		session := connect(t, api.URL, "")
		body, _ := call(t, session, "price_index", map[string]any{"propertyGroup": "garage"})
		if note, _ := body["note"].(string); !strings.Contains(note, "no hedonic sale index is published for garage") {
			t.Errorf("note=%v", body["note"])
		}
	})
	t.Run("invalid enum values are rejected", func(t *testing.T) {
		api, queries := stubAPI(t)
		session := connect(t, api.URL, "")
		for _, c := range []struct {
			tool string
			args map[string]any
		}{
			{"recent_sales", map[string]any{"transactionKind": "sale", "propertyGroup": "room"}},
			{"price_index", map[string]any{"transactionKind": "sale", "propertyGroup": "room"}},
			{"price_index", map[string]any{"transactionKind": "lease"}},
			{"affordability", map[string]any{"propertyGroup": "land"}},
			{"affordability", map[string]any{"netIncome": 250000}},
			{"market_overview", map[string]any{"propertyGroup": "room"}},
			{"market_overview", map[string]any{"minArea": 100, "maxArea": 50}},
			{"price_trend", map[string]any{"interval": "week"}},
			{"find_areas", map[string]any{"query": "Ruše", "level": "country"}},
		} {
			failure(t, session, c.tool, c.args)
		}
		for _, path := range []string{"/api/v1/transactions/recent", "/api/v1/indices", "/api/v1/affordability", "/api/v1/statistics/overview", "/api/v1/statistics/timeseries"} {
			if queries.count(path) != 0 {
				t.Errorf("%s was called with invalid input", path)
			}
		}
	})
}

func TestHTTPTransportServesSessionsAndLiveness(t *testing.T) {
	api, _ := stubAPI(t)
	service := newService(t, api.URL, "")
	web := httptest.NewServer(service.HTTPHandler())
	t.Cleanup(web.Close)

	response, err := http.Get(web.URL + "/health/live")
	if err != nil {
		t.Fatal(err)
	}
	live, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(live), `"ok"`) {
		t.Errorf("liveness: %d %s", response.StatusCode, live)
	}

	// A raw initialize gets a session id: the transport is stateful.
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"raw","version":"0"}}}`
	request, _ := http.NewRequest(http.MethodPost, web.URL+"/mcp", bytes.NewBufferString(initialize))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Mcp-Session-Id") == "" {
		t.Errorf("initialize: %d, session id %q", response.StatusCode, response.Header.Get("Mcp-Session-Id"))
	}

	// Two SDK clients: separate sessions, one shared service, both see every tool.
	ctx := context.Background()
	for i := range 2 {
		client := mcp.NewClient(&mcp.Implementation{Name: fmt.Sprintf("client-%d", i), Version: "0"}, nil)
		session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: web.URL + "/mcp"}, nil)
		if err != nil {
			t.Fatal(err)
		}
		listed, err := session.ListTools(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(listed.Tools) != 16 {
			t.Errorf("session %d lists %d tools", i, len(listed.Tools))
		}
		body, _ := call(t, session, "find_areas", map[string]any{"query": "ljubljana"})
		if body["count"] != float64(1) {
			t.Errorf("session %d: find_areas=%v", i, body)
		}
		if err := session.Close(); err != nil {
			t.Errorf("close session %d: %v", i, err)
		}
	}
}

func TestOneSidedPeriodsFollowTheGivenBound(t *testing.T) {
	api, queries := stubAPI(t)
	session := connect(t, api.URL, "")
	cases := []struct {
		tool string
		args map[string]any
		path string
		from string
		to   string
	}{
		{"market_overview", map[string]any{"to": "2020-12-31"}, "/api/v1/statistics/overview", "2020-01-01", "2020-12-31"},
		{"market_overview", map[string]any{"from": "2020-01-01"}, "/api/v1/statistics/overview", "2020-01-01", "2020-12-31"},
		// A start inside the last year is cut at the end of the published data.
		{"market_overview", map[string]any{"from": "2026-01-01"}, "/api/v1/statistics/overview", "2026-01-01", "2026-06-30"},
		{"price_trend", map[string]any{"to": "2019-12-31"}, "/api/v1/statistics/timeseries", "2010-01-01", "2019-12-31"},
		{"price_trend", map[string]any{"from": "2010-01-01"}, "/api/v1/statistics/timeseries", "2010-01-01", "2019-12-31"},
		{"recent_sales", map[string]any{"to": "2022-06-30"}, "/api/v1/transactions/recent", "2021-07-01", "2022-06-30"},
		{"recent_sales", map[string]any{"transactionKind": "rent", "from": "2024-03-01"}, "/api/v1/transactions/recent", "2024-03-01", "2025-02-28"},
	}
	for _, c := range cases {
		body, result := call(t, session, c.tool, c.args)
		if result.IsError {
			t.Errorf("%s %v: %v", c.tool, c.args, result.Content)
			continue
		}
		got := queries.query(c.path)
		if !strings.Contains(got, "from="+c.from) || !strings.Contains(got, "to="+c.to) {
			t.Errorf("%s %v: query=%q, want %s–%s", c.tool, c.args, got, c.from, c.to)
		}
		if c.tool == "market_overview" {
			if period, _ := body["period"].(map[string]any); period["from"] != c.from || period["to"] != c.to {
				t.Errorf("%s %v: period=%v", c.tool, c.args, period)
			}
		}
	}
	for _, c := range []struct {
		args map[string]any
		want string
	}{
		{map[string]any{"from": "2021-01-01", "to": "2020-12-31"}, "must not be after"},
		{map[string]any{"from": "2026-07-01"}, "after 2026-06-30"},
		{map[string]any{"from": "2020-13-01", "to": "2020-12-31"}, "from must be a date"},
		{map[string]any{"to": "yesterday"}, "to must be a date"},
	} {
		if text := failure(t, session, "market_overview", c.args); !strings.Contains(text, c.want) {
			t.Errorf("%v: %q, want %q", c.args, text, c.want)
		}
	}
}

func TestBuildingRejectsPathCharacters(t *testing.T) {
	api, queries := stubAPI(t)
	session := connect(t, api.URL, "")
	for _, number := range []string{"../../meta", "2257/statistics", "2257?x=1", "", " 2257", "A12"} {
		text := failure(t, session, "building", map[string]any{"cadastralCode": 665, "buildingNumber": number})
		if !strings.Contains(strings.ToLower(text), "buildingnumber") {
			t.Errorf("%q: %s", number, text)
		}
	}
	if text := failure(t, session, "building", map[string]any{"cadastralCode": 0, "buildingNumber": "2257"}); !strings.Contains(strings.ToLower(text), "cadastralcode") {
		t.Errorf("cadastralCode 0: %s", text)
	}
	if text := failure(t, session, "building", map[string]any{"cadastralCode": -5, "buildingNumber": "2257"}); !strings.Contains(strings.ToLower(text), "cadastralcode") {
		t.Errorf("cadastralCode -5: %s", text)
	}
	queries.mu.Lock()
	defer queries.mu.Unlock()
	for path := range queries.queries {
		if strings.HasPrefix(path, "/api/v1/buildings/") || path == "/api/v1/meta" {
			t.Errorf("the API was reached at %s", path)
		}
	}
}

func TestSearchAddressesKeepsTheAPIBounds(t *testing.T) {
	api, queries := stubAPI(t)
	session := connect(t, api.URL, "")
	if text := failure(t, session, "search_addresses", map[string]any{"query": "ab"}); !strings.Contains(text, "3") {
		t.Errorf("short query: %s", text)
	}
	if text := failure(t, session, "search_addresses", map[string]any{"query": "Ruše", "limit": 50}); !strings.Contains(text, "20") {
		t.Errorf("limit 50: %s", text)
	}
	if queries.count("/api/v1/buildings/search") != 0 {
		t.Error("the API was called with invalid input")
	}
	call(t, session, "search_addresses", map[string]any{"query": "  Ruše ", "limit": 20})
	if got := queries.query("/api/v1/buildings/search"); !strings.Contains(got, "limit=20") || !strings.Contains(got, "q=Ru%C5%A1e") {
		t.Errorf("query=%q", got)
	}
}

func TestMarketOverviewReportsRentalFailuresAndSkipsLand(t *testing.T) {
	api, queries := stubAPI(t, override{"/api/v1/rentals/statistics/overview", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"internal","message":"rentals are being refreshed"}}`))
	}})
	session := connect(t, api.URL, "")
	body, result := call(t, session, "market_overview", map[string]any{"geographyId": 108})
	if result.IsError {
		t.Fatalf("a rental failure must not fail the sales overview: %v", result.Content)
	}
	if _, ok := body["rentals"]; ok {
		t.Error("rentals present although the call failed")
	}
	if note, _ := body["rentalsUnavailable"].(string); !strings.Contains(note, "rentals are being refreshed") {
		t.Errorf("rentalsUnavailable=%v", body["rentalsUnavailable"])
	}
	body, _ = call(t, session, "market_overview", map[string]any{"propertyGroup": "land"})
	if _, ok := body["rentalsUnavailable"]; ok {
		t.Error("land has no rental overview to report on")
	}
	if queries.count("/api/v1/rentals/statistics/overview") != 1 {
		t.Errorf("rental overview called %d times, want once (not for land)", queries.count("/api/v1/rentals/statistics/overview"))
	}
}

func TestFloodZonesCapsThePolygons(t *testing.T) {
	features := make([]map[string]any, 0, maxFloodPolygons+50)
	for i := range maxFloodPolygons + 50 {
		class := "Pm"
		if i%2 == 0 {
			class = "Ps"
		}
		features = append(features, map[string]any{"properties": map[string]any{"kind": "zone", "hazardClass": class},
			"geometry": map[string]any{"type": "Polygon", "coordinates": []any{}}})
	}
	api, _ := stubAPI(t, override{"/api/v1/hazards/floods", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "FeatureCollection", "truncated": true, "features": features})
	}})
	session := connect(t, api.URL, "")
	body, _ := call(t, session, "flood_zones", map[string]any{"west": 15.2, "south": 46.2, "east": 15.3, "north": 46.26, "includeGeometry": true})
	polygons, _ := body["polygons"].([]any)
	if len(polygons) != maxFloodPolygons {
		t.Errorf("polygons=%d, want %d", len(polygons), maxFloodPolygons)
	}
	if body["polygonsTruncated"] != true || body["countsPartial"] != true {
		t.Errorf("polygonsTruncated=%v countsPartial=%v", body["polygonsTruncated"], body["countsPartial"])
	}
	classes, _ := body["classes"].(map[string]any)
	if classes["Ps"] != float64(125) || classes["Pm"] != float64(125) {
		t.Errorf("classes=%v, want every feature counted", classes)
	}
	if body["hasStudiedArea"] != true || body["studyAreas"] != float64(0) {
		t.Errorf("hasStudiedArea=%v studyAreas=%v", body["hasStudiedArea"], body["studyAreas"])
	}
}
