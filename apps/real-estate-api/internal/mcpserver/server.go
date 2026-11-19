package mcpserver

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

//go:embed about.md
var aboutText string

// Options configure the service.
type Options struct {
	// DocsDir holds the documentation files served as resources (methodology, licensing); the
	// embedded "about" text is always served.
	DocsDir string
	// SiteURL is the public site, used in the links the answers carry.
	SiteURL string
	// Logger receives the SDK's server log; nil disables it.
	Logger *slog.Logger
}

const (
	serverName    = "sreo"
	serverVersion = "1.0.0"
	// keepAlive is the ping interval that detects clients which went away without closing
	// their session.
	keepAlive = 30 * time.Second
	// listTTL is how long the area lists and the data status are kept in memory.
	listTTL = 10 * time.Minute
	// maxAreas bounds one find_areas answer.
	maxAreas = 25
	// defaultSearchLimit and maxSearchLimit bound search_addresses (the API serves at most 20).
	defaultSearchLimit = 10
	maxSearchLimit     = 20
	// minSearchQuery is the shortest address text the API searches for.
	minSearchQuery = 3
	// defaultRecentLimit and maxRecentLimit bound recent_sales.
	defaultRecentLimit = 20
	maxRecentLimit     = 100
	maxRecentOffset    = 100000
	// maxFloodPolygons bounds the geometry one flood_zones answer carries.
	maxFloodPolygons = 200
	// maxFloodSpan is the widest view the API serves, in degrees on either axis.
	maxFloodSpan = 0.26
	// maxIncome is the highest monthly net income the affordability model accepts.
	maxIncome = 100000
	// defaultTrendYears is the period price_trend covers when none is given.
	defaultTrendYears = 10
	dateLayout        = "2006-01-02"
)

var (
	geographyLevels = []string{"statistical_region", "municipality", "city_district", "local_community", "settlement"}
	propertyGroups  = []string{"apartment", "house", "land", "commercial", "garage"}
	rentGroups      = []string{"apartment", "house", "commercial", "garage", "room"}
	allGroups       = []string{"apartment", "house", "land", "commercial", "garage", "room"}
	homeGroups      = []string{"apartment", "house"}
	intervals       = []string{"month", "quarter", "year"}
	metrics         = []string{"pricePerSqm", "price"}
	kinds           = []string{"sale", "rent"}
	// buildingNumberPattern is a building number of the cadastre: digits only, so the value
	// can never change the API path it is placed in.
	buildingNumberPattern = regexp.MustCompile(`^[0-9]+$`)
)

// docResources are the documentation files served from DocsDir, by resource name.
var docResources = []struct{ name, title, file, description string }{
	{"methodology", "Statistical methodology", "statistical-methodology.md", "How the statistics, indices, outlier rules, models and the current-market estimate are computed, with measured accuracy."},
	{"licensing", "Data licensing and privacy", "data-licensing-privacy.md", "Data sources, licences, attribution requirements and what is deliberately not held."},
	{"api", "HTTP API", "real-estate-api.md", "The read-only HTTP API behind these tools: endpoint groups and the statistical contract."},
	{"property-history", "Property history", "property-history.md", "How resales of one property are matched and what the history can and cannot prove."},
}

// docResource is a documentation file found in DocsDir at start-up.
type docResource struct {
	uri, name, title, path, description string
	size                                int64
}

// Service holds what every session shares: the API client, the two small caches, the tool
// schemas and the documents found on disk. One Service serves any number of sessions.
type Service struct {
	client  *Client
	siteURL string
	logger  *slog.Logger
	status  *memo.Value[Answer]
	areas   map[string]*memo.Value[[]Answer]
	schemas *mcp.SchemaCache
	tools   []toolSpec
	docs    []docResource
}

// toolSpec is one tool's definition; the input schema is built once and shared by every session.
type toolSpec struct {
	name, title, description string
	input                    *jsonschema.Schema
	add                      func(*mcp.Server, *mcp.Tool)
}

// NewService returns the service that exposes the SREO API through client.
func NewService(client *Client, options Options) *Service {
	s := &Service{client: client, siteURL: strings.TrimRight(options.SiteURL, "/"), logger: options.Logger,
		areas: map[string]*memo.Value[[]Answer]{}, schemas: mcp.NewSchemaCache()}
	s.status = memo.New(func(ctx context.Context, _ Answer, _ bool) (Answer, error) {
		return client.getAnswer(ctx, "/api/v1/data-status", nil)
	}, memo.Options{TTL: listTTL})
	for _, level := range geographyLevels {
		s.areas[level] = memo.New(func(ctx context.Context, _ []Answer, _ bool) ([]Answer, error) {
			var listed struct {
				Items []Answer `json:"items"`
			}
			if err := client.get(ctx, "/api/v1/geographies", query{"level": level}, &listed); err != nil {
				return nil, err
			}
			return listed.Items, nil
		}, memo.Options{TTL: listTTL})
	}
	s.tools = s.toolSpecs()
	s.docs = findDocs(options.DocsDir)
	return s
}

