# python:3.11-slim, pinned to its digest (Dependabot keeps it current).
FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928 AS base

# PIP_CONSTRAINT pins every install in the image to constraints.txt. The *_NUM_THREADS
# variables give each model fit one native thread: the trainer already runs property
# groups in parallel, so BLAS/OpenMP pools would only oversubscribe the CPU (Compose sets
# the same; this covers `docker run` and `compose run` with other environments).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_CONSTRAINT=/app/constraints.txt \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1

WORKDIR /app

COPY pyproject.toml constraints.txt ./
COPY real_estate_etl ./real_estate_etl
RUN pip install --no-cache-dir ".[ml]" \
    && useradd --create-home --uid 10001 pipeline \
    && mkdir -p /data/raw \
    && chown -R pipeline:pipeline /data

# Test image: docker build --target test -t real-estate-data-pipeline:test apps/data-pipeline
#             docker run --rm real-estate-data-pipeline:test
FROM base AS test
RUN pip install --no-cache-dir ".[dev,ml]"
COPY pytest.ini ./
COPY tests ./tests
USER pipeline
ENTRYPOINT []
CMD ["python", "-m", "pytest", "-q"]

# Runtime image (default target, used by Compose).
FROM base AS runtime
USER pipeline
ENTRYPOINT ["real-estate-etl"]
CMD ["--help"]
