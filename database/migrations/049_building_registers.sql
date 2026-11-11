-- Building registers that join ETN sales by the cadastral key (cadastral municipality,
-- building, part of building). None of them carries owner or contracting-party data;
-- the owner files in the GURS archives are never opened (see registers.py).

-- Register energetskih izkaznic (Ministry of the Environment, Climate and Energy): one row
-- per certificate and part of building (one certificate can cover several parts). Several
-- certificates can exist for one key (a renewed one, a building-level and a unit-level one);
-- the API shows the newest valid one.
CREATE TABLE IF NOT EXISTS analytics.energy_certificates (
    certificate_id text NOT NULL,             -- ID energetske izkaznice
    issued_on date NOT NULL,                  -- Datum izdelave
    valid_until date,                         -- Velja do (ten years)
    cadastral_code integer NOT NULL,          -- Šifra KO
    building_number integer NOT NULL,         -- Številka stavbe
    part_number integer NOT NULL,             -- Številka dela stavbe; 0 = the whole building
    certificate_type text NOT NULL,           -- 'computed' (računska) or 'measured' (merjena)
    energy_class text,                        -- A1 … G; measured certificates carry none
    heating_demand numeric,                   -- kWh/m²a (computed) or kWh/a (measured)
    delivered_energy numeric,
    total_energy numeric,
    electricity numeric,
    primary_energy numeric,
    co2 numeric,                              -- kg/m²a (computed) or kg/a (measured)
    conditioned_area numeric,                 -- m²
    building_use text,                        -- EPBD category (STANOVANJE, HISA, BLOKI, …)
    source_date date NOT NULL,                -- "stanje na dan" of the register export
    PRIMARY KEY (certificate_id, cadastral_code, building_number, part_number)
);
CREATE INDEX IF NOT EXISTS energy_certificates_building_idx
    ON analytics.energy_certificates (cadastral_code, building_number);

-- GURS Kataster nepremičnin, parts of buildings (deli stavb) from the same national
-- snapshot as cadastre_buildings; replaced as a whole together with it.
CREATE TABLE IF NOT EXISTS analytics.cadastre_building_parts (
    eid text PRIMARY KEY,                     -- EID_DEL_STAVBE
    building_eid text NOT NULL,               -- EID_STAVBA = cadastre_buildings.eid
    part_number integer NOT NULL,             -- ST_DELA_STAVBE
    actual_use integer,                       -- VRSTA_DEJANSKE_RABE_DEL_ST_ID (cadastre_codebooks 'actual_use')
    elevator boolean,                         -- DVIGALO
    windows_renovated integer,                -- LETO_OBNOVE_OKEN
    installations_renovated integer,          -- LETO_OBNOVE_INSTALACIJ
    area numeric,                             -- POVRSINA, m²
    usable_area numeric,                      -- UPORABNA_POVRSINA, m²
    record_changed_on date,                   -- DATUM_SYS
    source_date date NOT NULL
);
CREATE INDEX IF NOT EXISTS cadastre_building_parts_building_idx
    ON analytics.cadastre_building_parts (building_eid, part_number);

-- The building snapshot also carries the two building-level renovation years.
ALTER TABLE analytics.cadastre_buildings ADD COLUMN IF NOT EXISTS facade_renovated integer;  -- LETO_OBNOVE_FASADE
ALTER TABLE analytics.cadastre_buildings ADD COLUMN IF NOT EXISTS roof_renovated integer;    -- LETO_OBNOVE_STREHE

-- GURS Evidenca vrednotenja: the official generalised value (posplošena vrednost) of every
-- part of building, from the per-municipality weekly exports. Public by ZMVN-1 Art. 44(3);
-- the owner, right and person files of the export are never read.
CREATE TABLE IF NOT EXISTS analytics.generalised_values (
    part_eid text PRIMARY KEY,                -- EID_DEL_STAVBE
    building_eid text NOT NULL,               -- EID_STAVBA
    cadastral_code integer NOT NULL,          -- KO_SIFKO
    building_number integer NOT NULL,         -- STEV_ST
    part_number integer NOT NULL,             -- STEV_DST
    model text NOT NULL,                      -- ID_MODEL (STA, HIS, GAR, …; register_codebooks 'valuation_model')
    value_level text,                         -- RAVEN "level/levels" within the model
    value numeric,                            -- POSPLOSENA_VREDNOST, €; null when GURS has no value
    floor integer,                            -- ST_NADSTROPJA
    position integer,                         -- ID_LEGA (register_codebooks 'position')
    municipality_code integer NOT NULL,       -- RPE_OBCINE_SIFRA
    source_date date NOT NULL                 -- date in the export file name
);
CREATE INDEX IF NOT EXISTS generalised_values_building_idx
    ON analytics.generalised_values (cadastral_code, building_number);
CREATE INDEX IF NOT EXISTS generalised_values_municipality_idx
    ON analytics.generalised_values (municipality_code);

-- Labels for text-coded register columns (valuation models STA, HIS, …; positions in a building).
CREATE TABLE IF NOT EXISTS analytics.register_codebooks (
    codebook text NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    PRIMARY KEY (codebook, code)
);

-- DRSV Integralna karta razredov poplavne nevarnosti (IKRPN): the legally operative flood
-- hazard classes, and the areas where a hydraulic study exists at all. Outside the studied
-- areas "no class" means "not studied", never "safe".
CREATE TABLE IF NOT EXISTS analytics.flood_hazard_zones (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hazard_class text NOT NULL CHECK (hazard_class IN ('Pp', 'Pm', 'Ps', 'Pv')),
    source_id text,                           -- PM_ID / PS_ID / PV_ID / PP_ID
    valid_from date,                          -- DATP_ZAC: when this version of the polygon took effect
    geom geometry(MultiPolygon, 3794) NOT NULL,
    source_date date NOT NULL                 -- DBF last-update date of the shapefile
);
CREATE INDEX IF NOT EXISTS flood_hazard_zones_geom_idx ON analytics.flood_hazard_zones USING gist (geom);
CREATE INDEX IF NOT EXISTS flood_hazard_zones_class_idx ON analytics.flood_hazard_zones (hazard_class);
-- max(source_date) runs on every sale detail; without an index it scans ~720 k rows.
CREATE INDEX IF NOT EXISTS flood_hazard_zones_source_date_idx ON analytics.flood_hazard_zones (source_date);

-- The same classes dissolved for drawing: the source polygons are raster-like fragments (median
-- 4 m²), so they are unioned per class within 2 km tiles and lightly simplified at import.
CREATE TABLE IF NOT EXISTS analytics.flood_hazard_areas (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hazard_class text NOT NULL CHECK (hazard_class IN ('Pp', 'Pm', 'Ps', 'Pv')),
    geom geometry(MultiPolygon, 3794) NOT NULL,
    source_date date NOT NULL
);
CREATE INDEX IF NOT EXISTS flood_hazard_areas_geom_idx ON analytics.flood_hazard_areas USING gist (geom);

CREATE TABLE IF NOT EXISTS analytics.flood_study_areas (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text,                                -- OBMHHM_IME
    valid_from date,
    geom geometry(MultiPolygon, 3794) NOT NULL,
    source_date date NOT NULL
);
CREATE INDEX IF NOT EXISTS flood_study_areas_geom_idx ON analytics.flood_study_areas USING gist (geom);

GRANT SELECT ON analytics.energy_certificates, analytics.cadastre_building_parts,
    analytics.generalised_values, analytics.register_codebooks, analytics.flood_hazard_zones,
    analytics.flood_hazard_areas, analytics.flood_study_areas TO real_estate_api;