// Server returns a new MCP server for one session; it is cheap, everything heavy is shared.
func (s *Service) Server() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: serverName, Title: "SREO, Slovenian Real Estate Observer", Version: serverVersion,
		WebsiteURL: s.siteURL}, &mcp.ServerOptions{Instructions: instructions, Logger: s.logger, KeepAlive: keepAlive, SchemaCache: s.schemas})
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, OpenWorldHint: new(bool)}
	for _, spec := range s.tools {
		spec.add(server, &mcp.Tool{Name: spec.name, Title: spec.title, Description: spec.description, InputSchema: spec.input, Annotations: readOnly})
	}
	s.addResources(server)
	return server
}

const instructions = `SREO answers questions about the Slovenian property market from actual concluded sales and
rentals (GURS ETN), not advertisements. Start with find_areas to turn a place name into an area id, or
search_addresses to find a building; then use market_overview, price_trend, recent_sales or sale. All
tools are read-only. Every answer carries a "source" notice that must be shown with the data (CC BY 4.0).
Medians are published only from 30 agreements; the current-market estimate is not an official valuation
and the GURS generalised value is an administrative value, not a price. Register names are Slovene.`

// ---------------------------------------------------------------- tools

type findAreasInput struct {
	Query string `json:"query" jsonschema:"part of the area's name, e.g. Ruše, Bežigrad or Gorenjska"`
	Level string `json:"level,omitempty" jsonschema:"restrict to one level; every level when empty"`
}

type searchAddressesInput struct {
	Query string `json:"query" jsonschema:"street and house number, settlement or municipality, e.g. Hmeljarska ulica 8 Ruše (at least 3 characters)"`
	Limit int    `json:"limit,omitempty" jsonschema:"at most this many buildings (default 10, max 20)"`
}

type buildingInput struct {
	CadastralCode  int    `json:"cadastralCode" jsonschema:"cadastral municipality code (šifra katastrske občine), e.g. 665"`
	BuildingNumber string `json:"buildingNumber" jsonschema:"building number within the cadastral municipality, digits only, e.g. 2257"`
	PropertyGroup  string `json:"propertyGroup,omitempty" jsonschema:"only agreements of this property type; all when empty"`
}

type transactionInput struct {
	TransactionID int64 `json:"transactionId" jsonschema:"the sale's numeric id as returned by recent_sales, building or search_addresses"`
	// IncludeContext adds the comparables, benchmarks and the current-market estimate.
	IncludeContext bool `json:"includeContext,omitempty" jsonschema:"also return the price context: benchmarks, comparable sales and the current-market estimate"`
}

type rentalInput struct {
	TransactionID int64 `json:"transactionId" jsonschema:"the rental's numeric id"`
}

type marketInput struct {
	GeographyID   int64  `json:"geographyId,omitempty" jsonschema:"area id from find_areas; Slovenia when empty"`
	PropertyGroup string `json:"propertyGroup,omitempty" jsonschema:"property type (default apartment)"`
	From          string `json:"from,omitempty" jsonschema:"start date YYYY-MM-DD; default: the last 12 months the data covers, or the 12 months to 'to'"`
	To            string `json:"to,omitempty" jsonschema:"end date YYYY-MM-DD; default: the end of the published data, or 12 months after 'from'"`
	MinArea       int    `json:"minArea,omitempty" jsonschema:"smallest floor area in m²"`
	MaxArea       int    `json:"maxArea,omitempty" jsonschema:"largest floor area in m²"`
}

type trendInput struct {
	marketInput
	Interval string `json:"interval,omitempty" jsonschema:"month, quarter or year (default year); without dates the period is the last ten years"`
}

type distributionInput struct {
	marketInput
	Metric string `json:"metric,omitempty" jsonschema:"pricePerSqm (default) or price"`
}

type recentInput struct {
	GeographyID     int64  `json:"geographyId,omitempty" jsonschema:"area id from find_areas; Slovenia when empty"`
	PropertyGroup   string `json:"propertyGroup,omitempty" jsonschema:"only this property type (room only for rentals); all when empty"`
	TransactionKind string `json:"transactionKind,omitempty" jsonschema:"sale (default) or rent"`
	Street          string `json:"street,omitempty" jsonschema:"only agreements on this street (name as in the register)"`
	Limit           int    `json:"limit,omitempty" jsonschema:"at most this many agreements (default 20, max 100)"`
	Offset          int    `json:"offset,omitempty" jsonschema:"skip this many agreements, for paging"`
	From            string `json:"from,omitempty" jsonschema:"start date YYYY-MM-DD; default: the last 12 months the data covers (rentals: the last reported calendar year)"`
	To              string `json:"to,omitempty" jsonschema:"end date YYYY-MM-DD"`
}

type affordabilityInput struct {
	GeographyID      int64   `json:"geographyId,omitempty" jsonschema:"municipality or region id; Slovenia when empty"`
	PropertyGroup    string  `json:"propertyGroup,omitempty" jsonschema:"apartment (default) or house"`
	NetIncome        float64 `json:"netIncome,omitempty" jsonschema:"the household's monthly net income in €; the median wage when empty"`
	CoBorrowerIncome float64 `json:"coBorrowerIncome,omitempty" jsonschema:"a second borrower's monthly net income in €"`
}

