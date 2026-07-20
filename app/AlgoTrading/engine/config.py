import json
import os
from pathlib import Path

from engine.utils import normalize_instrument_type

CONFIG_FILE = os.getenv("BOT_CONFIG_FILE", "config.json")

DEFAULT_SETTINGS = {
    "TOKEN": "",
    "TOKEN_TRADE": "",
    "TOKEN_HISTORY": "",
    "ACCOUNT_ID": "",
    "DASHBOARD_ENABLED": False,
    "DASHBOARD_PATH": "trading-desk-dashboard-main",
    "DASHBOARD_HOST": "127.0.0.1",
    "DASHBOARD_PORT": 5184,
    "DASHBOARD_CMD": "npm run dev",
    "DASHBOARD_API_ENABLED": True,
    "DASHBOARD_API_HOST": "127.0.0.1",
    "DASHBOARD_API_PORT": 8110,
    "LOG_FILE": "data/bot_logs.log",
    "DETAILED_LOG_FILE": None,
    "DETAILED_LOG_LEVEL": "DEBUG",
    "TMON_FIGI": None,
    "TMON_REBALANCE_ENABLED": True,
    "IS_QUALIFIED_INVESTOR": False,
    "MAX_MARGIN": 0,
    "MIN_CASH_RESERVE": 0,
    "MAX_DAILY_CAPITAL_PERCENT": 1.0,
    "CAPITAL_ALLOCATION": {"share": 0.5, "bond": 0.5, "futures": 0.0, "fund": 0.0},
    "BUY_BASED_ON_AVG_PRICE": False,
    "MODE": "LIFO",
    "IGNORE_LIMITS_SHARES": False,
    "DEFAULT_SELL_BASE_MODE": "last",
    "DEFAULT_BUY_BASE_MODE": "last",
    "TRAILING_GRID_MODE": True,
    "MIN_PROFIT_STEP_PCT": 0.0,
    "COMMISSION_RATE": 0.0005,
    "TRADING_START_TIME": "06:58",
    "TRADING_END_TIME": "23:43",
    "WEEKEND_TRADING_START_TIME": "02:00",  # NEW: начало торгов в выходные
    "WEEKEND_TRADING_END_TIME": "23:59",    # NEW: конец торгов в выходные
    "WEEKEND_LIMIT_ORDERS_START_TIME": "02:00",  # NEW: начало выставления лимиток в выходные
    "REBALANCE_TIME": None,
    "DEFAULT_FIGI_TEMPLATE": {
        "BUY_LIMIT_PRICE_PERCENT": 0.01,
        "SELL_LIMIT_PRICE_PERCENT": 0.01,
        "BUY_LOTS_PER_ORDER": 1,
        "SELL_LOTS_PER_ORDER": 1,
        "MAX_LOTS": 10,
        "MIN_LOTS_TO_HOLD": 0,
        "MAX_BUY_ORDERS": 2,
        "MAX_SELL_ORDERS": 2,
        "TRADE_MODE": "LONG",
    },
    "ANALYSIS_INTERVAL": 60,
    "ORDER_REFRESH_GRACE_SEC": 120,
    "ANALYSIS_ONLY": False,
    "REBUILD_STATE_ON_START": True,
    "LOAD_HISTORY_ON_START": True,
    "HISTORY_YEARS": 3,
    "REFRESH_HISTORY_ON_CHANGE": True,
}


def _load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _apply_config(_config_data: dict):
    _settings = _config_data.get("settings") if isinstance(_config_data, dict) else None
    _tickers = _config_data.get("tickers") if isinstance(_config_data, dict) else None
    _accounts = _config_data.get("accounts") if isinstance(_config_data, dict) else None

    if not isinstance(_settings, dict):
        _settings = {}
    if not isinstance(_tickers, dict):
        _tickers = {}
    if not isinstance(_accounts, list):
        _accounts = []

    for _key, _default in DEFAULT_SETTINGS.items():
        globals()[_key] = _settings.get(_key, _default)

    # Normalize instrument types in ticker definitions (config or dashboard may use numeric codes)
    for _figi, _cfg in _tickers.items():
        if isinstance(_cfg, dict):
            _type = _cfg.get("INSTRUMENT_TYPE") or _cfg.get("instrument_type")
            normalized_type = normalize_instrument_type(_type)
            _cfg["INSTRUMENT_TYPE"] = normalized_type
            _cfg["instrument_type"] = normalized_type

    for _account in _accounts:
        tickers = _account.get("TICKERS") if isinstance(_account, dict) else None
        if isinstance(tickers, dict):
            for _figi, _cfg in tickers.items():
                if isinstance(_cfg, dict):
                    _type = _cfg.get("INSTRUMENT_TYPE") or _cfg.get("instrument_type")
                    normalized_type = normalize_instrument_type(_type)
                    _cfg["INSTRUMENT_TYPE"] = normalized_type
                    _cfg["instrument_type"] = normalized_type

    globals()["TICKERS_CONFIG_BASE"] = _tickers
    globals()["TICKERS_CONFIG"] = _tickers
    globals()["ACCOUNTS"] = _accounts


def reload_config():
    data = _load_config()
    if not isinstance(data, dict):
        data = {}
    _apply_config(data)
    return data


_config_data = _load_config()
if not isinstance(_config_data, dict):
    _config_data = {}
_apply_config(_config_data)

BASE_DIR = Path("data")

__all__ = [
    "CONFIG_FILE",
    "TICKERS_CONFIG_BASE",
    "TICKERS_CONFIG",
    "ACCOUNTS",
    "BASE_DIR",
    *list(DEFAULT_SETTINGS.keys()),
]
