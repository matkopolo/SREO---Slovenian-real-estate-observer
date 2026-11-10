package economics

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestInflationParsesAndAggregatesOfficialShape(t *testing.T) {
	httpClient := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(
			`{"id":["MESEC","INDEKS"],"size":[3,1],"dimension":{"MESEC":{"category":{"index":{"2024M01":0,"2024M02":1,"2024M03":2}}}},"value":[103,104,105]}`,
		))}, nil
	})}
	client := NewClient(httpClient, "https://example.test/inflation")
	from, _ := time.Parse("2006-01-02", "2024-01-01")
	to, _ := time.Parse("2006-01-02", "2024-12-31")
	points, err := client.Inflation(context.Background(), from, to, "quarter")
	if err != nil || len(points) != 1 || points[0].AnnualRatePercent != 4 {
		t.Fatalf("Inflation()=%+v error=%v", points, err)
	}
}

func TestInflationReportsAnUnavailableSourceAndRejectsUnexpectedShapes(t *testing.T) {
	for name, respond := range map[string]func() (*http.Response, error){
		"status": func() (*http.Response, error) {
			return &http.Response{StatusCode: 503, Body: io.NopCloser(strings.NewReader(""))}, nil
		},
		"transport": func() (*http.Response, error) { return nil, errors.New("connection refused") },
		"dimensions": func() (*http.Response, error) {
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"id":["MESEC"],"size":[1],"dimension":{"MESEC":{"category":{"index":{"2024M01":0}}}},"value":[101]}`))}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			client := NewClient(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return respond() })}, "https://example.test")
			from := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
			if _, err := client.Inflation(context.Background(), from, from, "month"); !errors.Is(err, ErrSourceUnavailable) {
				t.Fatalf("Inflation() error=%v, want ErrSourceUnavailable", err)
			}
		})
	}
}
