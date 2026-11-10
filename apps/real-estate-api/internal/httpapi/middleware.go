package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"runtime/debug"
	"slices"
	"time"
)

type contextKey string

const (
	requestIDKey contextKey = "request-id"
	loggerKey    contextKey = "logger"
)

// statusRecorder remembers the status and size of a response for the access log.
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusRecorder) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecorder) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(body)
	w.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (w *statusRecorder) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *statusRecorder) headerWritten() bool { return w.status != 0 }

// middleware wraps the router. Order matters: the request id and its logger come first, the
// access log wraps the recoverer so a panicking request is still logged, and the deadline is
// set closest to the handlers.
func middleware(logger *slog.Logger, allowedOrigins []string, requestTimeout time.Duration, next http.Handler) http.Handler {
	return requestID(logger, accessLog(recoverer(securityHeaders(cors(allowedOrigins, deadline(requestTimeout, next))))))
}

// requestID accepts a well-formed X-Request-ID or generates one, echoes it, and stores it with
// a request logger (request_id, method, path) in the context.
func requestID(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !validRequestID(id) {
			id = randomID()
		}
		w.Header().Set("X-Request-ID", id)
		requestLogger := logger.With("request_id", id, "method", r.Method, "path", r.URL.Path)
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		ctx = context.WithValue(ctx, loggerKey, requestLogger)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// validRequestID accepts 1–64 characters of [A-Za-z0-9._-], so a client id can be logged safely.
func validRequestID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, character := range []byte(id) {
		switch {
		case character >= 'a' && character <= 'z', character >= 'A' && character <= 'Z',
			character >= '0' && character <= '9', character == '.', character == '_', character == '-':
		default:
			return false
		}
	}
	return true
}

func accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &statusRecorder{ResponseWriter: w}
		defer func() {
			// Runs also when the handler aborts with http.ErrAbortHandler.
			requestLog(r).Info("http request",
				"status", recorder.status,
				"bytes", recorder.bytes,
				"duration_ms", time.Since(started).Milliseconds(),
			)
		}()
		next.ServeHTTP(recorder, r)
	})
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered) // net/http's deliberate abort; the server handles it
			}
			requestLog(r).Error("panic recovered", "panic", recovered, "stack", string(debug.Stack()))
			if recorder, ok := w.(interface{ headerWritten() bool }); ok && recorder.headerWritten() {
				return // too late for an error body
			}
			writeError(w, r, http.StatusInternalServerError, "internal_error", "internal server error")
		}()
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// cors allows the configured origins to read the (read-only) API.
func cors(allowedOrigins []string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Add("Vary", "Origin")
		w.Header().Add("Vary", "Access-Control-Request-Method")
		w.Header().Add("Vary", "Access-Control-Request-Headers")
		origin := r.Header.Get("Origin")
		if origin != "" && slices.Contains(allowedOrigins, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Accept, X-Request-ID")
			w.Header().Set("Access-Control-Expose-Headers", "X-Request-ID")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// deadline bounds every request: queries run on the request context and are cancelled with it.
func deadline(timeout time.Duration, next http.Handler) http.Handler {
	if timeout <= 0 {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func requestIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// requestLog returns the request's logger (with request_id, method and path).
func requestLog(r *http.Request) *slog.Logger {
	if logger, ok := r.Context().Value(loggerKey).(*slog.Logger); ok {
		return logger
	}
	return slog.Default()
}

func randomID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return time.Now().UTC().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(buffer)
}
