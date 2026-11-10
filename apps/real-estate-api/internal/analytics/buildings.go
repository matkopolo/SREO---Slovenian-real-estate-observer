package analytics

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrBuildingNotFound = errors.New("building not found")

type BuildingMarketSummary struct {
	TransactionCount    int64    `json:"transactionCount"`
	RepresentativeCount int64    `json:"representativeCount"`
	MedianAmount        *float64 `json:"medianAmount"`
	MedianAmountPerSQM  *float64 `json:"medianAmountPerSqm"`
	FirstContractDate   *string  `json:"firstContractDate"`
	LastContractDate    *string  `json:"lastContractDate"`
}

type BuildingYearPoint struct {
	Year                int      `json:"year"`
	TransactionCount    int64    `json:"transactionCount"`
	RepresentativeCount int64    `json:"representativeCount"`
	MedianAmountPerSQM  *float64 `json:"medianAmountPerSqm"`
	MedianAmount        *float64 `json:"medianAmount"`
}

type BuildingTransaction struct {
	TransactionID int64    `json:"transactionId"`
	ContractDate  *string  `json:"contractDate"`
	PropertyGroup string   `json:"propertyGroup"`
	Area          *float64 `json:"area"`
	Amount        *float64 `json:"amount"`
	AmountPerSQM  *float64 `json:"amountPerSqm"`
	// Representative tells whether the agreement enters the published statistics.
	Representative bool `json:"representative"`
}

type BuildingSearchResult struct {
	CadastralMunicipalityCode int32            `json:"cadastralMunicipalityCode"`
	BuildingNumber            string           `json:"buildingNumber"`
	Settlement                *string          `json:"settlement"`
	Street                    *string          `json:"street"`
	HouseNumber               *string          `json:"houseNumber"`
	HouseNumberSuffix         *string          `json:"houseNumberSuffix"`
	Longitude                 float64          `json:"longitude"`
	Latitude                  float64          `json:"latitude"`
	SaleCount                 int64            `json:"saleCount"`
	RentalCount               int64            `json:"rentalCount"`
	SaleCounts                map[string]int64 `json:"saleCounts"`
	RentalCounts              map[string]int64 `json:"rentalCounts"`
}

type BuildingStatistics struct {
	CadastralMunicipalityCode int32                 `json:"cadastralMunicipalityCode"`
	BuildingNumber            string                `json:"buildingNumber"`
	ConstructionYear          *int32                `json:"constructionYear"`
	KnownBuildingPartCount    int64                 `json:"knownBuildingPartCount"`
	Settlement                *string               `json:"settlement"`
	Street                    *string               `json:"street"`
	HouseNumber               *string               `json:"houseNumber"`
	HouseNumberSuffix         *string               `json:"houseNumberSuffix"`
	Longitude                 *float64              `json:"longitude"`
	Latitude                  *float64              `json:"latitude"`
	Sales                     BuildingMarketSummary `json:"sales"`
	Rentals                   BuildingMarketSummary `json:"rentals"`
	SaleHistory               []BuildingYearPoint   `json:"saleHistory"`
	RentalHistory             []BuildingYearPoint   `json:"rentalHistory"`
	SaleTransactions          []BuildingTransaction `json:"saleTransactions"`
	RentalTransactions        []BuildingTransaction `json:"rentalTransactions"`
}

type BuildingFilter struct {
	PropertyGroup string
	FromDate      *time.Time
	ToDate        *time.Time
}

type BuildingStore interface {
	BuildingStatistics(context.Context, int32, string, BuildingFilter) (BuildingStatistics, error)
	SearchBuildings(context.Context, string, int, BuildingFilter) (BuildingSearch, error)
}

