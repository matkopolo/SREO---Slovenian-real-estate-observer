"""Valuation-model feature schema and preprocessing.

Feature matrices hold the columns of :data:`MODEL_FEATURES` in that order. Code that
addresses a column uses :data:`FEATURE_INDEX` (or the column lists below), never a bare
position, so reordering or adding a feature cannot silently shift another one.
"""

from __future__ import annotations

from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

MODEL_FEATURES = [
    "log_area",
    "construction_year",
    "contract_year",
    "contract_month",
    "centroid_e",
    "centroid_n",
    "property_group",
    "municipality_id",
]
CATEGORICAL_FEATURES = ("property_group", "municipality_id")
NUMERIC_FEATURES = tuple(name for name in MODEL_FEATURES if name not in CATEGORICAL_FEATURES)

FEATURE_INDEX = {name: position for position, name in enumerate(MODEL_FEATURES)}
NUMERIC_COLUMNS = [FEATURE_INDEX[name] for name in NUMERIC_FEATURES]
CATEGORICAL_COLUMNS = [FEATURE_INDEX[name] for name in CATEGORICAL_FEATURES]


def preprocessor(
    numeric_columns: list[int], categorical_columns: list[int], *, dense: bool = False
) -> ColumnTransformer:
    return ColumnTransformer(
        [
            (
                "numeric",
                Pipeline(
                    [
                        ("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
                        ("scale", StandardScaler()),
                    ]
                ),
                numeric_columns,
            ),
            (
                "categorical",
                OneHotEncoder(
                    handle_unknown="ignore",
                    min_frequency=10,
                    sparse_output=not dense,
                ),
                categorical_columns,
            ),
        ],
        sparse_threshold=0 if dense else 0.3,
    )


def feature_preprocessor(*, dense: bool = False, offset: int = 0) -> ColumnTransformer:
    """Preprocessor for a matrix of :data:`MODEL_FEATURES`, preceded by ``offset`` extra numeric columns."""
    return preprocessor(
        [*range(offset), *(column + offset for column in NUMERIC_COLUMNS)],
        [column + offset for column in CATEGORICAL_COLUMNS],
        dense=dense,
    )
