package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

func TestCORSPreflightContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		origin       string
		method       string
		headers      string
		allowOrigin  bool
		allowMethod  bool
		allowHeaders bool
	}{
		{"read", "http://localhost:5174", "GET", "Accept, X-Request-ID", true, true, true},
		{"disallowed origin", "https://evil.example", "GET", "Accept", false, false, false},
		{"write method", "http://localhost:5174", "POST", "Accept", true, false, true},
		{"authorization header", "http://localhost:5174", "GET", "Authorization", true, true, false},
	}
	handler := cors([]string{"http://localhost:5174"}, http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			t.Fatal("preflight reached application handler")
		},
	))
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(http.MethodOptions, "/api/v1/statistics/overview", nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Access-Control-Request-Method", test.method)
			request.Header.Set("Access-Control-Request-Headers", test.headers)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusNoContent {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			assertHeaderContains(t, response.Header().Get("Access-Control-Allow-Origin"),
				test.origin, test.allowOrigin)
			assertHeaderContains(t, response.Header().Get("Access-Control-Allow-Methods"),
				test.method, test.allowMethod)
			for _, header := range strings.Split(test.headers, ",") {
				assertHeaderContains(t, response.Header().Get("Access-Control-Allow-Headers"),
					strings.TrimSpace(header), test.allowHeaders)
			}
			if test.allowOrigin && response.Header().Get("Access-Control-Max-Age") != "600" {
				t.Errorf("Access-Control-Max-Age=%q", response.Header().Get("Access-Control-Max-Age"))
			}
			vary := strings.Join(response.Header().Values("Vary"), ",")
			for _, value := range []string{
				"Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers",
			} {
				if !strings.Contains(vary, value) {
					t.Errorf("Vary=%q missing %q", vary, value)
				}
			}
		})
	}
}

func TestStatusRecorderKeepsFirstStatus(t *testing.T) {
	response := httptest.NewRecorder()
	recorder := &statusRecorder{ResponseWriter: response}
	recorder.WriteHeader(http.StatusCreated)
	recorder.WriteHeader(http.StatusInternalServerError)
	if recorder.status != http.StatusCreated || response.Code != http.StatusCreated {
		t.Fatalf("recorder=%d response=%d", recorder.status, response.Code)
	}
}

func assertHeaderContains(t *testing.T, actual, expected string, want bool) {
	t.Helper()
	contains := strings.Contains(strings.ToLower(actual), strings.ToLower(expected))
	if contains != want {
		t.Fatalf("header=%q contains %q: got %v want %v", actual, expected, contains, want)
	}
}

func TestRequestIDIsValidatedAndEchoed(t *testing.T) {
	for header, keep := range map[string]bool{
		"abc-123_X.y":               true,
		"":                          false,
		"has space":                 false,
		"line\nbreak":               false,
		strings.Repeat("a", 64):     true,
		strings.Repeat("a", 65):     false,
		"<script>alert(1)</script>": false,
	} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/health/live", nil)
		request.Header.Set("X-Request-ID", header)
		newTestHandler(nil, fakeGeographies{}).ServeHTTP(response, request)
		got := response.Header().Get("X-Request-ID")
		if keep != (got == header) || got == "" || !validRequestID(got) {
			t.Errorf("X-Request-ID %q -> %q (keep=%v)", header, got, keep)
		}
	}
}

type logLines struct{ bytes.Buffer }

func (l *logLines) entries(t *testing.T) []map[string]any {
	t.Helper()
	var entries []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(l.String()), "\n") {
		if line == "" {
			continue
		}
		entry := map[string]any{}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		entries = append(entries, entry)
	}
	return entries
}

func TestEveryLogLineCarriesTheRequestID(t *testing.T) {
	var logs logLines
	handler := handlerWith(func(d *Dependencies) {
		d.Logger = slog.New(slog.NewJSONHandler(&logs, nil))
		d.Statistics = fakeStatistics{err: errors.New("relation does not exist")}
	})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/statistics/overview", nil)
	request.Header.Set("X-Request-ID", "trace-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"requestId":"trace-1"`) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "relation does not exist") {
		t.Fatalf("internal error leaked to the client: %s", response.Body.String())
	}
	entries := logs.entries(t)
	if len(entries) != 2 {
		t.Fatalf("log entries=%v", entries)
	}
	for _, entry := range entries {
		if entry["request_id"] != "trace-1" || entry["path"] != "/api/v1/statistics/overview" {
			t.Fatalf("entry without request context: %v", entry)
		}
	}
	if entries[0]["msg"] != "calculate overview statistics failed" || entries[1]["msg"] != "http request" {
		t.Fatalf("entries=%v", entries)
	}
}

func TestPanicIsAnsweredAndStillAccessLogged(t *testing.T) {
	var logs logLines
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler := middleware(logger, nil, time.Second, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/x", nil))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d", response.Code)
	}
	entries := logs.entries(t)
	if len(entries) != 2 || entries[0]["msg"] != "panic recovered" || entries[1]["msg"] != "http request" ||
		entries[1]["status"] != float64(500) || entries[0]["request_id"] != entries[1]["request_id"] {
		t.Fatalf("entries=%v", entries)
	}
}

func TestAbortHandlerPanicIsPropagated(t *testing.T) {
	handler := middleware(slog.New(slog.DiscardHandler), nil, time.Second, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))
	defer func() {
		if recovered := recover(); recovered != http.ErrAbortHandler {
			t.Fatalf("recovered=%v, want http.ErrAbortHandler", recovered)
		}
	}()
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
}

func TestRequestsHaveADeadline(t *testing.T) {
	var deadline time.Time
	handler := middleware(slog.New(slog.DiscardHandler), nil, 3*time.Second, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		deadline, _ = r.Context().Deadline()
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if remaining := time.Until(deadline); remaining <= 0 || remaining > 3*time.Second {
		t.Fatalf("deadline in %s", remaining)
	}
}

func TestFailMapsErrorsToStatuses(t *testing.T) {
	for err, want := range map[error]int{
		analytics.ErrGeographyNotFound:                              http.StatusNotFound,
		fmt.Errorf("wrapped: %w", analytics.ErrTransactionNotFound): http.StatusNotFound,
		context.DeadlineExceeded:                                    http.StatusGatewayTimeout,
		&pgconn.PgError{Code: "57014"}:                              http.StatusGatewayTimeout,
		context.Canceled:                                            statusClientClosedRequest,
		errors.New("boom"):                                          http.StatusInternalServerError,
	} {
		handler := handlerWith(func(d *Dependencies) { d.Statistics = fakeStatistics{err: err} })
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/statistics/overview", nil))
		if response.Code != want {
			t.Errorf("%v: status=%d want=%d", err, response.Code, want)
		}
	}
}

func TestNewRejectsMissingDependencies(t *testing.T) {
	dependencies := testDependencies()
	dependencies.Recent = nil
	dependencies.Logger = nil
	_, err := New(dependencies)
	if err == nil || !strings.Contains(err.Error(), "Recent") || !strings.Contains(err.Error(), "Logger") {
		t.Fatalf("New() error=%v", err)
	}
}