func (r *BuildingRepository) BuildingStatistics(
	ctx context.Context, cadastralCode int32, buildingNumber string,
	filter BuildingFilter,
) (BuildingStatistics, error) {
	result := BuildingStatistics{
		CadastralMunicipalityCode: cadastralCode,
		BuildingNumber:            buildingNumber,
		SaleHistory:               []BuildingYearPoint{},
		RentalHistory:             []BuildingYearPoint{},
		SaleTransactions:          []BuildingTransaction{},
		RentalTransactions:        []BuildingTransaction{},
	}
	err := r.db.QueryRow(ctx, `
		WITH parts AS (
		  SELECT construction_year,building_part_number,location,settlement,street,house_number::text house_number,house_number_suffix
		  FROM building_parts
		  WHERE cadastral_municipality_code=$1 AND building_number=$2
		  UNION ALL
		  SELECT construction_year,building_part_number,location,settlement,street,house_number::text,house_number_suffix
		  FROM rental_building_parts
		  WHERE cadastral_municipality_code=$1 AND building_number=$2
		)
		SELECT min(construction_year),
		  count(DISTINCT building_part_number) FILTER(WHERE building_part_number IS NOT NULL),
		  mode() WITHIN GROUP (ORDER BY settlement),mode() WITHIN GROUP (ORDER BY street),
		  mode() WITHIN GROUP (ORDER BY house_number),mode() WITHIN GROUP (ORDER BY house_number_suffix),
		  ST_X(ST_Transform(ST_Centroid(ST_Collect(location)),4326)),
		  ST_Y(ST_Transform(ST_Centroid(ST_Collect(location)),4326))
		FROM parts HAVING count(*)>0`, cadastralCode, buildingNumber).Scan(
		&result.ConstructionYear, &result.KnownBuildingPartCount,
		&result.Settlement, &result.Street, &result.HouseNumber, &result.HouseNumberSuffix,
		&result.Longitude, &result.Latitude)
	if errors.Is(err, pgx.ErrNoRows) {
		return BuildingStatistics{}, ErrBuildingNotFound
	}
	if err != nil {
		return BuildingStatistics{}, fmt.Errorf("load building identity: %w", err)
	}
	if err := r.loadBuildingSummary(ctx, "analytics.sale_facts_strict_land", "price",
		"price_per_sqm", cadastralCode, buildingNumber, filter, &result.Sales); err != nil {
		return BuildingStatistics{}, err
	}
	if err := r.loadBuildingSummary(ctx, "analytics.rental_facts",
		"monthly_rent_ex_vat", "monthly_rent_per_sqm", cadastralCode,
		buildingNumber, filter, &result.Rentals); err != nil {
		return BuildingStatistics{}, err
	}
	result.SaleHistory, err = r.loadBuildingHistory(ctx, "analytics.sale_facts_strict_land",
		"price", "price_per_sqm", cadastralCode, buildingNumber, filter)
	if err != nil {
		return BuildingStatistics{}, err
	}
	result.RentalHistory, err = r.loadBuildingHistory(ctx, "analytics.rental_facts",
		"monthly_rent_ex_vat", "monthly_rent_per_sqm", cadastralCode, buildingNumber, filter)
	if err != nil {
		return BuildingStatistics{}, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT transaction_id,contract_date::text,property_group,area::float8,
		  price::float8,price_per_sqm::float8,representative_eligible
		FROM analytics.sale_facts_strict_land
		WHERE cadastral_municipality_code=$1 AND building_number=$2
		  AND ($3='' OR property_group=$3)
		  AND ($4::date IS NULL OR contract_date>=$4)
		  AND ($5::date IS NULL OR contract_date<=$5)
		ORDER BY contract_date DESC NULLS LAST,transaction_id`,
		cadastralCode, buildingNumber, filter.PropertyGroup,
		filter.FromDate, filter.ToDate)
	if err != nil {
		return BuildingStatistics{}, fmt.Errorf("load building sale transactions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var item BuildingTransaction
		if err := rows.Scan(&item.TransactionID, &item.ContractDate,
			&item.PropertyGroup, &item.Area, &item.Amount,
			&item.AmountPerSQM, &item.Representative); err != nil {
			return BuildingStatistics{}, fmt.Errorf("scan building sale transaction: %w", err)
		}
		result.SaleTransactions = append(result.SaleTransactions, item)
	}
	if err := rows.Err(); err != nil {
		return BuildingStatistics{}, err
	}
	rows.Close()
	rentalRows, err := r.db.Query(ctx, `
		SELECT transaction_id,contract_date::text,property_group,area::float8,
		  monthly_rent_ex_vat::float8,monthly_rent_per_sqm::float8,representative_eligible
		FROM analytics.rental_facts
		WHERE cadastral_municipality_code=$1 AND building_number=$2
		  AND ($3='' OR property_group=$3)
		  AND ($4::date IS NULL OR contract_date>=$4)
		  AND ($5::date IS NULL OR contract_date<=$5)
		ORDER BY contract_date DESC NULLS LAST,transaction_id`,
		cadastralCode, buildingNumber, filter.PropertyGroup,
		filter.FromDate, filter.ToDate)
	if err != nil {
		return BuildingStatistics{}, fmt.Errorf("load building rental transactions: %w", err)
	}
	defer rentalRows.Close()
	for rentalRows.Next() {
		var item BuildingTransaction
		if err := rentalRows.Scan(&item.TransactionID, &item.ContractDate,
			&item.PropertyGroup, &item.Area, &item.Amount,
			&item.AmountPerSQM, &item.Representative); err != nil {
			return BuildingStatistics{}, fmt.Errorf("scan building rental transaction: %w", err)
		}
		result.RentalTransactions = append(result.RentalTransactions, item)
	}
	return result, rentalRows.Err()
}

func (r *BuildingRepository) loadBuildingSummary(
	ctx context.Context, table, amount, perSQM string, code int32,
	number string, filter BuildingFilter, result *BuildingMarketSummary,
) error {
	query := fmt.Sprintf(`
		SELECT count(*)::bigint,
		  count(*) FILTER(WHERE representative_eligible)::bigint,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY %s)
		    FILTER(WHERE representative_eligible)::float8,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY %s)
		    FILTER(WHERE representative_eligible)::float8,
		  min(contract_date)::text,max(contract_date)::text
		FROM %s WHERE cadastral_municipality_code=$1 AND building_number=$2
		  AND ($3='' OR property_group=$3)
		  AND ($4::date IS NULL OR contract_date>=$4)
		  AND ($5::date IS NULL OR contract_date<=$5)`,
		amount, perSQM, table)
	if err := r.db.QueryRow(ctx, query, code, number, filter.PropertyGroup,
		filter.FromDate, filter.ToDate).Scan(
		&result.TransactionCount, &result.RepresentativeCount,
		&result.MedianAmount, &result.MedianAmountPerSQM,
		&result.FirstContractDate, &result.LastContractDate); err != nil {
		return fmt.Errorf("load building market summary: %w", err)
	}
	return nil
}

func (r *BuildingRepository) loadBuildingHistory(
	ctx context.Context, table, amount, perSQM string, code int32, number string,
	filter BuildingFilter,
) ([]BuildingYearPoint, error) {
	query := fmt.Sprintf(`
		SELECT extract(year FROM contract_date)::integer,count(*)::bigint,
		  count(*) FILTER(WHERE representative_eligible)::bigint,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY %s)
		    FILTER(WHERE representative_eligible)::float8,
		  percentile_cont(.5) WITHIN GROUP(ORDER BY %s)
		    FILTER(WHERE representative_eligible)::float8
		FROM %s
		WHERE cadastral_municipality_code=$1 AND building_number=$2
		  AND contract_date IS NOT NULL
		  AND ($3='' OR property_group=$3)
		  AND ($4::date IS NULL OR contract_date>=$4)
		  AND ($5::date IS NULL OR contract_date<=$5)
		GROUP BY 1 ORDER BY 1`, perSQM, amount, table)
	rows, err := r.db.Query(ctx, query, code, number, filter.PropertyGroup,
		filter.FromDate, filter.ToDate)
	if err != nil {
		return nil, fmt.Errorf("load building history: %w", err)
	}
	defer rows.Close()
	items := make([]BuildingYearPoint, 0)
	for rows.Next() {
		var item BuildingYearPoint
		if err := rows.Scan(&item.Year, &item.TransactionCount,
			&item.RepresentativeCount, &item.MedianAmountPerSQM, &item.MedianAmount); err != nil {
			return nil, fmt.Errorf("scan building history: %w", err)
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
