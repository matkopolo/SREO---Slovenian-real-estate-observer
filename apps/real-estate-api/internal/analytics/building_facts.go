package analytics

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"

	"github.com/jackc/pgx/v5"
)

// BuildingFacts are the official register facts about the sold unit and its building that
// join ETN by the cadastral key: the energy certificate, the cadastre's renovation and
// equipment data, GURS's generalised value and the DRSV flood hazard class. Each block is
// nil when its register has nothing for this building; none of them names an owner.
type BuildingFacts struct {
	EnergyCertificate *EnergyCertificate `json:"energyCertificate"`
	// BuildingEnergyClasses lists the distinct classes of every valid certificate in the
	// building (newest per unit), ordered from best to worst; empty when there are none.
	BuildingEnergyClasses []string          `json:"buildingEnergyClasses"`
	BuildingCertificates  int               `json:"buildingCertificates"`
	Cadastre              *CadastreFacts    `json:"cadastre"`
	GeneralisedValue      *GeneralisedValue `json:"generalisedValue"`
	Flood                 *FloodHazard      `json:"flood"`
}

// EnergyCertificate is the newest valid certificate for the unit, or for the whole building
// when the unit has none (Scope says which).
type EnergyCertificate struct {
	ID          string  `json:"id"`
	Scope       string  `json:"scope"` // "unit" or "building"
	Type        string  `json:"type"`  // "computed" (računska) or "measured" (merjena)
	Class       *string `json:"class"` // A1 … G; measured certificates carry none
	IssuedOn    string  `json:"issuedOn"`
	ValidUntil  *string `json:"validUntil"`
	BuildingUse *string `json:"buildingUse"`
	// Indicators are per m² of conditioned area for computed certificates and absolute per
	// year for measured ones, so they are only shown with the type.
	HeatingDemand   *float64 `json:"heatingDemand"`
	PrimaryEnergy   *float64 `json:"primaryEnergy"`
	CO2             *float64 `json:"co2"`
	ConditionedArea *float64 `json:"conditionedArea"`
	SourceDate      string   `json:"sourceDate"`
}

// CadastreFacts come from the GURS Kataster nepremičnin snapshot: the building row and, when
// the sale names a part the cadastre knows, that part's row.
type CadastreFacts struct {
	BuildingEID            string `json:"buildingEid"`
	YearBuilt              *int32 `json:"yearBuilt"`
	Floors                 *int32 `json:"floors"`
	Dwellings              *int32 `json:"dwellings"`
	FacadeRenovated        *int32 `json:"facadeRenovated"`
	RoofRenovated          *int32 `json:"roofRenovated"`
	UnitKnown              bool   `json:"unitKnown"`
	WindowsRenovated       *int32 `json:"windowsRenovated"`
	InstallationsRenovated *int32 `json:"installationsRenovated"`
	// Elevator is the unit's own entry, or the building's when the unit has none (true when
	// any unit reports one, false when every unit that answered said no).
	Elevator   *bool    `json:"elevator"`
	ActualUse  *string  `json:"actualUse"`
	Area       *float64 `json:"area"`
	UsableArea *float64 `json:"usableArea"`
	SourceDate string   `json:"sourceDate"`
}

// GeneralisedValue is GURS's posplošena vrednost of the sold unit (and, for a package, the
// sum over the sold parts that have one), from the evidenca vrednotenja export.
type GeneralisedValue struct {
	Value        *float64 `json:"value"`
	Model        string   `json:"model"`
	ModelLabel   *string  `json:"modelLabel"`
	ValueLevel   *string  `json:"valueLevel"`
	Floor        *int32   `json:"floor"`
	Position     *string  `json:"position"`
	PackageValue *float64 `json:"packageValue"`
	PackageParts int      `json:"packageParts"`
	// ValuationDate is the market date the current models describe (Uredba 2025).
	ValuationDate string `json:"valuationDate"`
	SourceDate    string `json:"sourceDate"`
}

// FloodHazard places the building's centroid in the DRSV flood hazard map. Studied is false
// where no hydraulic study exists: there "no class" means "not studied", not "safe".
type FloodHazard struct {
	HazardClass *string `json:"hazardClass"` // Pv (velika), Ps (srednja), Pm (majhna), Pp (preostala)
	Studied     bool    `json:"studied"`
	SourceDate  string  `json:"sourceDate"`
}

// The market date of the valuation models in force (Uredba o določitvi modelov vrednotenja, 2025).
const generalisedValueDate = "2025-01-01"

var energyClassOrder = map[string]int{"A1": 0, "A2": 1, "B1": 2, "B2": 3, "C": 4, "D": 5, "E": 6, "F": 7, "G": 8}

