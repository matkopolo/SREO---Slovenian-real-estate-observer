package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"strings"
)

// HTTP caching. Analytics data changes only when a new analytical release is published, so the
// analytics endpoints get an ETag derived from the active release and answer a matching
// If-None-Match with 304 before running any query. Endpoints fed by other sources (SURS,
// construction registers, geographies, the release status itself) get an ETag hashed from the
// response body: that saves the transfer but not the work.
const (
	// publicCacheControl lets browsers and proxies reuse an answer for a minute and serve it
	// stale for five more while they revalidate, so a new release shows within that window.
	publicCacheControl = "public, max-age=60, stale-while-revalidate=300"
	// revalidateCacheControl makes clients ask every time (they still get a 304).
	revalidateCacheControl = "no-cache"
	// noStoreCacheControl is sent with errors, so a transient failure is never reused.
	noStoreCacheControl = "no-store"
)

// releaseCached serves next with a weak ETag built from the active release, the UTC day, this
// process (its build and start, so a deploy never reuses a previous build's answers) and the
// canonical request URL. When the active release cannot be read the request is served without caching
// headers rather than failed.
func (s *server) releaseCached(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		releaseID, err := s.activeRelease.ActiveReleaseID(r.Context())
		if err != nil || releaseID == "" {
			if err != nil {
				requestLog(r).Warn("active release unavailable; serving without an ETag", "error", err)
			}
			next(&cacheHeaders{ResponseWriter: w}, r)
			return
		}
		// The day is part of the tag because transaction contexts weigh comparables by their age.
		day := s.now().UTC().Format("20060102")
		etag := `W/"` + releaseID + "." + day + "." + s.instance + "." + digest([]byte(canonicalURL(r))) + `"`
		header := w.Header()
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			header.Set("ETag", etag)
			header.Set("Cache-Control", publicCacheControl)
			w.WriteHeader(http.StatusNotModified)
			return
		}
		next(&cacheHeaders{ResponseWriter: w, etag: etag, cacheControl: publicCacheControl}, r)
	}
}

// contentCached buffers the answer of next and gives a successful one an ETag hashed from its
// body, answering a matching If-None-Match with 304 and no body.
func contentCached(cacheControl string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		buffer := &bufferedResponse{header: w.Header()}
		next(buffer, r)
		status := buffer.status
		if status == 0 {
			status = http.StatusOK
		}
		header := w.Header()
		if status != http.StatusOK {
			header.Set("Cache-Control", noStoreCacheControl)
			w.WriteHeader(status)
			_, _ = w.Write(buffer.body.Bytes())
			return
		}
		etag := `W/"` + digest(buffer.body.Bytes()) + `"`
		header.Set("ETag", etag)
		header.Set("Cache-Control", cacheControl)
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			header.Del("Content-Type")
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write(buffer.body.Bytes())
	}
}

// cacheHeaders adds the ETag and Cache-Control to a 200 answer and no-store to anything else.
type cacheHeaders struct {
	http.ResponseWriter
	etag, cacheControl string
	wroteHeader        bool
}

func (w *cacheHeaders) WriteHeader(status int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		header := w.Header()
		switch {
		case status != http.StatusOK:
			header.Set("Cache-Control", noStoreCacheControl)
		case w.etag != "":
			header.Set("ETag", w.etag)
			header.Set("Cache-Control", w.cacheControl)
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *cacheHeaders) Write(body []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}

func (w *cacheHeaders) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// bufferedResponse holds an answer until its ETag is known. Headers go straight to the real
// writer's header map, which is not sent before the real WriteHeader.
type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bufferedResponse) Header() http.Header { return b.header }

func (b *bufferedResponse) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *bufferedResponse) Write(body []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(body)
}

// canonicalURL is the path with the query parameters sorted, so the same question asked with
// its parameters in another order gets the same ETag.
func canonicalURL(r *http.Request) string {
	query := r.URL.Query().Encode()
	if query == "" {
		return r.URL.Path
	}
	return r.URL.Path + "?" + query
}

// digest is a short, ETag-safe hash (96 bits of SHA-256, base64url).
func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:12])
}

// etagMatches applies the weak comparison of If-None-Match (RFC 9110 13.1.2): "*" matches any
// current representation, and W/ prefixes are ignored.
func etagMatches(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" {
		return false
	}
	opaque := strings.TrimPrefix(etag, "W/")
	for candidate := range strings.SplitSeq(ifNoneMatch, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || strings.TrimPrefix(candidate, "W/") == opaque {
			return true
		}
	}
	return false
}