type municipalitiesInput struct {
	PropertyGroup string `json:"propertyGroup,omitempty" jsonschema:"apartment (default) or house"`
}

type indexInput struct {
	PropertyGroup   string `json:"propertyGroup,omitempty" jsonschema:"property type (default apartment)"`
	TransactionKind string `json:"transactionKind,omitempty" jsonschema:"sale (default) or rent"`
}

type demographicsInput struct {
	GeographyID int64 `json:"geographyId,omitempty" jsonschema:"municipality or statistical region id; Slovenia when empty"`
}

type floodInput struct {
	West            float64 `json:"west" jsonschema:"western longitude of the view, WGS84"`
	South           float64 `json:"south" jsonschema:"southern latitude"`
	East            float64 `json:"east" jsonschema:"eastern longitude"`
	North           float64 `json:"north" jsonschema:"northern latitude; the view may span at most 0.26° on either axis"`
	IncludeGeometry bool    `json:"includeGeometry,omitempty" jsonschema:"return up to 200 polygons as GeoJSON as well as the summary (large)"`
}

type noInput struct{}

// toolSpecs lists the tools with their titles, descriptions and input schemas.
func (s *Service) toolSpecs() []toolSpec {
	return []toolSpec{
		spec("find_areas", "Find areas", "Find official areas (statistical regions, municipalities, city districts, local communities, settlements) by name and get their ids for the other tools.",
			schemaFor[findAreasInput](enum("level", geographyLevels...)), s.findAreas),
		spec("search_addresses", "Search addresses", "Find buildings by address text; returns the cadastral key of each building with its sale and rental counts.",
			schemaFor[searchAddressesInput](minLength("query", minSearchQuery), bounds("limit", 1, maxSearchLimit)), s.searchAddresses),
		spec("building", "Building history", "Sales and rentals recorded in one building: construction year, medians per m², yearly history and every agreement with its id.",
			schemaFor[buildingInput](bounds("cadastralCode", 1, 0), pattern("buildingNumber", buildingNumberPattern.String()), enum("propertyGroup", propertyGroups...)), s.building),
		spec("sale", "Sale details", "One recorded sale: price, area, parts of buildings and parcels, data quality, and the register facts about the building (energy certificate, cadastre, GURS generalised value, flood class). With includeContext also the benchmarks, comparable sales and the current-market estimate.",
			schemaFor[transactionInput](bounds("transactionId", 1, 0)), s.sale),
		spec("rental", "Rental details", "One recorded rental agreement: rent, area, term and the rented spaces.",
			schemaFor[rentalInput](bounds("transactionId", 1, 0)), s.rental),
		spec("market_overview", "Market overview", "Sale statistics for an area, period and property type (median and middle half of € per m², counts, publishability) with the rental overview of the same type.",
			schemaFor[marketInput](marketSchema(propertyGroups)...), s.marketOverview),
		spec("price_trend", "Price trend", "Median price per m² and sale counts over time for an area and property type.",
			schemaFor[trendInput](append(marketSchema(propertyGroups), enum("interval", intervals...))...), s.priceTrend),
		spec("price_distribution", "Price distribution", "Histogram of sale prices per m² (or total prices) for an area, period and property type.",
			schemaFor[distributionInput](append(marketSchema(propertyGroups), enum("metric", metrics...))...), s.priceDistribution),
		spec("recent_sales", "Recent agreements", "The latest recorded sales or rentals in an area, with ids, addresses, prices and areas; pageable.",
			schemaFor[recentInput](bounds("geographyId", 1, 0), enum("propertyGroup", allGroups...), enum("transactionKind", kinds...),
				bounds("limit", 1, maxRecentLimit), bounds("offset", 0, maxRecentOffset), date("from"), date("to")), s.recentSales),
		spec("affordability", "Affordability", "What a household can afford in an area: Banka Slovenije lending limits applied to the median flat price, with the given or median net income.",
			schemaFor[affordabilityInput](bounds("geographyId", 1, 0), enum("propertyGroup", homeGroups...), bounds("netIncome", 0, maxIncome), bounds("coBorrowerIncome", 0, maxIncome)), s.affordability),
		spec("municipality_affordability", "Municipal affordability ranking", "Every municipality's median price per m² and years of median net salary for a typical home, for ranking and comparison.",
			schemaFor[municipalitiesInput](enum("propertyGroup", homeGroups...)), s.municipalityAffordability),
		spec("price_index", "Price index", "The national hedonic price index of a property type by month.",
			schemaFor[indexInput](enum("propertyGroup", allGroups...), enum("transactionKind", kinds...)), s.priceIndex),
		spec("demographics", "Demographics", "SURS population, migration and housing context of an area (not a price forecast).",
			schemaFor[demographicsInput](bounds("geographyId", 1, 0)), s.demographics),
		spec("property_history", "Property history", "Earlier recorded sales of the same property as the given sale, with price changes and inflation.",
			schemaFor[rentalInput](bounds("transactionId", 1, 0)), s.propertyHistory),
		spec("flood_zones", "Flood zones", "DRSV flood hazard classes inside a small map view (at most 0.26° on either axis): which classes are present and whether a hydraulic study covers part of it; optionally the polygons.",
			schemaFor[floodInput](), s.floodZones),
		spec("data_status", "Data status", "Which analytical release is live, the dates the statistics run to, the default periods, and whether a refresh is pending.",
			schemaFor[noInput](), s.dataStatus),
	}
}

