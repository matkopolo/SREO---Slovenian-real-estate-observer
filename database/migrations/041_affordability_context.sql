-- External context for "Dostopnost nakupa": official statistics that are not GURS ETN.
-- Kept separate from ETN facts; nothing here feeds valuation models or market statistics.

-- One observation per source series, geography and period, exactly as published.
CREATE TABLE IF NOT EXISTS analytics.context_series (
    source text NOT NULL CHECK (source IN ('surs', 'bsi', 'ecb')),
    series text NOT NULL,             -- e.g. 'net_wage_p50', 'housing_rate_fixed_10y'
    geography_key text NOT NULL,      -- 'SI' or 'municipality:<RPE/SURS code>'
    period text NOT NULL,             -- source period label, e.g. '2025M10'
    value numeric NOT NULL,
    unit text NOT NULL,               -- 'EUR/month' or 'percent'
    source_table text NOT NULL,       -- e.g. 'SURS 0711357S'
    retrieved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, series, geography_key, period)
);
CREATE INDEX IF NOT EXISTS context_series_lookup_idx
    ON analytics.context_series (series, geography_key, period DESC);

COMMENT ON TABLE analytics.context_series IS
    'Published SURS, Banka Slovenije and ECB observations used for the affordability illustration.';

-- Dated Banka Slovenije macroprudential limits for consumer housing loans.
CREATE TABLE IF NOT EXISTS analytics.lending_rules (
    valid_from date PRIMARY KEY,
    dsti_max numeric NOT NULL CHECK (dsti_max > 0 AND dsti_max <= 1),
    min_remaining_income numeric NOT NULL CHECK (min_remaining_income >= 0),
    recommended_ltv_primary numeric NOT NULL CHECK (recommended_ltv_primary > 0 AND recommended_ltv_primary <= 1),
    source_url text NOT NULL,
    note text NOT NULL
);

COMMENT ON TABLE analytics.lending_rules IS
    'Banka Slovenije limits by effective date: DSTI cap and minimum remaining net income are binding; LTV is a recommendation.';

-- In force since 2023-07-01; the December 2025 review kept the EUR 745 floor for 2026.
INSERT INTO analytics.lending_rules
    (valid_from, dsti_max, min_remaining_income, recommended_ltv_primary, source_url, note)
VALUES
    ('2026-01-01', 0.50, 745, 0.80,
     'https://www.bsi.si/en/macroprudential-restrictions-on-household-lending-effective-from-july-1-2023',
     'DSTI ≤ 50 % of net income per borrower; at least EUR 745 must remain each month (more with dependants); LTV 80 % for a primary residence is a recommendation; no maturity cap for housing loans.')
ON CONFLICT (valid_from) DO NOTHING;

GRANT SELECT ON analytics.context_series, analytics.lending_rules TO real_estate_api;
