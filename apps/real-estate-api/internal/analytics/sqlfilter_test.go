package analytics

import (
	"context"
	"testing"
	"time"
)

func TestGeographyFactColumn(t *testing.T) {
	tests := []struct {
		level  string
		column string
		ok     bool
	}{
		{"country", "", true},
		{"statistical_region", "statistical_region_id", true},
		{"municipality", "municipality_id", true},
		{"city_district", "city_district_id", true},
		{"local_community", "local_community_id", true},
		{"settlement", "settlement_id", true},
		{"unknown", "", false},
	}
	for _, test := range tests {
		t.Run(test.level, func(t *testing.T) {
			column, ok := geographyFactColumn(test.level)
			if column != test.column || ok != test.ok {
				t.Fatalf("geographyFactColumn(%q)=(%q,%t), want (%q,%t)",
					test.level, column, ok, test.column, test.ok)
			}
		})
	}
}

func TestFactFilterNumbersItsOwnPlaceholders(t *testing.T) {
	repository := &StatisticsRepository{levels: geographyLevels{byID: map[int64]string{7: "municipality", 1: "country"}}}
	from := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	minimum := 40.0
	geography := int64(7)
	args := queryArgs{"already bound"}
	where, err := repository.factFilter(context.Background(), "fact", StatisticsFilter{
		FromDate: &from, PropertyGroup: "apartment", GeographyID: &geography, MinArea: &minimum,
	}, &args)
	if err != nil {
		t.Fatal(err)
	}
	want := "fact.contract_date >= $2::date AND fact.property_group = $3 AND fact.municipality_id = $4::bigint AND fact.area >= $5::float8"
	if where != want {
		t.Fatalf("where=%q\nwant=%q", where, want)
	}
	if len(args) != 5 || args[2] != "apartment" || args[3] != geography || args[4] != minimum {
		t.Fatalf("args=%v", args)
	}
	if placeholder := args.add(10); placeholder != "$6" {
		t.Fatalf("next placeholder=%s", placeholder)
	}

	country := int64(1)
	args = nil
	where, err = repository.factFilter(context.Background(), "f", StatisticsFilter{GeographyID: &country}, &args)
	if err != nil || where != "TRUE" || len(args) != 0 {
		t.Fatalf("country filter where=%q args=%v err=%v", where, args, err)
	}
}
