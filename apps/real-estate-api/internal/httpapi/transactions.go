package httpapi

import (
	"net/http"
	"strconv"
)

func (s *server) saleTransaction(w http.ResponseWriter, r *http.Request) {
	id, ok := transactionID(w, r)
	if !ok {
		return
	}
	result, err := s.transactions.SaleTransaction(r.Context(), id)
	if err != nil {
		s.fail(w, r, "load transaction", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) rentalTransaction(w http.ResponseWriter, r *http.Request) {
	id, ok := transactionID(w, r)
	if !ok {
		return
	}
	result, err := s.transactions.RentalTransaction(r.Context(), id)
	if err != nil {
		s.fail(w, r, "load transaction", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

func (s *server) saleTransactionContext(w http.ResponseWriter, r *http.Request) {
	s.transactionContext(w, r, "sale")
}

func (s *server) rentalTransactionContext(w http.ResponseWriter, r *http.Request) {
	s.transactionContext(w, r, "rent")
}

func (s *server) transactionContext(w http.ResponseWriter, r *http.Request, kind string) {
	id, ok := transactionID(w, r)
	if !ok {
		return
	}
	result, err := s.transactions.TransactionContext(r.Context(), kind, id)
	if err != nil {
		s.fail(w, r, "load transaction context", err)
		return
	}
	writeJSON(w, r, http.StatusOK, result)
}

// transactionID reads the {id} path value. Source ids can be negative, never zero.
func transactionID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id == 0 {
		writeError(w, r, http.StatusBadRequest, "invalid_transaction_id",
			"transaction id must be a non-zero integer")
		return 0, false
	}
	return id, true
}
