package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("DATABASE_MAX_CONNECTIONS", "")
	t.Setenv("API_ALLOWED_ORIGINS", " https://one.example,https://two.example ")
	t.Setenv("LOG_LEVEL", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Address != ":8080" || cfg.DatabaseMaxConnections != 10 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if len(cfg.AllowedOrigins) != 2 || cfg.AllowedOrigins[0] != "https://one.example" {
		t.Fatalf("unexpected origins: %v", cfg.AllowedOrigins)
	}
}

func TestLoadRequiresDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load() expected an error")
	}
}

func TestLoadRejectsInvalidPoolSize(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("DATABASE_MAX_CONNECTIONS", "zero")
	if _, err := Load(); err == nil {
		t.Fatal("Load() expected an error")
	}
}

func TestLoadReadsTimeouts(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgresql://example")
	t.Setenv("DATABASE_STATEMENT_TIMEOUT", "")
	t.Setenv("API_REQUEST_TIMEOUT", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.DatabaseStatementTimeout != 15*time.Second || cfg.RequestTimeout != 20*time.Second {
		t.Fatalf("timeouts = %s, %s", cfg.DatabaseStatementTimeout, cfg.RequestTimeout)
	}
	t.Setenv("DATABASE_STATEMENT_TIMEOUT", "5s")
	t.Setenv("API_REQUEST_TIMEOUT", "8s")
	if cfg, err = Load(); err != nil || cfg.DatabaseStatementTimeout != 5*time.Second || cfg.RequestTimeout != 8*time.Second {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	for _, value := range []string{"fast", "0s", "45s"} {
		t.Setenv("API_REQUEST_TIMEOUT", value)
		if _, err := Load(); err == nil {
			t.Fatalf("API_REQUEST_TIMEOUT=%s: expected an error", value)
		}
	}
}
