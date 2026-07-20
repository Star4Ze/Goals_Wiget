import json
import os
from pathlib import Path


ANALYTICS_CONFIG_FILE = os.getenv("ANALYTICS_CONFIG_FILE", "config.analytics.json")

DEFAULT_ANALYTICS_SETTINGS = {
    "TOKEN": "",
    "ACCOUNTS": [],
    "REFRESH_ON_VIEW": True,
    "WAVE_RECOMMEND_K": 0.5,
    "WAVE_REVERSAL_PCT": 1.5,
    "FOOTER_SYNC_TEXT": "Синхронизация с сервером. Настройка в config.analytics.json",
    "FOOTER_VERSION": "2026-04-02",
}


def load_analytics_settings() -> dict:
    path = Path(ANALYTICS_CONFIG_FILE)
    if not path.exists():
        return dict(DEFAULT_ANALYTICS_SETTINGS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return dict(DEFAULT_ANALYTICS_SETTINGS)
        settings = data.get("settings") if "settings" in data else data
        if not isinstance(settings, dict):
            settings = {}
        merged = dict(DEFAULT_ANALYTICS_SETTINGS)
        merged.update(settings)
        return merged
    except Exception:
        return dict(DEFAULT_ANALYTICS_SETTINGS)


def get_analytics_token(account_id: str | None = None) -> str | None:
    cfg = load_analytics_settings()
    accounts = cfg.get("ACCOUNTS") or cfg.get("accounts") or []
    if account_id and isinstance(accounts, list):
        for acc in accounts:
            if not isinstance(acc, dict):
                continue
            if str(acc.get("ACCOUNT_ID") or "") == str(account_id):
                token = acc.get("TOKEN") or acc.get("token")
                if isinstance(token, str) and token.strip():
                    return token.strip()
    token = cfg.get("TOKEN")
    if isinstance(token, str) and token.strip():
        return token.strip()
    return None


__all__ = ["load_analytics_settings", "get_analytics_token", "ANALYTICS_CONFIG_FILE"]
