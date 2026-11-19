"""Consistent stdout logging for CLI and container execution."""

from __future__ import annotations

import logging
import os
import sys

DEFAULT_LOG_LEVEL = "INFO"


class _PipelineFormatter(logging.Formatter):
    """Render planned multi-line sections without a prefix on only their first line."""

    def format(self, record: logging.LogRecord) -> str:
        if getattr(record, "plain_block", False):
            return record.getMessage()
        return super().format(record)


class _PipelineHandler(logging.StreamHandler):
    """The one stdout handler ``configure_logging`` installs (recognisable on a second call)."""


class _HttpxRequestDebugFilter(logging.Filter):
    """Keep routine HTTP request summaries out of normal operational logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.name == "httpx" and record.levelno == logging.INFO:
            record.levelno = logging.DEBUG
            record.levelname = logging.getLevelName(logging.DEBUG)
        return True


def configure_logging() -> None:
    """Configure operational logs once, using a Docker-friendly stdout stream.

    The root logger takes ``LOG_LEVEL`` itself, so records below it are never created;
    a second call only re-applies the level (no duplicate handlers or filters).
    """
    level_name = os.getenv("LOG_LEVEL", DEFAULT_LOG_LEVEL).upper()
    level = getattr(logging, level_name, logging.INFO)
    root = logging.getLogger()
    httpx_logger = logging.getLogger("httpx")
    if not any(isinstance(handler, _PipelineHandler) for handler in root.handlers):
        handler = _PipelineHandler(sys.stdout)
        handler.setFormatter(
            _PipelineFormatter(
                "%(asctime)s %(levelname)s %(name)s — %(message)s",
                datefmt="%Y-%m-%dT%H:%M:%S%z",
            )
        )
        root.addHandler(handler)
    if not any(isinstance(existing, _HttpxRequestDebugFilter) for existing in httpx_logger.filters):
        httpx_logger.addFilter(_HttpxRequestDebugFilter())
    root.setLevel(level)
