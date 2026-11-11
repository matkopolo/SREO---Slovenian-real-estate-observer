package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"gopkg.in/yaml.v3"
)

// The response contract test runs every documented GET operation against the handlers (with
// the fakes of the other tests) and validates each JSON body against the response schema that
// openapi.yaml documents for its status and content type. A field a handler adds, renames or
// drops without updating the contract fails here.

const contractPath = "../../openapi/openapi.yaml"

// contractRequests are the requests the test sends, by documented path. Each must answer 200.
var contractRequests = map[string]string{
	"/health/live":                                                  "/health/live",
	"/health/ready":                                                 "/health/ready",
	"/api/v1/meta":                                                  "/api/v1/meta",
	"/api/v1/data-status":                                           "/api/v1/data-status",
	"/api/v1/economy/inflation":                                     "/api/v1/economy/inflation?from=2024-01-01&to=2024-06-30&interval=month",
	"/api/v1/economy/inflation-factor":                              "/api/v1/economy/inflation-factor?from=2024-01-01&to=2024-06-30",
	"/api/v1/affordability":                                         "/api/v1/affordability?geographyId=70",
	"/api/v1/affordability/municipalities":                          "/api/v1/affordability/municipalities",
	"/api/v1/demographics":                                          "/api/v1/demographics?geographyId=70",
	"/api/v1/demographics/municipalities":                           "/api/v1/demographics/municipalities",
	"/api/v1/map/buildings":                                         "/api/v1/map/buildings?bbox=14.4,46.0,14.6,46.1",
	"/api/v1/construction/summary":                                  "/api/v1/construction/summary",
	"/api/v1/construction/map":                                      "/api/v1/construction/map?bbox=14.4,46.0,14.6,46.1&zoom=15",
	"/api/v1/construction/buildings/{eid}":                          "/api/v1/construction/buildings/1",
	"/api/v1/hazards/floods":                                        "/api/v1/hazards/floods?bbox=14.4,46.0,14.6,46.1",
	"/api/v1/sales/statistics/resales":                              "/api/v1/sales/statistics/resales",
	"/api/v1/sales/transactions/{id}/history":                       "/api/v1/sales/transactions/1/history",
	"/api/v1/geographies":                                           "/api/v1/geographies?level=municipality",
	"/api/v1/geographies/boundaries":                                "/api/v1/geographies/boundaries?level=municipality",
	"/api/v1/geographies/{id}":                                      "/api/v1/geographies/70",
	"/api/v1/geographies/{id}/boundary":                             "/api/v1/geographies/70/boundary",
	"/api/v1/geographies/{id}/children":                             "/api/v1/geographies/70/children",
	"/api/v1/statistics/overview":                                   "/api/v1/statistics/overview?propertyGroup=apartment",
	"/api/v1/statistics/timeseries":                                 "/api/v1/statistics/timeseries?interval=month",
	"/api/v1/statistics/outliers":                                   "/api/v1/statistics/outliers",
	"/api/v1/transactions/extremes":                                 "/api/v1/transactions/extremes",
	"/api/v1/transactions/recent":                                   "/api/v1/transactions/recent",
	"/api/v1/rentals/statistics/overview":                           "/api/v1/rentals/statistics/overview",
	"/api/v1/rentals/statistics/timeseries":                         "/api/v1/rentals/statistics/timeseries?interval=month",
	"/api/v1/rentals/statistics/outliers":                           "/api/v1/rentals/statistics/outliers",
	"/api/v1/rentals/map/clusters":                                  "/api/v1/rentals/map/clusters?bbox=14.4,46.0,14.6,46.1&zoom=10",
	"/api/v1/rentals/map/geographies":                               "/api/v1/rentals/map/geographies?bbox=14.4,46.0,14.6,46.1&level=municipality",
	"/api/v1/rentals/map/properties":                                "/api/v1/rentals/map/properties?bbox=14.4,46.0,14.6,46.1&zoom=15",
	"/api/v1/sales/transactions/{id}":                               "/api/v1/sales/transactions/1",
	"/api/v1/sales/transactions/{id}/context":                       "/api/v1/sales/transactions/1/context",
	"/api/v1/rentals/transactions/{id}":                             "/api/v1/rentals/transactions/1",
	"/api/v1/rentals/transactions/{id}/context":                     "/api/v1/rentals/transactions/1/context",
	"/api/v1/statistics/distribution":                               "/api/v1/statistics/distribution",
	"/api/v1/rentals/statistics/distribution":                       "/api/v1/rentals/statistics/distribution",
	"/api/v1/buildings/{cadastralCode}/{buildingNumber}/statistics": "/api/v1/buildings/657/123/statistics",
	"/api/v1/buildings/search":                                      "/api/v1/buildings/search?q=lackova",
	"/api/v1/anomalies":                                             "/api/v1/anomalies",
	"/api/v1/anomalies/summary":                                     "/api/v1/anomalies/summary",
	"/api/v1/indices":                                               "/api/v1/indices",
	"/api/v1/valuations/{kind}/{id}":                                "/api/v1/valuations/sale/1",
	"/api/v1/map/clusters":                                          "/api/v1/map/clusters?bbox=14.4,46.0,14.6,46.1&zoom=10",
	"/api/v1/map/geographies":                                       "/api/v1/map/geographies?bbox=14.4,46.0,14.6,46.1&level=municipality",
	"/api/v1/map/properties":                                        "/api/v1/map/properties?bbox=14.4,46.0,14.6,46.1&zoom=15",
}