// mainSalePart is the unit the agreement is about: the largest sold part (a flat rather than
// its storage room), as the frontend chooses it.
func mainSalePart(parts []SaleBuildingPart) *SaleBuildingPart {
	var best *SaleBuildingPart
	size := func(part *SaleBuildingPart) float64 {
		for _, value := range []*float64{part.SoldArea, part.BuildingPartArea, part.UsableArea} {
			if value != nil {
				return *value
			}
		}
		return 0
	}
	for index := range parts {
		if best == nil || size(&parts[index]) > size(best) {
			best = &parts[index]
		}
	}
	return best
}

// cadastralKey turns the sale's text identifiers into the registers' integer key. The part
// number is 0 when the sale names none or a non-numeric one (then only building rows match).
func cadastralKey(part *SaleBuildingPart) (cadastral int32, building int64, unit int64, ok bool) {
	if part == nil || part.CadastralMunicipalityCode == nil || part.BuildingNumber == nil {
		return 0, 0, 0, false
	}
	building, err := strconv.ParseInt(*part.BuildingNumber, 10, 64)
	if err != nil {
		return 0, 0, 0, false
	}
	if part.BuildingPartNumber != nil {
		unit, _ = strconv.ParseInt(*part.BuildingPartNumber, 10, 64)
	}
	return *part.CadastralMunicipalityCode, building, unit, true
}

// loadBuildingFacts gathers the register facts for a sale inside its read-only transaction.
// A register with no row for the building leaves its block nil; the flood block needs the
// sale's location and a loaded flood map.
func loadBuildingFacts(ctx context.Context, tx pgx.Tx, id int64, parts []SaleBuildingPart) (*BuildingFacts, error) {
	cadastral, building, unit, ok := cadastralKey(mainSalePart(parts))
	if !ok {
		return nil, nil
	}
	facts := &BuildingFacts{BuildingEnergyClasses: []string{}}
	var err error
	if facts.EnergyCertificate, facts.BuildingEnergyClasses, facts.BuildingCertificates, err =
		loadEnergyCertificates(ctx, tx, cadastral, building, unit); err != nil {
		return nil, err
	}
	if facts.Cadastre, err = loadCadastreFacts(ctx, tx, cadastral, building, unit); err != nil {
		return nil, err
	}
	if facts.GeneralisedValue, err = loadGeneralisedValue(ctx, tx, cadastral, building, unit, parts); err != nil {
		return nil, err
	}
	if facts.Flood, err = loadFloodHazard(ctx, tx, id); err != nil {
		return nil, err
	}
	if facts.EnergyCertificate == nil && facts.Cadastre == nil && facts.GeneralisedValue == nil && facts.Flood == nil {
		return nil, nil
	}
	return facts, nil
}

func loadEnergyCertificates(ctx context.Context, tx pgx.Tx, cadastral int32, building, unit int64) (*EnergyCertificate, []string, int, error) {
	rows, err := tx.Query(ctx, `
		SELECT certificate_id, part_number, certificate_type, energy_class, issued_on::text, valid_until::text,
		  building_use, heating_demand::float8, primary_energy::float8, co2::float8, conditioned_area::float8,
		  source_date::text
		FROM analytics.energy_certificates
		WHERE cadastral_code=$1 AND building_number=$2 AND (valid_until IS NULL OR valid_until >= current_date)
		ORDER BY issued_on DESC, certificate_id DESC`, cadastral, building)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("load energy certificates: %w", err)
	}
	defer rows.Close()
	var chosen, whole *EnergyCertificate
	seen := map[int64]bool{}
	classes := map[string]bool{}
	for rows.Next() {
		var item EnergyCertificate
		var part int64
		if err := rows.Scan(&item.ID, &part, &item.Type, &item.Class, &item.IssuedOn, &item.ValidUntil,
			&item.BuildingUse, &item.HeatingDemand, &item.PrimaryEnergy, &item.CO2, &item.ConditionedArea,
			&item.SourceDate); err != nil {
			return nil, nil, 0, fmt.Errorf("scan energy certificate: %w", err)
		}
		if seen[part] { // rows arrive newest first: one certificate counts per unit
			continue
		}
		seen[part] = true
		if item.Class != nil {
			classes[*item.Class] = true
		}
		switch {
		case part == unit && unit != 0 && chosen == nil:
			item.Scope = "unit"
			chosen = &item
		case part == 0 && whole == nil:
			item.Scope = "building"
			whole = &item
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, 0, err
	}
	if chosen == nil {
		chosen = whole
	}
	ordered := make([]string, 0, len(classes))
	for class := range classes {
		ordered = append(ordered, class)
	}
	sort.Slice(ordered, func(i, j int) bool { return energyClassOrder[ordered[i]] < energyClassOrder[ordered[j]] })
	return chosen, ordered, len(seen), nil
}

