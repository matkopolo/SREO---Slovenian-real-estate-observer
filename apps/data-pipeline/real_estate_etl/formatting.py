"""Small formatting helpers shared by operational log messages."""

from __future__ import annotations


def format_duration(seconds: float) -> str:
    """Render elapsed time as ``42s``, ``2m 5s`` or ``2h 3m 4s``."""
    total_seconds = max(0, int(seconds))
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes}m {seconds}s"
    if minutes:
        return f"{minutes}m {seconds}s"
    return f"{seconds}s"
