package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/affordability"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/construction"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/demography"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/economics"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/geography"
)

type errorBody struct {
	Error apiError `json:"error"`
}

type apiError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId,omitempty"`
}

// statusClientClosedRequest is logged when the client went away before the answer was ready.
const statusClientClosedRequest = 499

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	writeEncoded(w, r, status, "application/json; charset=utf-8", value)
}

func writeGeoJSON(w http.ResponseWriter, r *http.Request, status int, value any) {
	writeEncoded(w, r, status, "application/geo+json; charset=utf-8", value)
}

// writeEncoded encodes value before sending any header, so a value JSON cannot represent (a NaN
// or infinite float from the database) is answered with a 500 instead of a truncated 200 that
// caches could keep.
func writeEncoded(w http.ResponseWriter, r *http.Request, status int, contentType string, value any) {
	var body bytes.Buffer
	if err := json.NewEncoder(&body).Encode(value); err != nil {
		requestLog(r).Error("encode response", "error", err)
		if _, failing := value.(errorBody); failing {
			http.Error(w, "internal server error", http.StatusInternalServerError)
			return
		}
		writeError(w, r, http.StatusInternalServerError, "internal_error", "the answer could not be encoded")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(status)
	_, _ = w.Write(body.Bytes())
}

func writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	writeJSON(w, r, status, errorBody{Error: apiError{
		Code:      code,
		Message:   message,
		RequestID: requestIDFromContext(r.Context()),
	}})
}

// errorResponse is the public answer to a known error.
type errorResponse struct {
	status        int
	code, message string
}

// knownErrors maps repository sentinel errors to their HTTP answer. Anything else is a 500.
var knownErrors = []struct {
	err      error
	response errorResponse
}{
	{analytics.ErrGeographyNotFound, errorResponse{http.StatusNotFound, "geography_not_found", "geography was not found"}},
	{geography.ErrNotFound, errorResponse{http.StatusNotFound, "geography_not_found", "geography was not found"}},
	{demography.ErrNotFound, errorResponse{http.StatusNotFound, "geography_not_found", "geography was not found"}},
	{construction.ErrGeographyNotFound, errorResponse{http.StatusNotFound, "geography_not_found", "geography was not found"}},
	{analytics.ErrTransactionNotFound, errorResponse{http.StatusNotFound, "transaction_not_found", "transaction was not found"}},
	{analytics.ErrBuildingNotFound, errorResponse{http.StatusNotFound, "building_not_found", "building was not found"}},
	{construction.ErrBuildingNotFound, errorResponse{http.StatusNotFound, "building_not_found", "building was not found"}},
	{analytics.ErrPredictionNotFound, errorResponse{http.StatusNotFound, "prediction_not_found", "no eligible model prediction exists for this transaction"}},
	{demography.ErrUnsupportedLevel, errorResponse{http.StatusBadRequest, "unsupported_level", demography.ErrUnsupportedLevel.Error()}},
	{affordability.ErrUnavailable, errorResponse{http.StatusServiceUnavailable, "affordability_unavailable", "official wage, rate or lending-rule data has not been synchronised yet"}},
	{demography.ErrUnavailable, errorResponse{http.StatusServiceUnavailable, "demography_unavailable", "SURS demographic tables have not been synchronised yet"}},
	{economics.ErrSourceUnavailable, errorResponse{http.StatusBadGateway, "source_unavailable", "SURS inflation data is unavailable"}},
	{economics.ErrIncompleteSeries, errorResponse{http.StatusServiceUnavailable, "inflation_unavailable", "complete monthly inflation series unavailable"}},
}

// fail answers a failed operation: known errors with their status (a 5xx one is logged as a
// warning, since an upstream source is missing), a deadline with 504, and anything else with
// a 500 "could not <operation>" that is logged with the request logger.
func (s *server) fail(w http.ResponseWriter, r *http.Request, operation string, err error) {
	for _, known := range knownErrors {
		if errors.Is(err, known.err) {
			if known.response.status >= http.StatusInternalServerError {
				requestLog(r).Warn(operation+" is unavailable", "error", err)
			}
			writeError(w, r, known.response.status, known.response.code, known.response.message)
			return
		}
	}
	var pgError *pgconn.PgError
	switch {
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &pgError) && pgError.Code == "57014"):
		// The request deadline or PostgreSQL's statement_timeout.
		requestLog(r).Warn(operation+" timed out", "error", err)
		writeError(w, r, http.StatusGatewayTimeout, "timeout", "the request took too long; narrow the filter or try again")
	case errors.Is(err, context.Canceled):
		requestLog(r).Debug(operation+" cancelled by the client", "error", err)
		writeError(w, r, statusClientClosedRequest, "request_cancelled", "the request was cancelled")
	default:
		requestLog(r).Error(operation+" failed", "error", err)
		writeError(w, r, http.StatusInternalServerError, "query_failed", "could not "+operation)
	}
}
