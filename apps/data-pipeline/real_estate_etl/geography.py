"""Import official GURS RPE administrative boundaries into PostGIS."""

from __future__ import annotations

import json
import logging
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import psycopg
from psycopg import sql

from . import http_client
from .settings import RPE_OGC_BASE

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class BoundaryCollection:
    collection_id: str
    level: str
    eid_field: str
    parent_eid_field: str | None = None


COLLECTIONS = (
    BoundaryCollection("SI.GURS.RPE:STATISTICNE_REGIJE", "statistical_region", "EID_STATISTICNA_REGIJA"),
    BoundaryCollection("SI.GURS.RPE:OBCINE", "municipality", "EID_OBCINA"),
    BoundaryCollection("SI.GURS.RPE:CETRTNE_SKUPNOSTI", "city_district", "EID_CETRTNA_SKUPNOST", "EID_OBCINA"),
    BoundaryCollection("SI.GURS.RPE:KRAJEVNE_SKUPNOSTI", "local_community", "EID_KRAJEVNA_SKUPNOST", "EID_OBCINA"),
    BoundaryCollection("SI.GURS.RPE:NASELJA", "settlement", "EID_NASELJE", "EID_OBCINA"),
)


def collection_url(collection_id: str) -> str:
    encoded = collection_id.replace(":", "%3A")
    return f"{RPE_OGC_BASE}/collections/{encoded}/items?f=application%2Fgeo%2Bjson&limit=1000"


def iter_collection_pages(fetch_json: Callable[[str], dict], collection: BoundaryCollection) -> Iterator[dict]:
    url = collection_url(collection.collection_id)
    visited: set[str] = set()
    while url:
        if url in visited:
            raise ValueError(f"Pagination cycle in {collection.collection_id}: {url}")
        visited.add(url)
        payload = fetch_json(url)
        if payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            raise ValueError(f"Invalid GeoJSON FeatureCollection for {collection.collection_id}")
        yield payload
        url = next(
            (link.get("href") for link in payload.get("links", []) if link.get("rel") == "next"),
            None,
        )


def normalized_feature(feature: dict, collection: BoundaryCollection) -> tuple:
    properties = feature.get("properties") or {}
    geometry = feature.get("geometry")
    eid = properties.get(collection.eid_field)
    name = properties.get("NAZIV")
    if not eid or not name or not geometry:
        raise ValueError(f"Incomplete {collection.collection_id} feature: {feature.get('id')}")
    if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise ValueError(f"Unsupported geometry type for {feature.get('id')}: {geometry.get('type')}")
    return (
        collection.level,
        collection.collection_id,
        str(eid),
        _optional_int(properties.get("SIFRA")),
        _optional_int(properties.get("SESTAVLJENA_SIFRA")),
        str(name),
        _parent_eid(properties, collection),
        properties.get("DATUM_SYS"),
        json.dumps(properties, ensure_ascii=False),
        json.dumps(geometry, ensure_ascii=False),
    )


def sync_geographies(
    connection: psycopg.Connection,
    fetch_json: Callable[[str], dict[str, Any]] | None = None,
    schema: str = "analytics",
) -> dict[str, int]:
    """Atomically refresh current RPE boundaries and their hierarchy."""
    if fetch_json is None:
        with http_client.create_client() as client:
            return sync_geographies(
                connection,
                lambda url: http_client.fetch_json(client, url, "RPE boundary request"),
                schema,
            )

    token = datetime.now(UTC)
    run_id = connection.execute(
        sql.SQL(
            "INSERT INTO {}.refresh_runs(process,status,started_at) "
            "VALUES ('geographies','running',%s) RETURNING id"
        ).format(
            sql.Identifier(schema)
        ),
        (token,),
    ).fetchone()[0]
    connection.commit()

    counts: dict[str, int] = {}
    table = sql.Identifier(schema, "geographic_units")
    try:
        with connection.transaction(), connection.cursor() as cursor:
            cursor.execute(sql.SQL("UPDATE {} SET parent_id=NULL").format(table))
            for collection in COLLECTIONS:
                count = 0
                for page in iter_collection_pages(fetch_json, collection):
                    rows = [(*normalized_feature(feature, collection), token) for feature in page["features"]]
                    if rows:
                        cursor.executemany(
                            sql.SQL(
                                """INSERT INTO {}(
                                       level,source_collection,gurs_eid,code,composite_code,name,parent_gurs_eid,
                                       source_updated_at,source_properties,geometry_wgs84,imported_at
                                   ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,
                                       ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(%s),4326)),%s)
                                   ON CONFLICT(source_collection,gurs_eid) DO UPDATE SET
                                       level=excluded.level,code=excluded.code,composite_code=excluded.composite_code,
                                       name=excluded.name,parent_gurs_eid=excluded.parent_gurs_eid,
                                       source_updated_at=excluded.source_updated_at,
                                       source_properties=excluded.source_properties,
                                       geometry_wgs84=excluded.geometry_wgs84,imported_at=excluded.imported_at"""
                            ).format(table),
                            rows,
                        )
                    count += len(rows)
                counts[collection.level] = count

            cursor.execute(
                sql.SQL(
                    """INSERT INTO {}(
                           level,source_collection,gurs_eid,code,name,source_properties,geometry_wgs84,imported_at
                       ) SELECT 'country','derived','SI',1,'Slovenija','{{}}'::jsonb,
                                ST_Multi(ST_UnaryUnion(ST_Collect(geometry_wgs84))),%s
                         FROM {} WHERE level='statistical_region' AND imported_at=%s
                       ON CONFLICT(source_collection,gurs_eid) DO UPDATE SET
                           name=excluded.name,geometry_wgs84=excluded.geometry_wgs84,
                           imported_at=excluded.imported_at"""
                ).format(table, table),
                (token, token),
            )
            counts["country"] = 1
            _assign_hierarchy(cursor, table)
            cursor.execute(sql.SQL("DELETE FROM {} WHERE imported_at<>%s").format(table), (token,))
            cursor.execute(
                sql.SQL(
                    "UPDATE {}.refresh_runs SET status='succeeded',finished_at=now(),details=%s::jsonb WHERE id=%s"
                ).format(sql.Identifier(schema)),
                (json.dumps({"counts": counts}), run_id),
            )
        connection.commit()
    except Exception as exc:
        connection.rollback()
        connection.execute(
            sql.SQL(
                "UPDATE {}.refresh_runs SET status='failed',finished_at=now(),details=%s::jsonb WHERE id=%s"
            ).format(sql.Identifier(schema)),
            (json.dumps({"error": str(exc)}), run_id),
        )
        connection.commit()
        raise

    logger.info(
        "Synchronized geographic boundaries: %s",
        ", ".join(f"{level}={count}" for level, count in counts.items()),
    )
    return counts