// contractErrors are error answers whose body must match the documented error schema.
var contractErrors = []struct{ path, request string }{
	{"/api/v1/statistics/overview", "/api/v1/statistics/overview?from=2024-13-01"},
	{"/api/v1/geographies/{id}", "/api/v1/geographies/x"},
}

// contractHandler uses the shared fakes, made realistic where a zero value cannot occur in
// production (an empty enum, a nil list the repository always initialises).
func contractHandler() http.Handler {
	code := int32(70000)
	return handlerWith(func(d *Dependencies) {
		d.Geographies = fakeGeographies{units: []geography.Unit{{ID: 70, Level: "municipality", Code: &code, Name: "Maribor"}}}
		d.Affordability = fakeAffordability{wages: map[string][]affordability.Observation{"SI": wageSet(1500), "70000": wageSet(1400)}}
		d.Statistics = contractStatistics{d.Statistics.(fakeStatistics)}
		d.Buildings = contractBuildings{}
		d.Transactions = contractTransactions{}
		d.Distributions = contractDistributions{}
		d.Demography = contractDemography{}
		d.Models = contractModels{}
		d.Construction = contractConstruction{}
	})
}

type contractStatistics struct{ fakeStatistics }

func (store contractStatistics) Outliers(ctx context.Context, filter analytics.StatisticsFilter, limit, offset int) ([]analytics.OutlierRecord, int64, error) {
	items, total, err := store.fakeStatistics.Outliers(ctx, filter, limit, offset)
	for index := range items {
		items[index].CohortLevel, items[index].RuleVersion = "municipality_year", "mad-v1"
	}
	return items, total, err
}

type contractBuildings struct{ fakeBuildings }

func (store contractBuildings) BuildingStatistics(ctx context.Context, code int32, number string, filter analytics.BuildingFilter) (analytics.BuildingStatistics, error) {
	result, err := store.fakeBuildings.BuildingStatistics(ctx, code, number, filter)
	result.SaleHistory, result.RentalHistory = []analytics.BuildingYearPoint{}, []analytics.BuildingYearPoint{}
	result.SaleTransactions, result.RentalTransactions = []analytics.BuildingTransaction{}, []analytics.BuildingTransaction{}
	return result, err
}

func (store contractBuildings) SearchBuildings(ctx context.Context, query string, limit int, filter analytics.BuildingFilter) (analytics.BuildingSearch, error) {
	result, err := store.fakeBuildings.SearchBuildings(ctx, query, limit, filter)
	for index := range result.Items {
		result.Items[index].SaleCounts = map[string]int64{"apartment": 2}
		result.Items[index].RentalCounts = map[string]int64{}
	}
	return result, err
}

func contractQuality() analytics.QualityDecision {
	return analytics.QualityDecision{IsQualityEligible: true, IsRepresentative: true, Reasons: []string{}, AnomalyFlags: []string{}}
}

type contractTransactions struct{ fakeTransactions }

func (store contractTransactions) SaleTransaction(ctx context.Context, id int64) (analytics.SaleTransactionDetail, error) {
	result, err := store.fakeTransactions.SaleTransaction(ctx, id)
	result.Quality, result.Geographies = contractQuality(), []analytics.TransactionGeography{}
	result.BuildingParts, result.LandParcels = []analytics.SaleBuildingPart{}, []analytics.SaleLandParcel{}
	return result, err
}

func (store contractTransactions) RentalTransaction(ctx context.Context, id int64) (analytics.RentalTransactionDetail, error) {
	result, err := store.fakeTransactions.RentalTransaction(ctx, id)
	result.Quality, result.Geographies, result.Spaces = contractQuality(), []analytics.TransactionGeography{}, []analytics.RentalSpace{}
	return result, err
}