func loadCadastreFacts(ctx context.Context, tx pgx.Tx, cadastral int32, building, unit int64) (*CadastreFacts, error) {
	var facts CadastreFacts
	var partEID *string
	err := tx.QueryRow(ctx, `
		SELECT b.eid, b.year_built, b.floors, b.dwellings, b.facade_renovated, b.roof_renovated, b.source_date::text,
		  p.eid, p.windows_renovated, p.installations_renovated,
		  coalesce(p.elevator, (SELECT bool_or(elevator) FROM analytics.cadastre_building_parts q WHERE q.building_eid=b.eid)),
		  u.label, p.area::float8, p.usable_area::float8
		FROM analytics.cadastre_buildings b
		LEFT JOIN LATERAL (
		  SELECT * FROM analytics.cadastre_building_parts q WHERE q.building_eid=b.eid AND q.part_number=$3 AND $3 > 0
		  ORDER BY q.record_changed_on DESC NULLS LAST LIMIT 1
		) p ON true
		LEFT JOIN analytics.cadastre_codebooks u ON u.codebook='actual_use' AND u.code=p.actual_use
		WHERE b.cadastral_code=$1 AND b.building_number=$2
		ORDER BY b.record_changed_on DESC NULLS LAST LIMIT 1`, cadastral, building, unit).Scan(
		&facts.BuildingEID, &facts.YearBuilt, &facts.Floors, &facts.Dwellings, &facts.FacadeRenovated,
		&facts.RoofRenovated, &facts.SourceDate, &partEID, &facts.WindowsRenovated, &facts.InstallationsRenovated,
		&facts.Elevator, &facts.ActualUse, &facts.Area, &facts.UsableArea)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load cadastre facts: %w", err)
	}
	facts.UnitKnown = partEID != nil
	return &facts, nil
}

func loadGeneralisedValue(ctx context.Context, tx pgx.Tx, cadastral int32, building, unit int64, parts []SaleBuildingPart) (*GeneralisedValue, error) {
	var value GeneralisedValue
	err := tx.QueryRow(ctx, `
		SELECT v.value::float8, v.model, m.label, v.value_level, v.floor, l.label, v.source_date::text
		FROM analytics.generalised_values v
		LEFT JOIN analytics.register_codebooks m ON m.codebook='valuation_model' AND m.code=v.model
		LEFT JOIN analytics.register_codebooks l ON l.codebook='position' AND l.code=v.position::text
		WHERE v.cadastral_code=$1 AND v.building_number=$2 AND v.part_number=$3`, cadastral, building, unit).Scan(
		&value.Value, &value.Model, &value.ModelLabel, &value.ValueLevel, &value.Floor, &value.Position, &value.SourceDate)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load generalised value: %w", err)
	}
	value.ValuationDate = generalisedValueDate
	// A package (flat + storage + parking) is worth the sum of its parts' official values.
	if len(parts) > 1 {
		for _, part := range parts {
			partCadastral, partBuilding, partUnit, ok := cadastralKey(&part)
			if !ok || partUnit == 0 {
				continue
			}
			var partValue *float64
			err := tx.QueryRow(ctx, `SELECT value::float8 FROM analytics.generalised_values
				WHERE cadastral_code=$1 AND building_number=$2 AND part_number=$3`, partCadastral, partBuilding, partUnit).Scan(&partValue)
			if errors.Is(err, pgx.ErrNoRows) || partValue == nil {
				continue
			}
			if err != nil {
				return nil, fmt.Errorf("load package generalised value: %w", err)
			}
			if value.PackageValue == nil {
				value.PackageValue = new(float64)
			}
			*value.PackageValue += *partValue
			value.PackageParts++
		}
		if value.PackageParts < 2 {
			value.PackageValue, value.PackageParts = nil, 0
		}
	}
	return &value, nil
}

func loadFloodHazard(ctx context.Context, tx pgx.Tx, id int64) (*FloodHazard, error) {
	var hazard FloodHazard
	var sourceDate *string
	err := tx.QueryRow(ctx, `
		SELECT (SELECT z.hazard_class FROM analytics.flood_hazard_zones z WHERE ST_Intersects(z.geom, f.location)
		          ORDER BY array_position(ARRAY['Pv','Ps','Pm','Pp'], z.hazard_class) LIMIT 1),
		       EXISTS (SELECT 1 FROM analytics.flood_study_areas a WHERE ST_Intersects(a.geom, f.location)),
		       (SELECT max(source_date)::text FROM analytics.flood_hazard_zones)
		FROM analytics.sale_facts f WHERE f.transaction_id=$1 AND f.location IS NOT NULL`, id).Scan(
		&hazard.HazardClass, &hazard.Studied, &sourceDate)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && sourceDate == nil) {
		return nil, nil // no location, or the flood map is not loaded
	}
	if err != nil {
		return nil, fmt.Errorf("load flood hazard: %w", err)
	}
	hazard.SourceDate = *sourceDate
	if hazard.HazardClass != nil {
		hazard.Studied = true
	}
	return &hazard, nil
}