// spec pairs a tool definition with its typed handler.
func spec[In any](name, title, description string, input *jsonschema.Schema, handler mcp.ToolHandlerFor[In, Answer]) toolSpec {
	return toolSpec{name: name, title: title, description: description, input: input,
		add: func(server *mcp.Server, tool *mcp.Tool) { mcp.AddTool(server, tool, handler) }}
}

// marketSchema are the constraints shared by the statistics tools.
func marketSchema(groups []string) []schemaRule {
	return []schemaRule{bounds("geographyId", 1, 0), enum("propertyGroup", groups...), date("from"), date("to"),
		bounds("minArea", 1, 1000000), bounds("maxArea", 1, 1000000)}
}

// answer attaches the source notice and the site link to an API answer.
func (s *Service) answer(body Answer, link string) Answer {
	if body == nil {
		body = Answer{}
	}
	body["source"] = Attribution
	if link != "" && s.siteURL != "" {
		body["link"] = s.siteURL + "/" + strings.TrimLeft(link, "/")
	}
	return body
}

func (s *Service) findAreas(ctx context.Context, _ *mcp.CallToolRequest, input findAreasInput) (*mcp.CallToolResult, Answer, error) {
	wanted := fold(input.Query)
	if wanted == "" {
		return nil, nil, errors.New("query must not be empty")
	}
	levels := geographyLevels
	if input.Level != "" {
		if !contains(geographyLevels, input.Level) {
			return nil, nil, fmt.Errorf("level must be one of %s", strings.Join(geographyLevels, ", "))
		}
		levels = []string{input.Level}
	}
	var found []Answer
	for _, level := range levels {
		items, err := s.areas[level].Get(ctx)
		if err != nil {
			return nil, nil, err
		}
		for _, item := range items {
			name, _ := item["name"].(string)
			if strings.Contains(fold(name), wanted) {
				found = append(found, item)
			}
		}
	}
	// Exact names first, then shorter names, so "Ljubljana" lists the municipality before its streets' settlements.
	sort.SliceStable(found, func(i, j int) bool {
		a, _ := found[i]["name"].(string)
		b, _ := found[j]["name"].(string)
		exactA, exactB := fold(a) == wanted, fold(b) == wanted
		if exactA != exactB {
			return exactA
		}
		return utf8.RuneCountInString(a) < utf8.RuneCountInString(b)
	})
	total := len(found)
	body := Answer{"total": total}
	if len(found) > maxAreas {
		found = found[:maxAreas]
		body["hint"] = fmt.Sprintf("%d areas match and only %d are listed; use a longer name or set level", total, maxAreas)
	}
	if found == nil {
		found = []Answer{}
	}
	body["items"], body["count"] = found, len(found)
	return nil, s.answer(body, ""), nil
}

func (s *Service) searchAddresses(ctx context.Context, _ *mcp.CallToolRequest, input searchAddressesInput) (*mcp.CallToolResult, Answer, error) {
	text := strings.TrimSpace(input.Query)
	if utf8.RuneCountInString(text) < minSearchQuery {
		return nil, nil, fmt.Errorf("query must have at least %d characters", minSearchQuery)
	}
	limit := input.Limit
	if limit <= 0 {
		limit = defaultSearchLimit
	}
	if limit > maxSearchLimit {
		return nil, nil, fmt.Errorf("limit must be at most %d", maxSearchLimit)
	}
	body, err := s.client.getAnswer(ctx, "/api/v1/buildings/search", query{"q": text, "limit": strconv.Itoa(limit)})
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, ""), nil
}

func (s *Service) building(ctx context.Context, _ *mcp.CallToolRequest, input buildingInput) (*mcp.CallToolResult, Answer, error) {
	if input.CadastralCode <= 0 {
		return nil, nil, errors.New("cadastralCode must be a positive cadastral municipality code, e.g. 665")
	}
	if !buildingNumberPattern.MatchString(input.BuildingNumber) {
		return nil, nil, errors.New("buildingNumber must be the building's number within the cadastral municipality, digits only, e.g. 2257")
	}
	if input.PropertyGroup != "" && !contains(propertyGroups, input.PropertyGroup) {
		return nil, nil, fmt.Errorf("propertyGroup must be one of %s", strings.Join(propertyGroups, ", "))
	}
	path := fmt.Sprintf("/api/v1/buildings/%d/%s/statistics", input.CadastralCode, input.BuildingNumber)
	body, err := s.client.getAnswer(ctx, path, query{"propertyGroup": input.PropertyGroup})
	if err != nil {
		if isNotFound(err) {
			return nil, nil, fmt.Errorf("no recorded agreements for building %d-%s", input.CadastralCode, input.BuildingNumber)
		}
		return nil, nil, err
	}
	return nil, s.answer(body, fmt.Sprintf("#?b=%d-%s", input.CadastralCode, input.BuildingNumber)), nil
}