func (store contractTransactions) TransactionContext(ctx context.Context, kind string, id int64) (analytics.TransactionContext, error) {
	result, err := store.fakeTransactions.TransactionContext(ctx, kind, id)
	result.Quality = contractQuality()
	return result, err
}

type contractDistributions struct{ fakeDistributions }

func (store contractDistributions) SaleDistribution(ctx context.Context, filter analytics.StatisticsFilter, metric string, bins int) (analytics.Distribution, error) {
	result, err := store.fakeDistributions.SaleDistribution(ctx, filter, metric, bins)
	result.Buckets = []analytics.HistogramBucket{}
	return result, err
}

func (store contractDistributions) RentalDistribution(ctx context.Context, filter analytics.StatisticsFilter, metric string, bins int) (analytics.Distribution, error) {
	result, err := store.fakeDistributions.RentalDistribution(ctx, filter, metric, bins)
	result.Buckets = []analytics.HistogramBucket{}
	return result, err
}

type contractDemography struct{ fakeDemography }

func (store contractDemography) Profile(ctx context.Context, id *int64) (demography.Profile, error) {
	result, err := store.fakeDemography.Profile(ctx, id)
	result.Pyramid, result.Migration = []demography.AgeGroup{}, []demography.MigrationYear{}
	return result, err
}

type contractModels struct{ fakeModels }

func (store contractModels) MarketIndices(ctx context.Context, filter analytics.MarketIndexFilter) ([]analytics.MarketIndexPoint, error) {
	items, err := store.fakeModels.MarketIndices(ctx, filter)
	for index := range items {
		items[index].PropertyGroup = "apartment"
	}
	return items, err
}

func (store contractModels) ValuationPrediction(ctx context.Context, kind string, id int64) (analytics.ValuationPrediction, error) {
	result, err := store.fakeModels.ValuationPrediction(ctx, kind, id)
	result.PropertyGroup, result.Reliability, result.Warnings = "apartment", "low", []string{}
	result.Metrics = json.RawMessage(`{}`)
	return result, err
}

type contractConstruction struct{ fakeConstruction }

func (store contractConstruction) Summary(ctx context.Context, filter construction.Filter) (construction.Summary, error) {
	result, err := store.fakeConstruction.Summary(ctx, filter)
	result.PermitsScope = "slovenia"
	return result, err
}

func TestResponsesMatchTheOpenAPIContract(t *testing.T) {
	contract := loadContract(t)
	schemas := newContractSchemas(t, contract)
	handler := contractHandler()

	paths := contract["paths"].(map[string]any)
	for path := range paths {
		if _, ok := contractRequests[path]; !ok {
			t.Errorf("no contract request for documented path %s", path)
		}
	}
	for _, path := range slices.Sorted(maps.Keys(contractRequests)) {
		t.Run(path, func(t *testing.T) {
			response := get(handler, contractRequests[path])
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			schemas.validate(t, path, response)
		})
	}
	for _, item := range contractErrors {
		t.Run("error "+item.request, func(t *testing.T) {
			response := get(handler, item.request)
			if response.Code < 400 {
				t.Fatalf("status=%d, want an error", response.Code)
			}
			schemas.validate(t, item.path, response)
		})
	}
}

func loadContract(t *testing.T) map[string]any {
	t.Helper()
	payload, err := os.ReadFile(contractPath)
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	var document map[string]any
	if err := yaml.Unmarshal(payload, &document); err != nil {
		t.Fatalf("parse contract: %v", err)
	}
	return document
}

type contractSchemas struct {
	document map[string]any
	compiler *jsonschema.Compiler
	compiled map[string]*jsonschema.Schema
}

const contractURL = "file:///openapi.json"

// newContractSchemas prepares the contract for a JSON Schema 2020-12 validator (OpenAPI 3.1
// schemas are 2020-12): `nullable: true`, which the contract still uses in places, becomes a
// "null" type, and every object schema with declared properties rejects undeclared ones, so a
// handler cannot add a field silently. Schemas reused through allOf are closed at the
// composing schema instead (unevaluatedProperties sees the properties of every allOf branch).
func newContractSchemas(t *testing.T, document map[string]any) *contractSchemas {
	t.Helper()
	walk(document, func(node map[string]any) {
		translateNullable(node)
	})
	walk(document, func(node map[string]any) {
		_, hasProperties := node["properties"].(map[string]any)
		_, hasAllOf := node["allOf"]
		_, open := node["additionalProperties"]
		if objectSchema(node) && (hasProperties || hasAllOf) && !open {
			node["unevaluatedProperties"] = false
		}
	})
	// Open the allOf branches again (inline ones and the schemas they reference): the composing
	// schema closes them together.
	schemas := document["components"].(map[string]any)["schemas"].(map[string]any)
	walk(document, func(node map[string]any) {
		branches, ok := node["allOf"].([]any)
		if !ok {
			return
		}
		for _, branch := range branches {
			branch := branch.(map[string]any)
			delete(branch, "unevaluatedProperties")
			if reference, ok := branch["$ref"].(string); ok {
				delete(schemas[strings.TrimPrefix(reference, "#/components/schemas/")].(map[string]any), "unevaluatedProperties")
			}
		}
	})
	// Round-trip through JSON so the validator sees plain JSON values.
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode contract: %v", err)
	}
	resource, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		t.Fatalf("decode contract: %v", err)
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource(contractURL, resource); err != nil {
		t.Fatalf("add contract: %v", err)
	}
	return &contractSchemas{document: document, compiler: compiler, compiled: map[string]*jsonschema.Schema{}}
}

