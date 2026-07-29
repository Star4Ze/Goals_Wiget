from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from engine import settings


def _portfolio_snapshot_path(account_id: str):
    base_dir = getattr(settings, "BASE_DIR", None)
    if not base_dir:
        base_dir = Path("data")
    if isinstance(base_dir, str):
        base_dir = Path(base_dir)
    return base_dir / str(account_id) / "portfolio_snapshot.json"


def load_portfolio_snapshot(account_id: str) -> dict:
    path = _portfolio_snapshot_path(account_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_portfolio_snapshot(account_id: str, value: float, year_start_value: Optional[float] = None):
    path = _portfolio_snapshot_path(account_id)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        data = load_portfolio_snapshot(account_id)
        series = data.get("series")
        if not isinstance(series, list):
            series = []
        today = datetime.now(timezone.utc).date().isoformat()
        updated = False
        for item in series:
            if isinstance(item, dict) and item.get("date") == today:
                item["value"] = round(float(value or 0), 2)
                updated = True
                break
        if not updated:
            series.append({"date": today, "value": round(float(value or 0), 2)})
        data["series"] = series
        if year_start_value is not None:
            data["year_start_value"] = round(float(year_start_value or 0), 2)
            data["year"] = datetime.now(timezone.utc).year
        data["updated_at"] = datetime.now(timezone.utc).isoformat()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return data
    except Exception:
        return None


__all__ = ["load_portfolio_snapshot", "save_portfolio_snapshot"]
