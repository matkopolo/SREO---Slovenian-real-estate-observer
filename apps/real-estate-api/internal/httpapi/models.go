package httpapi

import (
	"net/http"

	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/analytics"
)

func (s *server) marketIndices(w http.ResponseWriter, r *http.Request) {
	filter := analytics.MarketIndexFilter{
		TransactionKind: r.URL.Query().Get("transactionKind"),
		Method:          r.URL.Query().Get("method"),
		PropertyGroup:   r.URL.Query().Get("propertyGroup"),
	}
	if !validOptionalTransactionKind(filter.TransactionKind) {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_kind",
			"transactionKind must be sale or rent")
		return
	}
	if filter.Method != "" && filter.Method != "matched_pair_median" &&
		filter.Method != "hedonic" {
		writeError(w, r, http.StatusBadRequest, "invalid_method",
			"method must be matched_pair_median or hedonic")
		return
	}
	if filter.PropertyGroup != "" && !validPropertyGroup(filter.PropertyGroup) {
		writeError(w, r, http.StatusBadRequest, "invalid_property_group",
			"unsupported propertyGroup")
		return
	}
	items, err := s.models.MarketIndices(r.Context(), filter)
	if err != nil {
		s.fail(w, r, "load market indices", err)
		return
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"items": items, "count": len(items), "scope": "Slovenia",
	})
}

func (s *server) valuationPrediction(w http.ResponseWriter, r *http.Request) {
	kind := r.PathValue("kind")
	if kind != "sale" && kind != "rent" {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_kind",
			"transaction kind must be sale or rent")
		return
	}
	id, ok := transactionID(w, r)
	if !ok {
		return
	}
	result, err := s.models.ValuationPrediction(r.Context(), kind, id)
	if err != nil {
		s.fail(w, r, "load valuation prediction", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}
