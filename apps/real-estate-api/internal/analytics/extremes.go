package analytics

import (
	"context"
	"fmt"
)

type TransactionExtreme struct {
	Direction     string   `json:"direction"`
	TransactionID int64    `json:"transactionId"`
	ContractDate  *string  `json:"contractDate"`
	PropertyGroup string   `json:"propertyGroup"`
	Area          *float64 `json:"area"`
	Amount        *float64 `json:"amount"`
	AmountPerSQM  float64  `json:"amountPerSqm"`
}

func (r *SaleStatisticsRepository) TransactionExtremes(
	ctx context.Context, kind string, filter StatisticsFilter, limit int,
) ([]TransactionExtreme, error) {
	table, amount, perSQM := saleFactsTable(filter), "price", "price_per_sqm"
	if kind == "rent" {
		table, amount, perSQM = "analytics.rental_facts",
			"monthly_rent_ex_vat", "monthly_rent_per_sqm"
	} else if kind != "sale" {
		return nil, fmt.Errorf("unsupported transaction kind %q", kind)
	}
	var args queryArgs
	where, err := r.factFilter(ctx, "fact", filter, &args)
	if err != nil {
		return nil, err
	}
	rank := args.add(limit)
	query := fmt.Sprintf(`
		WITH eligible AS MATERIALIZED (
		  SELECT fact.transaction_id,fact.contract_date,fact.property_group,fact.area,fact.%[1]s amount,
		    fact.%[2]s amount_per_sqm
		  FROM %[3]s fact
		  WHERE fact.representative_eligible AND fact.%[2]s>0 AND fact.%[1]s>0 AND %[4]s
		), ranked AS (
		  SELECT *,
		    row_number() OVER(ORDER BY amount,transaction_id) low_rank,
		    row_number() OVER(ORDER BY amount DESC,transaction_id) high_rank
		  FROM eligible
		)
		SELECT *
		FROM (
		  SELECT 'lowest' direction,transaction_id,contract_date::text,property_group,
		    area::float8,amount::float8,amount_per_sqm::float8
		  FROM ranked WHERE low_rank<=%[5]s
		  UNION ALL
		  SELECT 'highest' direction,transaction_id,contract_date::text,property_group,
		    area::float8,amount::float8,amount_per_sqm::float8
		  FROM ranked WHERE high_rank<=%[5]s
		) extremes
		ORDER BY CASE direction WHEN 'highest' THEN 0 ELSE 1 END,
		  CASE WHEN direction='highest' THEN -amount ELSE amount END,transaction_id`,
		amount, perSQM, table, where, rank)
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("load transaction extremes: %w", err)
	}
	defer rows.Close()
	items := make([]TransactionExtreme, 0, limit*2)
	for rows.Next() {
		var item TransactionExtreme
		if err := rows.Scan(&item.Direction, &item.TransactionID,
			&item.ContractDate, &item.PropertyGroup, &item.Area,
			&item.Amount, &item.AmountPerSQM); err != nil {
			return nil, fmt.Errorf("scan transaction extreme: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
