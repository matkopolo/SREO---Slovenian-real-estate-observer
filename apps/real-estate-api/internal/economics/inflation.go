// Package economics serves the SURS consumer-price index (table H281S): annual inflation rates
// and chained monthly price factors. The table is fetched from SURS PxWeb and kept in memory.
package economics

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/memo"
)

const DefaultSURSURL = "https://pxweb.stat.si/SiStatData/api/v1/en/Data/H281S.px"

// ErrSourceUnavailable wraps every failure to obtain the CPI table from SURS.
var ErrSourceUnavailable = errors.New("SURS consumer-price index is unavailable")

const (
	// H281S index selections: 1 is the month-on-previous-month index, 2 the year-on-year index.
	monthOnMonthIndex = "1"
	yearOnYearIndex   = "2"
	// maxResponseBytes bounds a PxWeb answer (the full monthly series is about 20 kB).
	maxResponseBytes = 4 << 20
	cacheFor         = 6 * time.Hour
)

type Point struct {
	Period            string  `json:"period"`
	AnnualRatePercent float64 `json:"annualRatePercent"`
}

type InflationFactor struct {
	From   string  `json:"from"`
	To     string  `json:"to"`
	Factor float64 `json:"factor"`
	Months int     `json:"months"`
	Source string  `json:"source"`
}

type Store interface {
	Inflation(ctx context.Context, from, to time.Time, interval string) ([]Point, error)
	InflationFactor(ctx context.Context, from, to time.Time) (InflationFactor, error)
}

// monthlyIndex maps a month ("2024-01-01") to the published index value.
type monthlyIndex map[string]float64

// Client reads H281S from SURS. Each index is cached for six hours; a failed refresh keeps
// serving the previous table, and requests never wait behind one another's SURS call.
type Client struct {
	url          string
	httpClient   *http.Client
	yearOnYear   *memo.Value[monthlyIndex]
	monthOnMonth *memo.Value[monthlyIndex]
}

func NewClient(httpClient *http.Client, url string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 12 * time.Second}
	}
	if url == "" {
		url = DefaultSURSURL
	}
	client := &Client{url: url, httpClient: httpClient}
	options := memo.Options{TTL: cacheFor, Timeout: 15 * time.Second, RetryAfter: time.Minute}
	client.yearOnYear = memo.New(client.loader(yearOnYearIndex), options)
	client.monthOnMonth = memo.New(client.loader(monthOnMonthIndex), options)
	return client
}

// CacheStats reports the use of the in-memory CPI tables, by table.
func (c *Client) CacheStats() map[string]memo.Stats {
	return map[string]memo.Stats{
		"inflation_year_on_year":   c.yearOnYear.Stats(),
		"inflation_month_on_month": c.monthOnMonth.Stats(),
	}
}

func (c *Client) loader(index string) memo.LoadFunc[monthlyIndex] {
	return func(ctx context.Context, _ monthlyIndex, _ bool) (monthlyIndex, error) {
		values, err := c.fetch(ctx, index)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrSourceUnavailable, err)
		}
		return values, nil
	}
}

// Inflation averages the year-on-year rates of the months from–to per month, quarter or year.
func (c *Client) Inflation(ctx context.Context, from, to time.Time, interval string) ([]Point, error) {
	index, err := c.yearOnYear.Get(ctx)
	if err != nil {
		return nil, err
	}
	groups := map[string][]float64{}
	for month, value := range index {
		period, parseErr := time.Parse("2006-01-02", month)
		if parseErr != nil || period.Before(monthStart(from)) || period.After(monthStart(to)) {
			continue
		}
		key := month
		switch interval {
		case "quarter":
			key = fmt.Sprintf("%04d-%02d-01", period.Year(), ((int(period.Month())-1)/3)*3+1)
		case "year":
			key = fmt.Sprintf("%04d-01-01", period.Year())
		}
		groups[key] = append(groups[key], value-100)
	}
	keys := make([]string, 0, len(groups))
	for key := range groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]Point, 0, len(keys))
	for _, key := range keys {
		var total float64
		for _, value := range groups[key] {
			total += value
		}
		result = append(result, Point{Period: key, AnnualRatePercent: total / float64(len(groups[key]))})
	}
	return result, nil
}

// InflationFactor chains monthly CPI ratios, never overlapping year-on-year rates. Rounded
// published monthly ratios give an approximate adjustment, not a daily price index.
func (c *Client) InflationFactor(ctx context.Context, from, to time.Time) (InflationFactor, error) {
	index, err := c.monthOnMonth.Get(ctx)
	if err != nil {
		return InflationFactor{}, err
	}
	ratios := make(map[string]float64, len(index))
	for month, value := range index {
		if value > 0 {
			ratios[month] = value / 100
		}
	}
	return chainMonthlyRatios(ratios, from, to)
}

type pxResponse struct {
	ID        []string `json:"id"`
	Size      []int    `json:"size"`
	Value     []any    `json:"value"`
	Dimension map[string]struct {
		Category struct {
			Index map[string]int `json:"index"`
		} `json:"category"`
	} `json:"dimension"`
	Dataset *pxResponse `json:"dataset"`
}

// fetch requests every month of one H281S index and returns its numeric values.
func (c *Client) fetch(ctx context.Context, index string) (monthlyIndex, error) {
	body := fmt.Sprintf(`{"query":[{"code":"MESEC","selection":{"filter":"all","values":["*"]}},`+
		`{"code":"INDEKS","selection":{"filter":"item","values":[%q]}}],"response":{"format":"json-stat2"}}`, index)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, bytes.NewBufferString(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request index %s: %w", index, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("request index %s: status %d", index, response.StatusCode)
	}
	var payload pxResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBytes)).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode index %s: %w", index, err)
	}
	return parseIndex(payload)
}

func parseIndex(payload pxResponse) (monthlyIndex, error) {
	if payload.Dataset != nil {
		payload = *payload.Dataset
	}
	months, ok := payload.Dimension["MESEC"]
	if !ok {
		return nil, errors.New("response has no MESEC dimension")
	}
	// The request selects a single index. Reject a differently shaped response rather than
	// accidentally reading another index.
	if len(payload.ID) != 2 || payload.ID[0] != "MESEC" || payload.ID[1] != "INDEKS" ||
		len(payload.Size) != 2 || payload.Size[1] != 1 {
		return nil, errors.New("response has unexpected dimensions")
	}
	values := monthlyIndex{}
	for month, position := range months.Category.Index {
		if position < 0 || position >= len(payload.Value) || !strings.Contains(month, "M") {
			continue
		}
		if value, ok := payload.Value[position].(float64); ok {
			values[strings.Replace(month, "M", "-", 1)+"-01"] = value
		}
	}
	if len(values) == 0 {
		return nil, errors.New("response has no values")
	}
	return values, nil
}

func monthStart(value time.Time) time.Time {
	return time.Date(value.Year(), value.Month(), 1, 0, 0, 0, 0, time.UTC)
}
