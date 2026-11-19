package analytics

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/matkopolo/NepremicninskiAgent/apps/real-estate-api/internal/database"
)

// PropertyHistory lists every recorded agreement of the assets a sale names. Source identities
// are not cadastral lineage or proof of uninterrupted ownership.
type PropertyHistory struct {
	TransactionID int64          `json:"transactionId"`
	Assets        []HistoryAsset `json:"assets"`
	Truncated     bool           `json:"truncated"`
}

// HistoryAsset is one asset (building part or parcel) with its recorded events and resale pairs.
type HistoryAsset struct {
	Kind          string         `json:"kind"`
	CadastralCode int32          `json:"cadastralCode"`
	Number        string         `json:"number"`
	PartNumber    string         `json:"partNumber"`
	Events        []HistoryEvent `json:"events"`
	Pairs         []ResalePair   `json:"pairs"`
	Truncated     bool           `json:"truncated"`
}

// HistoryEvent is one agreement component recorded for an asset.
type HistoryEvent struct {
	TransactionID     int64    `json:"transactionId"`
	ComponentID       int64    `json:"componentId"`
	ContractDate      *string  `json:"contractDate"`
	Evidence          string   `json:"evidence"`
	PropertyGroup     string   `json:"propertyGroup"`
	SourceType        *int32   `json:"sourceType"`
	Share             *string  `json:"share"`
	Area              *float64 `json:"area"`
	AgreementPrice    *float64 `json:"agreementPrice"`
	ComponentPrice    *float64 `json:"componentPrice"`
	ConstructionYear  *int32   `json:"constructionYear"`
	ComponentCount    int      `json:"componentCount"`
	Representative    bool     `json:"representative"`
	PossibleDuplicate bool     `json:"possibleDuplicate"`
}

// ResalePair links an agreement of an asset to its previous one.
type ResalePair struct {
	TransactionID  int64    `json:"transactionId"`
	PreviousID     int64    `json:"previousId"`
	From           *string  `json:"from"`
	To             *string  `json:"to"`
	Days           *int     `json:"days"`
	Comparable     bool     `json:"comparable"`
	PreviousPrice  *float64 `json:"previousPrice"`
	Price          *float64 `json:"price"`
	NominalChange  *float64 `json:"nominalChange"`
	ChangePercent  *float64 `json:"changePercent"`
	LandTransition bool     `json:"landTransition"`
}

// ResaleSummary describes the holding intervals of comparable resales matching a filter.
type ResaleSummary struct {
	PairCount     int64    `json:"pairCount"`
	AssetCount    int64    `json:"assetCount"`
	P25Days       *float64 `json:"p25Days"`
	MedianDays    *float64 `json:"medianDays"`
	P75Days       *float64 `json:"p75Days"`
	IsPublishable bool     `json:"isPublishable"`
}

// HistoryStore answers property histories and the resale summary.
type HistoryStore interface {
	PropertyHistory(context.Context, int64) (PropertyHistory, error)
	ResaleSummary(context.Context, StatisticsFilter) (ResaleSummary, error)
}