func (s *Service) sale(ctx context.Context, _ *mcp.CallToolRequest, input transactionInput) (*mcp.CallToolResult, Answer, error) {
	if input.TransactionID <= 0 {
		return nil, nil, errors.New("transactionId is required")
	}
	id := strconv.FormatInt(input.TransactionID, 10)
	body, err := s.client.getAnswer(ctx, "/api/v1/sales/transactions/"+id, nil)
	if err != nil {
		if isNotFound(err) {
			return nil, nil, fmt.Errorf("sale %s is not in the published data", id)
		}
		return nil, nil, err
	}
	if input.IncludeContext {
		context, err := s.client.getAnswer(ctx, "/api/v1/sales/transactions/"+id+"/context", nil)
		if err != nil && !isNotFound(err) {
			return nil, nil, err
		}
		if context != nil {
			body["context"] = context
		}
	}
	return nil, s.answer(body, "#?posel="+id), nil
}

func (s *Service) rental(ctx context.Context, _ *mcp.CallToolRequest, input rentalInput) (*mcp.CallToolResult, Answer, error) {
	if input.TransactionID <= 0 {
		return nil, nil, errors.New("transactionId is required")
	}
	id := strconv.FormatInt(input.TransactionID, 10)
	body, err := s.client.getAnswer(ctx, "/api/v1/rentals/transactions/"+id, nil)
	if err != nil {
		if isNotFound(err) {
			return nil, nil, fmt.Errorf("rental %s is not in the published data", id)
		}
		return nil, nil, err
	}
	return nil, s.answer(body, "#?najem="+id), nil
}

// segment turns the shared market input into the API's statistics query; a missing period
// bound is derived from the other one or from the published data (see period).
func (s *Service) segment(ctx context.Context, input marketInput, groups []string, years int) (query, error) {
	group := input.PropertyGroup
	if group == "" {
		group = "apartment"
	}
	if !contains(groups, group) {
		return nil, fmt.Errorf("propertyGroup must be one of %s", strings.Join(groups, ", "))
	}
	if input.MinArea > 0 && input.MaxArea > 0 && input.MinArea > input.MaxArea {
		return nil, errors.New("minArea must not be larger than maxArea")
	}
	window, err := s.period(ctx, input.From, input.To, years, s.defaultWindow)
	if err != nil {
		return nil, err
	}
	return query{"geographyId": positive64(input.GeographyID), "propertyGroup": group, "from": window.from, "to": window.to,
		"minArea": positive(input.MinArea), "maxArea": positive(input.MaxArea)}, nil
}

func (s *Service) marketOverview(ctx context.Context, _ *mcp.CallToolRequest, input marketInput) (*mcp.CallToolResult, Answer, error) {
	params, err := s.segment(ctx, input, propertyGroups, 1)
	if err != nil {
		return nil, nil, err
	}
	sales, err := s.client.getAnswer(ctx, "/api/v1/statistics/overview", params)
	if err != nil {
		return nil, nil, err
	}
	body := Answer{"period": Answer{"from": params["from"], "to": params["to"]}, "propertyGroup": params["propertyGroup"], "sales": sales}
	if contains(rentGroups, params["propertyGroup"]) {
		rents, rentWindow, err := s.rentalOverview(ctx, params)
		if err != nil {
			body["rentalsUnavailable"] = "the rental overview could not be loaded: " + err.Error()
		} else {
			body["rentals"] = rents
			body["rentalPeriod"] = Answer{"from": rentWindow.from, "to": rentWindow.to}
		}
	}
	return nil, s.answer(body, areaLink(input.GeographyID)), nil
}

// rentalOverview is the rental statistics of the same segment over the site's rental year.
func (s *Service) rentalOverview(ctx context.Context, params query) (Answer, window, error) {
	rentWindow, err := s.rentWindow(ctx)
	if err != nil {
		return nil, window{}, err
	}
	rentParams := query{"geographyId": params["geographyId"], "propertyGroup": params["propertyGroup"], "from": rentWindow.from, "to": rentWindow.to,
		"minArea": params["minArea"], "maxArea": params["maxArea"]}
	rents, err := s.client.getAnswer(ctx, "/api/v1/rentals/statistics/overview", rentParams)
	if err != nil {
		return nil, window{}, err
	}
	return rents, rentWindow, nil
}

func (s *Service) priceTrend(ctx context.Context, _ *mcp.CallToolRequest, input trendInput) (*mcp.CallToolResult, Answer, error) {
	interval := input.Interval
	if interval == "" {
		interval = "year"
	}
	if !contains(intervals, interval) {
		return nil, nil, errors.New("interval must be month, quarter or year")
	}
	params, err := s.segment(ctx, input.marketInput, propertyGroups, defaultTrendYears)
	if err != nil {
		return nil, nil, err
	}
	params["interval"] = interval
	body, err := s.client.getAnswer(ctx, "/api/v1/statistics/timeseries", params)
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, areaLink(input.GeographyID)), nil
}

func (s *Service) priceDistribution(ctx context.Context, _ *mcp.CallToolRequest, input distributionInput) (*mcp.CallToolResult, Answer, error) {
	metric := input.Metric
	if metric == "" {
		metric = "pricePerSqm"
	}
	if !contains(metrics, metric) {
		return nil, nil, errors.New("metric must be pricePerSqm or price")
	}
	params, err := s.segment(ctx, input.marketInput, propertyGroups, 1)
	if err != nil {
		return nil, nil, err
	}
	params["metric"] = metric
	body, err := s.client.getAnswer(ctx, "/api/v1/statistics/distribution", params)
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, areaLink(input.GeographyID)), nil
}

