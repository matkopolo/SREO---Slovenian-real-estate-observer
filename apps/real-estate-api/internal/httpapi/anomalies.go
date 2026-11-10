package httpapi

import (
	"net/http"
	"strconv"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

// The anomaly queue is read-only: reviews are not recorded through the API.

func (s *server) anomalies(w http.ResponseWriter, r *http.Request) {
	filter, ok := anomalyFilter(w, r)
	if !ok {
		return
	}
	limit, offset, ok := pageParameters(w, r, 50, 100)
	if !ok {
		return
	}
	items, total, err := s.anomaliesStore.Anomalies(r.Context(), filter, limit, offset)
	if err != nil {
		s.fail(w, r, "load the anomaly queue", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": items, "count": len(items), "total": total, "limit": limit, "offset": offset,
	})
}

func (s *server) anomalySummary(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("transactionKind")
	if !validOptionalTransactionKind(kind) {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_kind", "transactionKind must be sale or rent")
		return
	}
	result, err := s.anomaliesStore.AnomalySummary(r.Context(), kind)
	if err != nil {
		s.fail(w, r, "summarise anomalies", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func anomalyFilter(w http.ResponseWriter, r *http.Request) (analytics.AnomalyFilter, bool) {
	filter := analytics.AnomalyFilter{
		TransactionKind: r.URL.Query().Get("transactionKind"),
		Flag:            r.URL.Query().Get("flag"),
		ReviewStatus:    r.URL.Query().Get("reviewStatus"),
	}
	if !validOptionalTransactionKind(filter.TransactionKind) {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_kind", "transactionKind must be sale or rent")
		return filter, false
	}
	if filter.ReviewStatus != "" && !validReviewStatus(filter.ReviewStatus) {
		writeError(w, r, http.StatusBadRequest, "invalid_review_status", "unsupported reviewStatus")
		return filter, false
	}
	if value := r.URL.Query().Get("minimumScore"); value != "" {
		score, err := strconv.ParseFloat(value, 64)
		if err != nil || score < 0 || score > 1 {
			writeError(w, r, http.StatusBadRequest, "invalid_minimum_score", "minimumScore must be between 0 and 1")
			return filter, false
		}
		filter.MinimumScore = score
	}
	return filter, true
}

// validOptionalTransactionKind accepts sale, rent, or no kind (both).
func validOptionalTransactionKind(kind string) bool {
	return kind == "" || kind == "sale" || kind == "rent"
}

func validReviewStatus(status string) bool {
	switch status {
	case "unreviewed", "confirmed_valid", "confirmed_error", "needs_follow_up", "ignored":
		return true
	default:
		return false
	}
}
