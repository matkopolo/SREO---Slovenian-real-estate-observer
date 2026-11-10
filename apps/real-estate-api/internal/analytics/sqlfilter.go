package analytics

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
)

// SQL identifiers. Queries interpolate only the constants and map values in this file (and
// literal column names in each query); request data always travels as a bound argument.
// Never interpolate request data into SQL.

func saleFactsTable(filter StatisticsFilter) string {
	switch filter.LandScope {
	case "broad":
		return "analytics.sale_facts_broad_land"
	case "all":
		return "analytics.sale_facts_all_land"
	case "agricultural":
		return "analytics.sale_facts_agricultural_land"
	case "forest":
		return "analytics.sale_facts_forest_land"
	case "unverified":
		return "analytics.sale_facts_unverified_land"
	case "mixed":
		return "analytics.sale_facts_mixed_land"
	case "other":
		return "analytics.sale_facts_other_land"
	default:
		return "analytics.sale_facts_strict_land"
	}
}

// geographyFactColumns are the fact-table columns holding each level's geography id.
var geographyFactColumns = map[string]string{
	"statistical_region": "statistical_region_id",
	"municipality":       "municipality_id",
	"city_district":      "city_district_id",
	"local_community":    "local_community_id",
	"settlement":         "settlement_id",
}

// geographyFactColumn returns the fact column for a level; "" for the country (no condition).
func geographyFactColumn(level string) (string, bool) {
	if level == "country" {
		return "", true
	}
	column, ok := geographyFactColumns[level]
	return column, ok
}

var recentSortColumns = map[string]string{"date": "contract_date", "price": "amount", "perSqm": "amount_per_sqm", "area": "area"}

func intervalSQL(interval string) (string, string) {
	switch interval {
	case "month":
		return "month", "1 month"
	case "quarter":
		return "quarter", "3 months"
	default:
		return "year", "1 year"
	}
}

// queryArgs collects positional query arguments. add appends a value and returns its
// placeholder, so no query depends on a fixed $n order.
type queryArgs []any

func (a *queryArgs) add(value any) string {
	*a = append(*a, value)
	return "$" + strconv.Itoa(len(*a))
}

// factFilter renders the common request filter (contract dates, property group, geography,
// area) as AND-ed conditions on a fact table aliased alias, appending its arguments to args.
// Every fact table (sale_facts*, rental_facts, property_resale_pairs) has these columns.
func (r *StatisticsRepository) factFilter(
	ctx context.Context, alias string, filter StatisticsFilter, args *queryArgs,
) (string, error) {
	column := func(name string) string { return alias + "." + name }
	var conditions []string
	if filter.FromDate != nil {
		conditions = append(conditions, column("contract_date")+" >= "+args.add(*filter.FromDate)+"::date")
	}
	if filter.ToDate != nil {
		conditions = append(conditions, column("contract_date")+" <= "+args.add(*filter.ToDate)+"::date")
	}
	if filter.PropertyGroup != "" {
		conditions = append(conditions, column("property_group")+" = "+args.add(filter.PropertyGroup))
	}
	if filter.GeographyID != nil {
		level, err := r.geographyLevel(ctx, *filter.GeographyID)
		if err != nil {
			return "", err
		}
		geographyColumn, ok := geographyFactColumn(level)
		if !ok {
			return "", fmt.Errorf("unsupported geography level %q", level)
		}
		if geographyColumn != "" {
			conditions = append(conditions, column(geographyColumn)+" = "+args.add(*filter.GeographyID)+"::bigint")
		}
	}
	if filter.MinArea != nil {
		conditions = append(conditions, column("area")+" >= "+args.add(*filter.MinArea)+"::float8")
	}
	if filter.MaxArea != nil {
		conditions = append(conditions, column("area")+" <= "+args.add(*filter.MaxArea)+"::float8")
	}
	if len(conditions) == 0 {
		return "TRUE", nil
	}
	return strings.Join(conditions, " AND "), nil
}

// geographyLevels remembers the level of each geography id. Ids are database identities that
// are never reused, so a remembered level cannot go stale.
type geographyLevels struct {
	mu   sync.RWMutex
	byID map[int64]string
}

func (r *StatisticsRepository) geographyLevel(ctx context.Context, id int64) (string, error) {
	r.levels.mu.RLock()
	level, ok := r.levels.byID[id]
	r.levels.mu.RUnlock()
	if ok {
		return level, nil
	}
	err := r.db.QueryRow(ctx, "SELECT level FROM analytics.geographic_units WHERE id=$1", id).Scan(&level)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrGeographyNotFound
	}
	if err != nil {
		return "", fmt.Errorf("resolve geography level: %w", err)
	}
	r.levels.mu.Lock()
	r.levels.byID[id] = level
	r.levels.mu.Unlock()
	return level, nil
}