func (s *Service) recentSales(ctx context.Context, _ *mcp.CallToolRequest, input recentInput) (*mcp.CallToolResult, Answer, error) {
	kind := input.TransactionKind
	if kind == "" {
		kind = "sale"
	}
	if !contains(kinds, kind) {
		return nil, nil, errors.New("transactionKind must be sale or rent")
	}
	groups, defaults := propertyGroups, s.defaultWindow
	if kind == "rent" {
		groups, defaults = rentGroups, s.rentWindow
	}
	if input.PropertyGroup != "" && !contains(groups, input.PropertyGroup) {
		return nil, nil, fmt.Errorf("propertyGroup must be one of %s", strings.Join(groups, ", "))
	}
	limit := input.Limit
	if limit <= 0 {
		limit = defaultRecentLimit
	}
	if limit > maxRecentLimit {
		return nil, nil, fmt.Errorf("limit must be at most %d", maxRecentLimit)
	}
	if input.Offset < 0 || input.Offset > maxRecentOffset {
		return nil, nil, fmt.Errorf("offset must be between 0 and %d", maxRecentOffset)
	}
	window, err := s.period(ctx, input.From, input.To, 1, defaults)
	if err != nil {
		return nil, nil, err
	}
	params := query{"transactionKind": kind, "geographyId": positive64(input.GeographyID), "propertyGroup": input.PropertyGroup,
		"street": strings.TrimSpace(input.Street), "limit": strconv.Itoa(limit), "offset": positive(input.Offset), "from": window.from, "to": window.to}
	body, err := s.client.getAnswer(ctx, "/api/v1/transactions/recent", params)
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, areaLink(input.GeographyID)), nil
}

func (s *Service) affordability(ctx context.Context, _ *mcp.CallToolRequest, input affordabilityInput) (*mcp.CallToolResult, Answer, error) {
	if input.PropertyGroup != "" && !contains(homeGroups, input.PropertyGroup) {
		return nil, nil, errors.New("propertyGroup must be apartment or house")
	}
	if input.NetIncome > maxIncome || input.CoBorrowerIncome > maxIncome {
		return nil, nil, fmt.Errorf("incomes are monthly net amounts in € of at most %d", maxIncome)
	}
	params := query{"geographyId": positive64(input.GeographyID), "propertyGroup": input.PropertyGroup,
		"netIncome": positiveFloat(input.NetIncome), "coBorrowerIncome": positiveFloat(input.CoBorrowerIncome)}
	body, err := s.client.getAnswer(ctx, "/api/v1/affordability", params)
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, "#pregled-trga"), nil
}

func (s *Service) municipalityAffordability(ctx context.Context, _ *mcp.CallToolRequest, input municipalitiesInput) (*mcp.CallToolResult, Answer, error) {
	if input.PropertyGroup != "" && !contains(homeGroups, input.PropertyGroup) {
		return nil, nil, errors.New("propertyGroup must be apartment or house")
	}
	body, err := s.client.getAnswer(ctx, "/api/v1/affordability/municipalities", query{"propertyGroup": input.PropertyGroup})
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, "#pregled-trga"), nil
}

func (s *Service) priceIndex(ctx context.Context, _ *mcp.CallToolRequest, input indexInput) (*mcp.CallToolResult, Answer, error) {
	group := input.PropertyGroup
	if group == "" {
		group = "apartment"
	}
	kind := input.TransactionKind
	if kind == "" {
		kind = "sale"
	}
	if !contains(kinds, kind) {
		return nil, nil, errors.New("transactionKind must be sale or rent")
	}
	groups := propertyGroups
	if kind == "rent" {
		groups = rentGroups
	}
	if !contains(groups, group) {
		return nil, nil, fmt.Errorf("propertyGroup must be one of %s", strings.Join(groups, ", "))
	}
	body, err := s.client.getAnswer(ctx, "/api/v1/indices", query{"transactionKind": kind, "propertyGroup": group, "method": "hedonic"})
	if err != nil {
		return nil, nil, err
	}
	if items, _ := body["items"].([]any); len(items) == 0 {
		body["note"] = fmt.Sprintf("no hedonic %s index is published for %s", kind, group)
	}
	return nil, s.answer(body, "#trendi"), nil
}

func (s *Service) demographics(ctx context.Context, _ *mcp.CallToolRequest, input demographicsInput) (*mcp.CallToolResult, Answer, error) {
	body, err := s.client.getAnswer(ctx, "/api/v1/demographics", query{"geographyId": positive64(input.GeographyID)})
	if err != nil {
		return nil, nil, err
	}
	return nil, s.answer(body, areaLink(input.GeographyID)), nil
}

