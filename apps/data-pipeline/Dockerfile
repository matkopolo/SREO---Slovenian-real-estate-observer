FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY pyproject.toml ./
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
