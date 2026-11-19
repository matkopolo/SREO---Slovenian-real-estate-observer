"""The generalised-value loader against PostgreSQL (migration 049), for one fictitious municipality.

``load_valuation`` replaces only the rows of the municipality it loads, so a code no real
municipality uses keeps the test isolated; its rows and codebook entries are removed again.
The energy-certificate and flood loaders replace whole tables and are covered by unit tests.
"""

import os
import zipfile
from datetime import date
from pathlib import Path

import psycopg
import pytest

from real_estate_etl.registers import load_valuation, loaded_valuation_date

pytestmark = pytest.mark.integration
MUNICIPALITY = 999_999
UNITS = (
    "FEATUREID,EID_DEL_STAVBE,ID_MODEL,RAVEN,VPLIV,POSPLOSENA_VREDNOST,RPE_OBCINE_SIFRA\r\n"
    "U.1,test-part-1,STA,8/21,,84700.00,999999\r\n"
    "U.2,test-part-1,GAR,2/5,,9000,999999\r\n"  # a second unit for the same part: the higher value is kept
    "U.3,test-part-2,HIS,5/15,,213200,999999\r\n"
)


def valuation_archive(path: Path) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("EV_999999_EVIDENCA_VREDNOTENJA_stavba_20991231.csv",
                   "FEATUREID,EID_STAVBA,KO_SIFKO,STEV_ST\r\nS.1,test-building-1,665,2257\r\n")
        z.writestr("EV_999999_EVIDENCA_VREDNOTENJA_del_stavbe_20991231.csv",
                   "FEATUREID,EID_DEL_STAVBE,EID_STAVBA,STEV_DST,ST_NADSTROPJA,ID_LEGA\r\n"
                   "D.1,test-part-1,test-building-1,2,0,1714\r\nD.2,test-part-2,test-building-1,3,1,\r\n")
        z.writestr("EV_999999_EVIDENCA_VREDNOTENJA_del_stavbe_enota_20991231.csv", UNITS)
        z.writestr("EV_999999_EVIDENCA_VREDNOTENJA_SIF_MODEL_20991231.csv",
                   "FEATUREID,ID_MODEL,NAZIV,OPIS\r\nM.1,TEST_STA,Test model,\r\n")
        z.writestr("EV_999999_EVIDENCA_VREDNOTENJA_SIF_LEGA_20991231.csv",
                   "FEATUREID,ID_LEGA,SIFRA,NAZIV\r\nL.1,999991714,2,test position\r\n")
    return path


@pytest.fixture
def connection():
    database_url = os.getenv("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("TEST_DATABASE_URL is not set")
    connection = psycopg.connect(database_url)
    try:
        yield connection
    finally:
        connection.rollback()
        connection.execute("DELETE FROM analytics.generalised_values WHERE municipality_code=%s", (MUNICIPALITY,))
        connection.execute(
            "DELETE FROM analytics.register_codebooks WHERE (codebook,code) IN (('valuation_model','TEST_STA'),"
            "('position','999991714'))"
        )
        connection.commit()
        connection.close()


def test_load_valuation_replaces_one_municipality_deterministically(connection, tmp_path: Path):
    archive = valuation_archive(tmp_path / "EV_999999_EVIDENCA_VREDNOTENJA_20991231.zip")

    assert load_valuation(connection, archive, MUNICIPALITY) == 2
    connection.commit()
    assert loaded_valuation_date(connection, MUNICIPALITY) == date(2099, 12, 31)
    rows = connection.execute(
        """SELECT part_eid,cadastral_code,building_number,part_number,model,value,floor,position
           FROM analytics.generalised_values WHERE municipality_code=%s ORDER BY part_eid""",
        (MUNICIPALITY,),
    ).fetchall()
    assert rows == [
        ("test-part-1", 665, 2257, 2, "STA", 84700, 0, 1714),  # DISTINCT ON kept the highest value
        ("test-part-2", 665, 2257, 3, "HIS", 213200, 1, None),
    ]
    assert connection.execute(
        "SELECT label FROM analytics.register_codebooks WHERE codebook='valuation_model' AND code='TEST_STA'"
    ).fetchone() == ("Test model",)
    # The same export date is a no-op; a re-run after a crash loads the same rows again.
    assert load_valuation(connection, archive, MUNICIPALITY) == 0
    connection.execute("DELETE FROM analytics.generalised_values WHERE municipality_code=%s", (MUNICIPALITY,))
    connection.commit()
    assert load_valuation(connection, archive, MUNICIPALITY) == 2
