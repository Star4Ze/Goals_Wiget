import json
import os
from typing import Dict, List, Optional

from engine import config
from engine import settings

CONFIG_FILE = getattr(config, "CONFIG_FILE", "config.json")
SETTINGS_KEYS = set(getattr(config, "DEFAULT_SETTINGS", {}).keys())

def _load_payload() -> Dict:
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception:
        return {}
    return {}


def load_accounts() -> List[Dict]:
    data = _load_payload()
    accounts = data.get("accounts") if isinstance(data, dict) else None
    return accounts if isinstance(accounts, list) else []


def _find_account(accounts: List[Dict], account_id: str) -> Optional[Dict]:
    for acc in accounts:
        if not isinstance(acc, dict):
            continue
        if str(acc.get("ACCOUNT_ID")) == str(account_id):
            return acc
    return None


def load_account_tickers(account_id: str) -> Dict:
    accounts = load_accounts()
    acc = _find_account(accounts, account_id)
    if acc and isinstance(acc.get("TICKERS"), dict):
        return acc.get("TICKERS") or {}
    return load_overrides()


def save_account_tickers(account_id: str, tickers: Dict):
    payload = _load_payload() or {}
    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        accounts = []
    acc = _find_account(accounts, account_id)
    if not acc:
        acc = {"ACCOUNT_ID": account_id, "TICKERS": {}}
        accounts.append(acc)
    acc["TICKERS"] = tickers
    payload["accounts"] = accounts
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def load_account_settings(account_id: str) -> Dict:
    accounts = load_accounts()
    acc = _find_account(accounts, account_id)
    if acc and isinstance(acc.get("SETTINGS"), dict):
        return acc.get("SETTINGS") or {}
    return {}


def save_account_settings(account_id: str, settings_overrides: Dict):
    payload = _load_payload() or {}
    accounts = payload.get("accounts")
    if not isinstance(accounts, list):
        accounts = []
    acc = _find_account(accounts, account_id)
    if not acc:
        acc = {"ACCOUNT_ID": account_id, "TICKERS": {}}
        accounts.append(acc)
    acc["SETTINGS"] = settings_overrides
    payload["accounts"] = accounts
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def load_overrides() -> Dict:
    data = _load_payload()
    if not data:
        return {}
    if isinstance(data, dict) and "tickers" in data:
        return data.get("tickers") or {}
    if isinstance(data, dict) and "settings" in data:
        return data.get("tickers") or {}
    if isinstance(data, dict):
        return data
    return {}


def save_overrides(tickers: Dict):
    payload = _load_payload() or {}
    payload["tickers"] = tickers
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def load_settings_overrides() -> Dict:
    data = _load_payload()
    if not data:
        return {}
    settings_overrides = data.get("settings") if isinstance(data, dict) else None
    return settings_overrides if isinstance(settings_overrides, dict) else {}

def save_settings_overrides(settings_overrides: Dict):
    payload = _load_payload() or {}
    payload["settings"] = settings_overrides
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def merge_with_base() -> Dict:
    return load_overrides()


def apply_overrides():
    merged = merge_with_base()
    config.TICKERS_CONFIG = merged
    settings.TICKERS_CONFIG = merged
    return merged


def apply_account_overrides(account_id: str):
    merged = load_account_tickers(account_id)
    config.TICKERS_CONFIG = merged
    settings.TICKERS_CONFIG = merged
    return merged

def apply_settings_overrides():
    overrides = load_settings_overrides()
    for key, value in (overrides or {}).items():
        if SETTINGS_KEYS and key not in SETTINGS_KEYS:
            continue
        setattr(config, key, value)
        if key == "ANALYSIS_INTERVAL":
            setattr(settings, "UPDATE_DELAY", value)
        else:
            setattr(settings, key, value)
    return overrides

__all__ = [
    "load_overrides",
    "save_overrides",
    "load_settings_overrides",
    "save_settings_overrides",
    "merge_with_base",
    "apply_overrides",
    "apply_settings_overrides",
]
