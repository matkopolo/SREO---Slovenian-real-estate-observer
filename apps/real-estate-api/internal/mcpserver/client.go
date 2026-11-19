// Package mcpserver exposes the read-only SREO API to MCP clients (Claude Desktop, Claude Code,
// other agents) as a small set of typed tools and documentation resources.
//
// It is a thin layer: every tool is one or two GET requests to the API, whose JSON answer is
// returned as the tool's structured content together with the source and licence notice.
// Nothing is stored and nothing can be written.
package mcpserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Attribution is the notice every answer carries; the CC BY 4.0 licence of the GURS data and the
// re-use terms of the other registers require it to travel with the data.
const Attribution = "Vir: Geodetska uprava RS (GURS), Evidenca trga nepremičnin, Register prostorskih enot, " +
	"Kataster nepremičnin in Evidenca vrednotenja (CC BY 4.0); Register energetskih izkaznic (MOPE); " +
	"DRSV (CC BY 4.0); SURS; Banka Slovenije; ECB. Podatki so obdelani; prikaz je informativen in ni uradna cenitev."

// maxAnswerBytes bounds one API answer read into memory; the largest documented answers (map
// layers, flood zones) stay well under it.
const maxAnswerBytes = 32 << 20

// APIError is an error answer of the SREO API, with the API's own code and message so the tool
// result can relay them ("invalid_bbox: bbox must contain west,south,east,north").
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("SREO API answered %d", e.Status)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Client calls the SREO API.
type Client struct {
	base      *url.URL
	http      *http.Client
	userAgent string
}

// NewClient returns a client for the API at baseURL (for example http://real-estate-api:8080).
// A nil httpClient uses one with a 30 s timeout.
func NewClient(baseURL string, httpClient *http.Client) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(baseURL, "/"))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, fmt.Errorf("SREO API URL %q is not an absolute http(s) URL", baseURL)
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{base: base, http: httpClient, userAgent: "sreo-mcp/1.0"}, nil
}

// BaseURL is the API the client calls.
func (c *Client) BaseURL() string { return c.base.String() }

// query is one request's query string; nil and empty values are left out.
type query map[string]string

// get performs one GET and decodes the JSON answer into out.
func (c *Client) get(ctx context.Context, path string, params query, out any) error {
	target := *c.base
	target.Path = strings.TrimRight(c.base.Path, "/") + path
	values := url.Values{}
	for key, value := range params {
		if value != "" {
			values.Set(key, value)
		}
	}
	target.RawQuery = values.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return fmt.Errorf("build request %s: %w", path, err)
	}
	request.Header.Set("Accept", "application/json, application/geo+json")
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("call SREO API %s: %w", path, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxAnswerBytes+1))
	if err != nil {
		return fmt.Errorf("read SREO API answer %s: %w", path, err)
	}
	if len(body) > maxAnswerBytes {
		return fmt.Errorf("SREO API answer %s exceeds %d MiB; narrow the request", path, maxAnswerBytes>>20)
	}
	if response.StatusCode != http.StatusOK {
		apiErr := &APIError{Status: response.StatusCode}
		var envelope struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(body, &envelope) == nil {
			apiErr.Code, apiErr.Message = envelope.Error.Code, envelope.Error.Message
		}
		return apiErr
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("decode SREO API answer %s: %w", path, err)
	}
	return nil
}

// Answer is the raw JSON object the API returned.
type Answer map[string]any

// getAnswer performs one GET and returns the answer as a JSON object.
func (c *Client) getAnswer(ctx context.Context, path string, params query) (Answer, error) {
	var answer Answer
	if err := c.get(ctx, path, params, &answer); err != nil {
		return nil, err
	}
	return answer, nil
}

// isNotFound reports whether err is the API's 404.
func isNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}