// PropertyHistory loads the history of sale agreement id in one repeatable-read transaction.
func (r *TransactionRepository) PropertyHistory(ctx context.Context, id int64) (PropertyHistory, error) {
	tx, err := database.BeginReadOnly(ctx, r.db, pgx.RepeatableRead)
	if err != nil {
		return PropertyHistory{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	result, err := loadPropertyHistory(ctx, tx, id)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// Bounds of one history answer: more assets or events are cut and reported as truncated.
const (
	maxHistoryAssets = 50
	maxHistoryEvents = 200
)

// historyKey identifies one asset of the history (a building part or a parcel).
type historyKey struct {
	kind   string
	code   int32
	number string
	part   string
}

// historyKeys splits the assets' identities into the parallel arrays the batched queries unnest.
func historyKeys(assets []*HistoryAsset) (kinds []string, codes []int32, numbers, parts []string) {
	for _, asset := range assets {
		kinds = append(kinds, asset.Kind)
		codes = append(codes, asset.CadastralCode)
		numbers = append(numbers, asset.Number)
		parts = append(parts, asset.PartNumber)
	}
	return kinds, codes, numbers, parts
}

// loadHistoryEvents fills the events of every asset in one query, at most maxHistoryEvents
// per asset (one more is read to detect the cut, which marks the asset truncated).
func loadHistoryEvents(ctx context.Context, tx database.Querier, assets []HistoryAsset) error {
	if len(assets) == 0 {
		return nil
	}
	byKey := make(map[historyKey]*HistoryAsset, len(assets))
	pointers := make([]*HistoryAsset, 0, len(assets))
	for i := range assets {
		pointers = append(pointers, &assets[i])
		byKey[historyKey{assets[i].Kind, assets[i].CadastralCode, assets[i].Number, assets[i].PartNumber}] = &assets[i]
	}
	kinds, codes, numbers, parts := historyKeys(pointers)
	rows, err := tx.Query(ctx, `
		SELECT identity_kind,cadastral_municipality_code,identity_number,part_number,
		  transaction_id,component_id,contract_date::text,evidence,property_group,
		  source_type,sold_share,component_area,agreement_price,component_price,construction_year,component_count,
		  representative_eligible,possible_duplicate
		FROM (
		  SELECT e.*,row_number() OVER (
		    PARTITION BY identity_kind,cadastral_municipality_code,identity_number,part_number
		    ORDER BY contract_date NULLS LAST,transaction_id,evidence,component_id) position
		  FROM analytics.property_history_events e
		  JOIN unnest($1::text[],$2::int[],$3::text[],$4::text[]) asset(kind,code,number,part)
		    ON e.identity_kind=asset.kind AND e.cadastral_municipality_code=asset.code
		   AND e.identity_number=asset.number AND e.part_number=asset.part
		) ranked
		WHERE position<=$5
		ORDER BY identity_kind,cadastral_municipality_code,identity_number,part_number,position`,
		kinds, codes, numbers, parts, maxHistoryEvents+1)
	if err != nil {
		return fmt.Errorf("history events: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key historyKey
		var e HistoryEvent
		if err := rows.Scan(&key.kind, &key.code, &key.number, &key.part,
			&e.TransactionID, &e.ComponentID, &e.ContractDate, &e.Evidence, &e.PropertyGroup,
			&e.SourceType, &e.Share, &e.Area, &e.AgreementPrice, &e.ComponentPrice, &e.ConstructionYear, &e.ComponentCount,
			&e.Representative, &e.PossibleDuplicate); err != nil {
			return fmt.Errorf("scan history event: %w", err)
		}
		asset := byKey[key]
		if asset == nil {
			continue
		}
		if len(asset.Events) == maxHistoryEvents {
			asset.Truncated = true
			continue
		}
		asset.Events = append(asset.Events, e)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("history events: %w", err)
	}
	return nil
}

// loadResalePairs fills the resale pairs of the given assets in one query.
func loadResalePairs(ctx context.Context, tx database.Querier, assets []*HistoryAsset) error {
	if len(assets) == 0 {
		return nil
	}
	byKey := make(map[historyKey]*HistoryAsset, len(assets))
	for _, asset := range assets {
		byKey[historyKey{asset.Kind, asset.CadastralCode, asset.Number, asset.PartNumber}] = asset
	}
	kinds, codes, numbers, parts := historyKeys(assets)
	rows, err := tx.Query(ctx, `
		SELECT p.identity_kind,p.cadastral_municipality_code,p.identity_number,p.part_number,
		  jsonb_agg(jsonb_build_object(
		    'transactionId',transaction_id,'previousId',previous_transaction_id,'from',previous_date,'to',contract_date,
		    'days',interval_days,'comparable',comparable,'previousPrice',previous_price,'price',price,
		    'nominalChange',CASE WHEN comparable THEN price-previous_price END,
		    'changePercent',CASE WHEN comparable THEN 100*(price/NULLIF(previous_price,0)-1) END,
		    'landTransition',agricultural_to_buildable
		  ) ORDER BY contract_date NULLS LAST,transaction_id)
		FROM analytics.property_resale_pairs p
		JOIN unnest($1::text[],$2::int[],$3::text[],$4::text[]) asset(kind,code,number,part)
		  ON p.identity_kind=asset.kind AND p.cadastral_municipality_code=asset.code
		 AND p.identity_number=asset.number AND p.part_number=asset.part
		GROUP BY 1,2,3,4`, kinds, codes, numbers, parts)
	if err != nil {
		return fmt.Errorf("resale pairs: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var key historyKey
		var data []byte
		if err := rows.Scan(&key.kind, &key.code, &key.number, &key.part, &data); err != nil {
			return fmt.Errorf("scan resale pairs: %w", err)
		}
		asset := byKey[key]
		if asset == nil {
			continue
		}
		if err := json.Unmarshal(data, &asset.Pairs); err != nil {
			return fmt.Errorf("decode resale pairs: %w", err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("resale pairs: %w", err)
	}
	return nil
}

func loadPropertyHistory(ctx context.Context, tx database.Querier, id int64) (PropertyHistory, error) {
	result := PropertyHistory{TransactionID: id, Assets: []HistoryAsset{}}
	var exists bool
	if err := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM analytics.sale_facts WHERE transaction_id=$1)", id).Scan(&exists); err != nil {
		return result, fmt.Errorf("history subject: %w", err)
	}
	if !exists {
		return result, ErrTransactionNotFound
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT identity_kind,cadastral_municipality_code,identity_number,part_number
		FROM analytics.property_history_events WHERE transaction_id=$1
		ORDER BY identity_kind,cadastral_municipality_code,identity_number,part_number LIMIT $2`, id, maxHistoryAssets+1)
	if err != nil {
		return result, fmt.Errorf("history identities: %w", err)
	}
	for rows.Next() {
		asset := HistoryAsset{Events: []HistoryEvent{}, Pairs: []ResalePair{}}
		if err := rows.Scan(&asset.Kind, &asset.CadastralCode, &asset.Number, &asset.PartNumber); err != nil {
			rows.Close()
			return result, fmt.Errorf("scan history identity: %w", err)
		}
		result.Assets = append(result.Assets, asset)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("history identities: %w", err)
	}
	if len(result.Assets) > maxHistoryAssets {
		result.Truncated = true
		result.Assets = result.Assets[:maxHistoryAssets]
	}
	if err := loadHistoryEvents(ctx, tx, result.Assets); err != nil {
		return result, err
	}
	// Pairs are shown only for assets whose history is complete: never claim a truncated
	// history is complete.
	complete := make([]*HistoryAsset, 0, len(result.Assets))
	for i := range result.Assets {
		if !result.Assets[i].Truncated {
			complete = append(complete, &result.Assets[i])
		}
	}
	if err := loadResalePairs(ctx, tx, complete); err != nil {
		return result, err
	}
	return result, nil
}

// ResaleSummary summarises the comparable resales whose later sale matches filter.
func (r *TransactionRepository) ResaleSummary(ctx context.Context, filter StatisticsFilter) (ResaleSummary, error) {
	var args queryArgs
	where, err := r.factFilter(ctx, "pair", filter, &args)
	if err != nil {
		return ResaleSummary{}, err
	}
	tx, err := database.BeginReadOnly(ctx, r.db, pgx.ReadCommitted)
	if err != nil {
		return ResaleSummary{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Country-wide history can otherwise exhaust Docker's /dev/shm through
	// parallel hash aggregation. Keep this optional report bounded to one worker;
	// this changes neither the population nor other requests' planner settings.
	if _, err := tx.Exec(ctx, "SET LOCAL max_parallel_workers_per_gather=0"); err != nil {
		return ResaleSummary{}, err
	}
	result, err := loadResaleSummary(ctx, tx, saleFactsTable(filter), where, args)
	if err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// loadResaleSummary summarises comparable resale intervals. where filters the later sale
// (alias pair) only: its predecessor may predate the selected period.
func loadResaleSummary(ctx context.Context, db database.Querier, factTable, where string, args []any) (ResaleSummary, error) {
	query := fmt.Sprintf(`SELECT count(*),count(DISTINCT (pair.identity_kind,pair.cadastral_municipality_code,pair.identity_number,pair.part_number)),
		CASE WHEN count(*)>=30 THEN percentile_cont(0.25) WITHIN GROUP(ORDER BY pair.interval_days) END,
		CASE WHEN count(*)>=30 THEN percentile_cont(0.5) WITHIN GROUP(ORDER BY pair.interval_days) END,
		CASE WHEN count(*)>=30 THEN percentile_cont(0.75) WITHIN GROUP(ORDER BY pair.interval_days) END,count(*)>=30
		FROM analytics.property_resale_pairs pair WHERE pair.comparable AND %s
		AND pair.transaction_id IN (SELECT transaction_id FROM %s)`, where, factTable)
	var result ResaleSummary
	err := db.QueryRow(ctx, query, args...).
		Scan(&result.PairCount, &result.AssetCount, &result.P25Days, &result.MedianDays, &result.P75Days, &result.IsPublishable)
	if err != nil {
		return ResaleSummary{}, fmt.Errorf("resale summary: %w", err)
	}
	return result, nil
}
