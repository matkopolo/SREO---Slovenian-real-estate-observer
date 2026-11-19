package analytics

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

// RecentTransaction is one recorded agreement with its location, newest first.
type RecentTransaction struct {
	TransactionID    int64    `json:"transactionId"`
	ContractDate     *string  `json:"contractDate"`
	PropertyGroup    string   `json:"propertyGroup"`
	Area             *float64 `json:"area"`
	Amount           *float64 `json:"amount"`
	AmountPerSQM     *float64 `json:"amountPerSqm"`
	Representative   bool     `json:"representative"`
	Settlement       *string  `json:"settlement"`
	Street           *string  `json:"street"`
	HouseNumber      *string  `json:"houseNumber"`
	ConstructionYear *int32   `json:"constructionYear"`
	// Land has no street address: the place, the largest parcel and how many parcels the price covers.
	SettlementName        *string `json:"settlementName"`
	CadastralMunicipality *int32  `json:"cadastralMunicipalityCode"`
	ParcelNumber          *string `json:"parcelNumber"`
	ParcelCount           int     `json:"parcelCount"`
}

// RecentPage is one page of an area's agreements: sort key, direction, offset and an optional street.
type RecentPage struct {
	Limit      int
	Offset     int
	Sort       string // date, price, perSqm, area
	Descending bool
	Street     string // street name as registered (case-insensitive); empty for all
}

// RecentStore lists an area's agreements (newest first by default) with the total count.
type RecentStore interface {
	RecentTransactions(ctx context.Context, kind string, filter StatisticsFilter, page RecentPage) ([]RecentTransaction, int, error)
}

// RecentTransactions returns one page of an area's agreements and the number of agreements
// matching the filter. The total is a separate count with the same filter: a window count over
// the page query makes PostgreSQL materialise every matching row before the LIMIT, while the
// page alone can stop early on the contract-date indexes. Both run in one repeatable-read
// transaction, so a release published between them cannot mix two generations of facts.
func (r *TransactionRepository) RecentTransactions(
	ctx context.Context, kind string, filter StatisticsFilter, page RecentPage,
) ([]RecentTransaction, int, error) {
	columns, ok := factColumnsFor(kind, filter)
	if !ok {
		return nil, 0, fmt.Errorf("unsupported transaction kind %q", kind)
	}
	column, ok := recentSortColumns[page.Sort]
	if !ok {
		column = "contract_date"
	}
	direction := "ASC"
	if page.Descending {
		direction = "DESC"
	}
	var args queryArgs
	where, err := r.factFilter(ctx, "f", filter, &args)
	if err != nil {
		return nil, 0, err
	}
	if page.Street != "" {
		where += fmt.Sprintf(" AND EXISTS (SELECT 1 FROM %s s WHERE s.transaction_id = f.transaction_id AND upper(s.street) = upper(%s))",
			columns.parts, args.add(page.Street))
	}
	// Rentals have no land parcels; the lateral join is switched off for them.
	landParcels := "true"
	if kind == "rent" {
		landParcels = "false"
	}
	countQuery := fmt.Sprintf(`SELECT count(*) FROM %s f WHERE %s`, columns.table, where)
	pageArgs := append(queryArgs{}, args...)
	query := fmt.Sprintf(`
		WITH latest AS (
		  SELECT f.transaction_id, f.contract_date, f.property_group, f.area, f.%[2]s amount, f.%[3]s amount_per_sqm,
		         f.representative_eligible, f.construction_year, f.settlement_id
		  FROM %[1]s f
		  WHERE %[5]s
		  ORDER BY %[6]s %[7]s NULLS LAST, f.transaction_id DESC
		  LIMIT %[9]s OFFSET %[10]s)
		SELECT l.transaction_id, l.contract_date::text, l.property_group, l.area::float8, l.amount::float8,
		       l.amount_per_sqm::float8, l.representative_eligible, a.settlement, a.street, a.house_number,
		       l.construction_year::int, place.name, parcel.cadastral_municipality_code::int, parcel.parcel_number::text, coalesce(parcel.parcels, 0)::int
		FROM latest l
		LEFT JOIN analytics.geographic_units place ON place.id = l.settlement_id
		LEFT JOIN LATERAL (
		  SELECT cadastral_municipality_code, parcel_number, count(*) OVER () parcels FROM land_parcels lp
		  WHERE %[8]s AND lp.transaction_id = l.transaction_id ORDER BY parcel_area DESC NULLS LAST LIMIT 1) parcel ON true
		LEFT JOIN LATERAL (
		  SELECT settlement, street, house_number::text || coalesce(nullif(trim(house_number_suffix::text), ''), '') house_number FROM %[4]s p
		  WHERE p.transaction_id = l.transaction_id ORDER BY (street IS NULL) LIMIT 1) a ON true
		ORDER BY l.%[6]s %[7]s NULLS LAST, l.transaction_id DESC`,
		columns.table, columns.amount, columns.perSQM, columns.parts, where, column, direction, landParcels,
		pageArgs.add(page.Limit), pageArgs.add(page.Offset))
	tx, err := database.BeginReadOnly(ctx, r.db, pgx.RepeatableRead)
	if err != nil {
		return nil, 0, fmt.Errorf("begin recent transactions: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count recent transactions: %w", err)
	}
	items, err := recentPage(ctx, tx, query, pageArgs, page.Limit)
	if err != nil {
		return nil, 0, err
	}
	return items, total, tx.Commit(ctx)
}

// recentPage runs the page query and scans its rows.
func recentPage(ctx context.Context, db database.Querier, query string, args []any, limit int) ([]RecentTransaction, error) {
	rows, err := db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("recent transactions: %w", err)
	}
	defer rows.Close()
	items := make([]RecentTransaction, 0, limit)
	for rows.Next() {
		var item RecentTransaction
		if err := rows.Scan(&item.TransactionID, &item.ContractDate, &item.PropertyGroup, &item.Area, &item.Amount,
			&item.AmountPerSQM, &item.Representative, &item.Settlement, &item.Street, &item.HouseNumber,
			&item.ConstructionYear, &item.SettlementName, &item.CadastralMunicipality, &item.ParcelNumber, &item.ParcelCount); err != nil {
			return nil, fmt.Errorf("scan recent transaction: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate recent transactions: %w", err)
	}
	return items, nil
}
