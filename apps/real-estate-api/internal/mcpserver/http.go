package mcpserver

import (
	"net/http"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// sessionTimeout closes a session whose client sent nothing for this long; together with
// the keep-alive pings it bounds what abandoned clients leave behind.
const sessionTimeout = 30 * time.Minute

// HTTPHandler serves the streamable HTTP transport at every path except the liveness check at
// /health/live. Each session gets its own server from Server; the service itself is shared.
func (s *Service) HTTPHandler() http.Handler {
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return s.Server() },
		&mcp.StreamableHTTPOptions{Logger: s.logger, SessionTimeout: sessionTimeout})
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}` + "\n"))
	})
	mux.Handle("/", handler)
	return mux
}
