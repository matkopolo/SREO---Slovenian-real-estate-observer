// Command sreo-mcp serves the SREO API to MCP clients over stdio or streamable HTTP.
//
// Configuration (environment, with flags of the same meaning):
//
//	SREO_API_URL    base URL of the SREO API (default http://localhost:8080)
//	MCP_TRANSPORT   stdio (default) or http
//	MCP_ADDRESS     listen address for the http transport (default :8090)
//	MCP_DOCS_DIR    directory with the methodology and licensing documents served as resources
//	MCP_SITE_URL    public site URL used in links (default https://sreo.si)
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/mcpserver"
)

const (
	readHeaderTimeout = 5 * time.Second
	shutdownTimeout   = 10 * time.Second
)

func main() {
	if err := run(); err != nil {
		slog.Error("sreo-mcp failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	transport := flag.String("transport", env("MCP_TRANSPORT", "stdio"), "stdio or http")
	address := flag.String("address", env("MCP_ADDRESS", ":8090"), "listen address for the http transport")
	apiURL := flag.String("api", env("SREO_API_URL", "http://localhost:8080"), "SREO API base URL")
	docsDir := flag.String("docs", env("MCP_DOCS_DIR", ""), "directory with the documentation resources")
	siteURL := flag.String("site", env("MCP_SITE_URL", "https://sreo.si"), "public site URL used in links")
	flag.Parse()

	// On stdio the standard output is the protocol channel, so logs go to stderr in every mode.
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	client, err := mcpserver.NewClient(*apiURL, nil)
	if err != nil {
		return err
	}
	service := mcpserver.NewService(client, mcpserver.Options{DocsDir: *docsDir, SiteURL: *siteURL, Logger: logger})
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch *transport {
	case "stdio":
		return service.Server().Run(ctx, &mcp.StdioTransport{})
	case "http":
		return serveHTTP(ctx, logger, *address, client, service)
	default:
		return fmt.Errorf("unknown transport %q (stdio or http)", *transport)
	}
}

// serveHTTP serves the streamable HTTP transport until ctx ends. The signal context is the
// base of every request, so the open event streams end when shutdown starts and the server
// can drain; streams a client keeps open past shutdownTimeout are cut, which is not a failure.
func serveHTTP(ctx context.Context, logger *slog.Logger, address string, client *mcpserver.Client, service *mcpserver.Service) error {
	server := &http.Server{Addr: address, Handler: service.HTTPHandler(), ReadHeaderTimeout: readHeaderTimeout,
		BaseContext: func(net.Listener) context.Context { return ctx }}
	errs := make(chan error, 1)
	go func() {
		logger.Info("sreo-mcp listening", "address", address, "api", client.BaseURL())
		errs <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		logger.Info("shutdown requested")
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		if !errors.Is(err, context.DeadlineExceeded) {
			return err
		}
		logger.Info("shutdown cut the connections still open", "after", shutdownTimeout)
	}
	logger.Info("sreo-mcp stopped")
	return nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
