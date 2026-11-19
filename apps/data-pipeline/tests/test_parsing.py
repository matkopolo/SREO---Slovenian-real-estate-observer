from datetime import date

import pytest

from real_estate_etl.parsing import (
    SAFE_FILE_NAME,
    dbf_day,
    digits_integer,
    four_digit_year,
    gurs_integer,
    gurs_number,
    iso_day,
    register_day,
    safe_file_name,
    slovene_decimal,
    snapshot_date,
)


@pytest.mark.parametrize(("raw", "expected"), [
    ("2551.0", 2551.0), (" 12 ", 12.0), ("", None), ("****", None), ("abc", None), ("nan", None), ("inf", None),
])
def test_gurs_number(raw, expected):
    assert gurs_number(raw) == expected


def test_gurs_integer_truncates_dbase_floats():
    assert gurs_integer("2551.0") == 2551
    assert gurs_integer("-1") == -1
    assert gurs_integer("") is None


@pytest.mark.parametrize(("raw", "expected"), [
    ("472.179,28", 472179.28), ("128,5", 128.5), ("59", 59.0), ("2.566", 2566.0), ("-3,5", -3.5), ("", None),
    ("1.5", None),  # a dot decimal would otherwise be read as 1500
    ("1,234.5", None), ("12.34.5", None), ("abc", None),
])
def test_slovene_decimal(raw, expected):
    assert slovene_decimal(raw) == expected


def test_small_integer_parsers():
    assert digits_integer(" 665 ") == 665
    assert digits_integer("-1") is None
    assert four_digit_year("1993") == 1993
    assert four_digit_year("93") is None


def test_day_parsers():
    assert register_day("13.11.2025") == date(2025, 11, 13)
    assert register_day("2025-11-13") is None
    assert dbf_day("20180411") == "2018-04-11"
    assert dbf_day("00000000") is None
    assert iso_day("2022-05-30T04:36:33") == "2022-05-30"
    assert iso_day("") is None


def test_snapshot_date_requires_the_export_date():
    assert snapshot_date("KN_SLO_STAVBE_SLO_20261101.zip") == date(2026, 11, 1)
    assert snapshot_date("EV_108_EVIDENCA_VREDNOTENJA_20261107.zip") == date(2026, 11, 7)
    with pytest.raises(ValueError, match="No snapshot date"):
        snapshot_date("KN_SLO_STAVBE_SLO.zip")
    with pytest.raises(ValueError, match="month must be"):
        snapshot_date("KN_SLO_STAVBE_SLO_20261301.zip")


@pytest.mark.parametrize("raw", [
    "../ETN_SLO_2020_KPP.zip", "/etc/passwd", "ETN/../x.zip", "..\\x.zip", ".hidden.zip", "", "a b.zip", "x.zip\n",
])
def test_safe_file_name_rejects_traversal_and_odd_names(raw):
    with pytest.raises(ValueError, match="unsafe file name"):
        safe_file_name(raw)


def test_safe_file_name_keeps_plain_names_and_applies_the_pattern():
    assert safe_file_name("ETN_SLO_2020_KPP_20260101.zip") == "ETN_SLO_2020_KPP_20260101.zip"
    assert SAFE_FILE_NAME.fullmatch("DRSV_IKRPN_PV.zip")
    import re

    with pytest.raises(ValueError, match="unsafe file name"):
        safe_file_name("ETN_SLO_2020_KPP.zip", re.compile(r"EV_\d+_EVIDENCA_VREDNOTENJA_\d{8}\.zip"))