// walk calls visit for every object in value, parents first.
func walk(value any, visit func(map[string]any)) {
	switch typed := value.(type) {
	case map[string]any:
		visit(typed)
		for _, child := range typed {
			walk(child, visit)
		}
	case []any:
		for _, child := range typed {
			walk(child, visit)
		}
	}
}

// objectSchema tells an object schema from a map of property names (which may itself hold
// properties called "type" or "properties", as GeoJSON features do).
func objectSchema(node map[string]any) bool {
	switch kind := node["type"].(type) {
	case nil:
		_, hasType := node["type"]
		return !hasType
	case string:
		return kind == "object"
	case []any:
		return slices.Contains(kind, any("object"))
	}
	return false
}

func translateNullable(node map[string]any) {
	nullable, _ := node["nullable"].(bool)
	if _, ok := node["nullable"]; !ok {
		return
	}
	delete(node, "nullable")
	if !nullable {
		return
	}
	if kind, ok := node["type"].(string); ok {
		node["type"] = []any{kind, "null"}
		if values, ok := node["enum"].([]any); ok {
			node["enum"] = append(values, nil)
		}
		return
	}
	inner := map[string]any{}
	for key, value := range node {
		inner[key] = value
		delete(node, key)
	}
	node["anyOf"] = []any{inner, map[string]any{"type": "null"}}
}

// validate checks a response against the schema documented for its path, status and type.
func (c *contractSchemas) validate(t *testing.T, path string, response *httptest.ResponseRecorder) {
	t.Helper()
	contentType, _, err := mime.ParseMediaType(response.Header().Get("Content-Type"))
	if err != nil {
		t.Fatalf("content type %q: %v", response.Header().Get("Content-Type"), err)
	}
	pointer, err := c.responseSchemaPointer(path, response.Code, contentType)
	if err != nil {
		t.Fatal(err)
	}
	schema, ok := c.compiled[pointer]
	if !ok {
		schema, err = c.compiler.Compile(contractURL + "#" + pointer)
		if err != nil {
			t.Fatalf("compile %s: %v", pointer, err)
		}
		c.compiled[pointer] = schema
	}
	body, err := jsonschema.UnmarshalJSON(bytes.NewReader(response.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode body: %v\n%s", err, response.Body.String())
	}
	if err := schema.Validate(body); err != nil {
		t.Errorf("body does not match %s:\n%v\nbody: %s", pointer, err, truncate(response.Body.String(), 2000))
	}
}

// responseSchemaPointer finds the JSON pointer of the documented schema, following a
// response $ref (components/responses).
func (c *contractSchemas) responseSchemaPointer(path string, status int, contentType string) (string, error) {
	escape := func(segment string) string {
		return strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
	}
	operation, ok := lookup(c.document, "paths", path, "get").(map[string]any)
	if !ok {
		return "", fmt.Errorf("GET %s is not documented", path)
	}
	code := fmt.Sprint(status)
	response, ok := lookup(operation, "responses", code).(map[string]any)
	pointer := "/paths/" + escape(path) + "/get/responses/" + code
	if !ok {
		return "", fmt.Errorf("GET %s does not document status %s", path, code)
	}
	if reference, ok := response["$ref"].(string); ok {
		pointer = strings.TrimPrefix(reference, "#")
		segments := strings.Split(strings.TrimPrefix(pointer, "/"), "/")
		args := make([]string, len(segments))
		copy(args, segments)
		if response, ok = lookup(c.document, args...).(map[string]any); !ok {
			return "", fmt.Errorf("unresolved response %s", reference)
		}
	}
	if lookup(response, "content", contentType, "schema") == nil {
		return "", fmt.Errorf("GET %s status %s does not document %s", path, code, contentType)
	}
	return pointer + "/content/" + escape(contentType) + "/schema", nil
}

func lookup(value any, keys ...string) any {
	for _, key := range keys {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}
