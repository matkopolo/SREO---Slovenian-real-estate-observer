-- "Gradbeni projekti" v1: official construction sources, kept separate from ETN facts.
-- Building ownership files in the GURS archive are deliberately not imported.

-- GURS Kataster nepremičnin: one row per registered building (weekly national snapshot).
CREATE TABLE IF NOT EXISTS analytics.cadastre_buildings (
    eid text PRIMARY KEY,                     -- EID_STAVBA
    cadastral_code integer NOT NULL,          -- KO_ID
    building_number integer NOT NULL,         -- ST_STAVBE
    year_built integer,                       -- LETO_IZGRADNJE
    floors integer,
    dwellings integer,
    business_units integer,
    building_type integer,                    -- TIPI_STAVB
    load_bearing_structure integer,           -- NOSILNE_KONSTRUKCIJE
    registration_status integer,              -- STATUSI_VPISA_STAVBE
    gross_floor_area numeric,                 -- BRUTO_TLORISNA_POVRSINA (m2)
    municipality_eid text,                    -- RPE municipality, = geographic_units.gurs_eid
    record_changed_on date,                   -- DATUM_SYS: last change of the record
    location geometry(Point, 3794),
    source_date date NOT NULL                 -- date in the GURS file name
);
CREATE INDEX IF NOT EXISTS cadastre_buildings_identity_idx
    ON analytics.cadastre_buildings (cadastral_code, building_number);
CREATE INDEX IF NOT EXISTS cadastre_buildings_year_idx ON analytics.cadastre_buildings (year_built);
CREATE INDEX IF NOT EXISTS cadastre_buildings_municipality_idx ON analytics.cadastre_buildings (municipality_eid);
CREATE INDEX IF NOT EXISTS cadastre_buildings_location_idx ON analytics.cadastre_buildings USING gist (location);

-- Labels for the cadastre codes above, as published with the archive.
CREATE TABLE IF NOT EXISTS analytics.cadastre_codebooks (
    codebook text NOT NULL,
    code integer NOT NULL,
    label text NOT NULL,
    PRIMARY KEY (codebook, code)
);

-- EU TED notices for construction works (CPV 45*) bought by Slovenian authorities.
CREATE TABLE IF NOT EXISTS analytics.public_works_notices (
    publication_number text PRIMARY KEY,
    notice_type text NOT NULL,
    publication_date date NOT NULL,
    title text NOT NULL,
    buyer text,
    winners text[] NOT NULL DEFAULT '{}',
    nuts3 text[] NOT NULL DEFAULT '{}',     -- place of performance (region level only)
    value numeric,
    currency text,
    url text NOT NULL,
    retrieved_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS public_works_notices_date_idx ON analytics.public_works_notices (publication_date DESC);

-- NUTS 3 (TED place of performance) to RPE statistical region, matched by official name.
CREATE TABLE IF NOT EXISTS analytics.nuts3_regions (
    nuts3 text PRIMARY KEY,
    region_name text NOT NULL
);
INSERT INTO analytics.nuts3_regions (nuts3, region_name) VALUES
    ('SI031', 'Pomurska'), ('SI032', 'Podravska'), ('SI033', 'Koroška'), ('SI034', 'Savinjska'),
    ('SI035', 'Zasavska'), ('SI036', 'Posavska'), ('SI037', 'Jugovzhodna Slovenija'),
    ('SI038', 'Primorsko-notranjska'), ('SI041', 'Osrednjeslovenska'), ('SI042', 'Gorenjska'),
    ('SI043', 'Goriška'), ('SI044', 'Obalno-kraška')
ON CONFLICT (nuts3) DO NOTHING;

-- SURS building permits (1970717S) are stored in analytics.context_series
-- (series permit_buildings, permit_dwellings, permit_floor_area; geography SI / municipality).

GRANT SELECT ON analytics.cadastre_buildings, analytics.cadastre_codebooks,
    analytics.public_works_notices, analytics.nuts3_regions TO real_estate_api;