func (s *Service) propertyHistory(ctx context.Context, _ *mcp.CallToolRequest, input rentalInput) (*mcp.CallToolResult, Answer, error) {
	if input.TransactionID <= 0 {
		return nil, nil, errors.New("transactionId is required")
	}
	id := strconv.FormatInt(input.TransactionID, 10)
	body, err := s.client.getAnswer(ctx, "/api/v1/sales/transactions/"+id+"/history", nil)
	if err != nil {
		if isNotFound(err) {
			return nil, nil, fmt.Errorf("sale %s is not in the published data", id)
		}
		return nil, nil, err
	}
	return nil, s.answer(body, "#?posel="+id), nil
}

// floodZones summarises the overlay: the classes present and whether a study covers part of
// the view are what an agent usually needs; the polygons are returned only on request, capped.
func (s *Service) floodZones(ctx context.Context, _ *mcp.CallToolRequest, input floodInput) (*mcp.CallToolResult, Answer, error) {
	if input.West >= input.East || input.South >= input.North {
		return nil, nil, errors.New("west must be less than east and south less than north")
	}
	if input.East-input.West > maxFloodSpan || input.North-input.South > maxFloodSpan {
		return nil, nil, fmt.Errorf("the view may span at most %.2f° on either axis", maxFloodSpan)
	}
	bbox := fmt.Sprintf("%.5f,%.5f,%.5f,%.5f", input.West, input.South, input.East, input.North)
	var collection struct {
		Features []struct {
			Properties struct {
				Kind        string  `json:"kind"`
				HazardClass *string `json:"hazardClass"`
			} `json:"properties"`
			Geometry any `json:"geometry"`
		} `json:"features"`
		Truncated bool `json:"truncated"`
	}
	if err := s.client.get(ctx, "/api/v1/hazards/floods", query{"bbox": bbox, "detail": "low"}, &collection); err != nil {
		return nil, nil, err
	}
	classes := map[string]int{}
	studies := 0
	polygons := []Answer{}
	for _, feature := range collection.Features {
		if feature.Properties.Kind == "study" {
			studies++
		} else if feature.Properties.HazardClass != nil {
			classes[*feature.Properties.HazardClass]++
		}
		if input.IncludeGeometry && len(polygons) < maxFloodPolygons {
			polygons = append(polygons, Answer{"kind": feature.Properties.Kind, "hazardClass": feature.Properties.HazardClass, "geometry": feature.Geometry})
		}
	}
	body := Answer{"bbox": bbox, "classes": classes, "classMeaning": Answer{"Pv": "velika (depth over 1.5 m in a 100-year flood)",
		"Ps": "srednja (0.5 to 1.5 m, or flooding every 10 years)", "Pm": "majhna (up to 0.5 m)", "Pp": "preostala (between the 100- and 500-year floods)"},
		"studyAreas": studies, "hasStudiedArea": studies > 0 || len(classes) > 0,
		"note": "hasStudiedArea means a DRSV hydraulic study covers at least part of the view, not all of it. Classes exist only inside " +
			"studied areas; a missing class means not studied, never safe. Ask sale for the flood class of one building.",
		"countsPartial": collection.Truncated}
	if input.IncludeGeometry {
		body["polygons"] = polygons
		body["polygonsTruncated"] = collection.Truncated || len(collection.Features) > maxFloodPolygons
	}
	return nil, s.answer(body, ""), nil
}

func (s *Service) dataStatus(ctx context.Context, _ *mcp.CallToolRequest, _ noInput) (*mcp.CallToolResult, Answer, error) {
	status, err := s.status.Get(ctx)
	if err != nil {
		return nil, nil, err
	}
	body := Answer{}
	for key, value := range status {
		body[key] = value
	}
	if meta, err := s.client.getAnswer(ctx, "/api/v1/meta", nil); err == nil {
		body["api"] = meta
	}
	if window, err := s.defaultWindow(ctx); err == nil {
		body["defaultSalesPeriod"] = Answer{"from": window.from, "to": window.to}
	}
	if window, err := s.rentWindow(ctx); err == nil {
		body["defaultRentalPeriod"] = Answer{"from": window.from, "to": window.to}
	}
	return nil, s.answer(body, "#o-podatkih"), nil
}

// ---------------------------------------------------------------- periods

type window struct{ from, to string }

// period resolves a tool's from/to. Both given: as they are. Neither: the default window
// (years long for the trend). One: the other bound is years before or after it, never past
// the end of the published data.
func (s *Service) period(ctx context.Context, from, to string, years int, defaults func(context.Context) (window, error)) (window, error) {
	if from != "" && to != "" {
		return checkWindow(from, to)
	}
	base, err := defaults(ctx)
	if err != nil {
		return window{}, err
	}
	end, _ := time.Parse(dateLayout, base.to)
	switch {
	case from == "" && to == "":
		if years > 1 {
			base.from = end.AddDate(-years, 0, 1).Format(dateLayout)
		}
		return base, nil
	case to == "":
		start, err := time.Parse(dateLayout, from)
		if err != nil {
			return window{}, errors.New("from must be a date YYYY-MM-DD")
		}
		if start.After(end) {
			return window{}, fmt.Errorf("from is after %s, the end of the published statistics", base.to)
		}
		return checkWindow(from, minDate(start.AddDate(years, 0, -1), end).Format(dateLayout))
	default:
		finish, err := time.Parse(dateLayout, to)
		if err != nil {
			return window{}, errors.New("to must be a date YYYY-MM-DD")
		}
		return checkWindow(finish.AddDate(-years, 0, 1).Format(dateLayout), to)
	}
}