def _assign_hierarchy(cursor, table) -> None:
    cursor.execute(
        sql.SQL(
            """UPDATE {} child SET parent_id=parent.id
                 FROM {} parent
                WHERE child.level='statistical_region'
                  AND parent.level='country'"""
        ).format(table, table)
    )
    cursor.execute(
        sql.SQL(
            """UPDATE {} municipality SET parent_id=region.id
                 FROM {} region
                WHERE municipality.level='municipality'
                  AND region.level='statistical_region'
                  AND ST_Covers(region.geometry_d96tm, ST_PointOnSurface(municipality.geometry_d96tm))"""
        ).format(table, table)
    )
    cursor.execute(
        sql.SQL(
            """UPDATE {} child SET parent_id=municipality.id
                 FROM {} municipality
                WHERE child.level IN ('city_district','local_community','settlement')
                  AND municipality.level='municipality'
                  AND child.parent_gurs_eid=municipality.gurs_eid"""
        ).format(table, table)
    )


def _parent_eid(properties: dict[str, Any], collection: BoundaryCollection) -> str | None:
    parent = properties.get(collection.parent_eid_field) if collection.parent_eid_field else None
    return str(parent) if parent else None


def _optional_int(value) -> int | None:
    return int(value) if value is not None and value != "" else None


def seed_archive_name(collection_id: str) -> str:
    """File name of one collection inside the boundary seed archive."""
    return f"{collection_id.replace(':', '_')}.geojson"


def seed_fetcher(archive: Path) -> Callable[[str], dict]:
    """A ``fetch_json`` that answers collection requests from the boundary seed archive.

    The archive holds one GeoJSON FeatureCollection per RPE collection, in the shape the
    OGC API returns, with every feature on one page (no ``next`` links), so
    :func:`sync_geographies` runs unchanged against it.
    """
    with zipfile.ZipFile(archive) as bundle:
        names = set(bundle.namelist())

    def fetch(url: str) -> dict:
        for collection in COLLECTIONS:
            if collection.collection_id.replace(":", "%3A") in url or collection.collection_id in url:
                name = seed_archive_name(collection.collection_id)
                if name not in names:
                    raise ValueError(f"Boundary seed {archive.name} has no {name}")
                with zipfile.ZipFile(archive) as bundle, bundle.open(name) as handle:
                    payload = json.load(handle)
                payload.pop("links", None)
                return payload
        raise ValueError(f"Boundary seed cannot answer {url}")

    return fetch


def export_boundary_seed(connection: psycopg.Connection, archive: Path, schema: str = "analytics") -> dict[str, int]:
    """Write the currently stored RPE boundaries to a seed archive :func:`seed_fetcher` can serve.

    Features keep the GURS properties and the WGS84 geometry (7 decimals, as published), so a
    sync from the archive reproduces the stored units; derived units (the country) are rebuilt.
    """
    counts: dict[str, int] = {}
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for collection in COLLECTIONS:
            rows = connection.execute(
                sql.SQL(
                    "SELECT gurs_eid, source_properties, ST_AsGeoJSON(geometry_wgs84, 7)::json "
                    "FROM {} WHERE source_collection=%s ORDER BY gurs_eid"
                ).format(sql.Identifier(schema, "geographic_units")),
                (collection.collection_id,),
            ).fetchall()
            features = [
                {"type": "Feature", "id": eid, "properties": properties, "geometry": geometry}
                for eid, properties, geometry in rows
            ]
            bundle.writestr(
                seed_archive_name(collection.collection_id),
                json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
            )
            counts[collection.level] = len(features)
    logger.info("Exported boundary seed %s: %s", archive, ", ".join(f"{k}={v}" for k, v in counts.items()))
    return counts