// checkWindow validates both bounds and their order.
func checkWindow(from, to string) (window, error) {
	start, err := time.Parse(dateLayout, from)
	if err != nil {
		return window{}, errors.New("from must be a date YYYY-MM-DD")
	}
	end, err := time.Parse(dateLayout, to)
	if err != nil {
		return window{}, errors.New("to must be a date YYYY-MM-DD")
	}
	if start.After(end) {
		return window{}, fmt.Errorf("from (%s) must not be after to (%s)", from, to)
	}
	return window{from: from, to: to}, nil
}

func minDate(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

// cutoff is the last day the published sale statistics run to.
func (s *Service) cutoff(ctx context.Context) (time.Time, error) {
	status, err := s.status.Get(ctx)
	if err != nil {
		return time.Time{}, err
	}
	active, _ := status["activeRelease"].(map[string]any)
	through, _ := active["analyticsSaleThrough"].(string)
	if through == "" {
		return time.Time{}, errors.New("no analytical release is published yet")
	}
	parsed, err := time.Parse(time.RFC3339, through)
	if err != nil {
		if parsed, err = time.Parse(dateLayout, through[:min(len(through), 10)]); err != nil {
			return time.Time{}, fmt.Errorf("unreadable analytics cutoff %q", through)
		}
	}
	return parsed.UTC(), nil
}

// defaultWindow mirrors the site: the twelve months to the end of the last quarter that is at
// least three months behind the cutoff, because GURS records sales with a lag.
func (s *Service) defaultWindow(ctx context.Context) (window, error) {
	cutoff, err := s.cutoff(ctx)
	if err != nil {
		return window{}, err
	}
	return salesWindow(cutoff), nil
}

// salesWindow is the site's "last 12 months" for a cutoff date.
func salesWindow(cutoff time.Time) window {
	lagged := cutoff.AddDate(0, -3, 0)
	quarterStart := time.Date(lagged.Year(), (lagged.Month()-1)/3*3+1, 1, 0, 0, 0, 0, time.UTC)
	end := quarterStart.AddDate(0, 0, -1)
	start := end.AddDate(-1, 0, 1)
	return window{from: start.Format(dateLayout), to: end.Format(dateLayout)}
}

// rentWindow is the site's rental year: the last calendar year mostly reported, since rental
// agreements are recorded up to a year late.
func (s *Service) rentWindow(ctx context.Context) (window, error) {
	cutoff, err := s.cutoff(ctx)
	if err != nil {
		return window{}, err
	}
	year := cutoff.AddDate(0, -9, 0).Year() - 1
	return window{from: fmt.Sprintf("%d-01-01", year), to: fmt.Sprintf("%d-12-31", year)}, nil
}

// ---------------------------------------------------------------- resources

// findDocs lists the documentation files present in docsDir.
func findDocs(docsDir string) []docResource {
	if docsDir == "" {
		return nil
	}
	var docs []docResource
	for _, doc := range docResources {
		path := filepath.Join(docsDir, doc.file)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() {
			continue
		}
		docs = append(docs, docResource{uri: "sreo://docs/" + doc.name, name: doc.name, title: doc.title, path: path,
			description: doc.description, size: info.Size()})
	}
	return docs
}

func (s *Service) addResources(server *mcp.Server) {
	server.AddResource(&mcp.Resource{URI: "sreo://about", Name: "about", Title: "About SREO and how to read the answers",
		MIMEType: "text/markdown", Size: int64(len(aboutText)),
		Description: "What the data is, how areas and ids work, publication thresholds, licence and attribution."},
		func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: "sreo://about", MIMEType: "text/markdown", Text: aboutText}}}, nil
		})
	for _, doc := range s.docs {
		server.AddResource(&mcp.Resource{URI: doc.uri, Name: doc.name, Title: doc.title, MIMEType: "text/markdown", Description: doc.description, Size: doc.size},
			func(context.Context, *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
				text, err := os.ReadFile(doc.path)
				if err != nil {
					return nil, mcp.ResourceNotFoundError(doc.uri)
				}
				return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: doc.uri, MIMEType: "text/markdown", Text: string(text)}}}, nil
			})
	}
}

// ---------------------------------------------------------------- helpers

func areaLink(geographyID int64) string {
	if geographyID > 0 {
		return fmt.Sprintf("#?g=%d", geographyID)
	}
	return "#"
}

func positive(value int) string {
	if value > 0 {
		return strconv.Itoa(value)
	}
	return ""
}

func positive64(value int64) string {
	if value > 0 {
		return strconv.FormatInt(value, 10)
	}
	return ""
}

func positiveFloat(value float64) string {
	if value > 0 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	return ""
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// fold lowercases and strips the Slovene diacritics, so "Ruse" finds "Ruše".
func fold(text string) string {
	replacer := strings.NewReplacer("č", "c", "š", "s", "ž", "z", "ć", "c", "đ", "d")
	return strings.TrimSpace(replacer.Replace(strings.ToLower(text)))
}
