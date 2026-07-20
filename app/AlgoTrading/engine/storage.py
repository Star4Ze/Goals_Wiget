import json
import re
from pathlib import Path
from datetime import datetime, timezone

from engine import settings


META_FILENAME = "meta.json"


def _sanitize_dir_name(name: str) -> str:
    if not name:
        return ""
    cleaned = re.sub(r'[<>:"/\\\\|?*]', "_", name)
    cleaned = cleaned.strip().strip(".")
    return cleaned or name


def _resolve_ticker(figi: str, account_id: str | None) -> str | None:
    try:
        for acc in getattr(settings, "ACCOUNTS", []) or []:
            if str(acc.get("ACCOUNT_ID") or "") == str(account_id or ""):
                cfg = (acc.get("TICKERS") or {}).get(figi) or {}
                if cfg.get("TICKER"):
                    return cfg.get("TICKER")
    except Exception:
        pass
    try:
        cfg = (getattr(settings, "TICKERS_CONFIG", {}) or {}).get(figi) or {}
        if cfg.get("TICKER"):
            return cfg.get("TICKER")
    except Exception:
        pass
    try:
        from engine.figi_cache import FIGI_CACHE
        info = FIGI_CACHE.get(figi, {})
        if isinstance(info, dict):
            return info.get("ticker")
    except Exception:
        pass
    return None


def _write_meta(path: Path, figi: str, ticker: str | None, extra: dict | None = None):
    data = {
        "figi": figi,
        "ticker": ticker,
    }
    if extra:
        data.update({k: v for k, v in extra.items() if v is not None})
    meta_path = path / META_FILENAME
    existing = _read_meta(path)
    if isinstance(existing, dict):
        candidate = dict(existing)
        candidate.update(data)
        candidate["updated_at"] = existing.get("updated_at")
        if candidate == existing:
            return
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception:
        return


def _read_meta(path: Path) -> dict:
    meta_path = path / META_FILENAME
    if not meta_path.exists():
        return {}
    try:
        with open(meta_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def read_figi_meta(figi: str, account_id: str | None = None) -> dict:
    path = get_figi_dir(figi, account_id, create=False)
    if not path:
        return {}
    return _read_meta(path)


def _find_dir_by_meta(account_dir: Path, figi: str) -> Path | None:
    try:
        for entry in account_dir.iterdir():
            if not entry.is_dir():
                continue
            meta = _read_meta(entry)
            if meta.get("figi") == figi:
                return entry
    except Exception:
        return None
    return None


def get_figi_dir(figi: str, account_id: str | None = None, create: bool = False) -> Path | None:
    base_dir = settings.BASE_DIR
    acc_id = account_id or getattr(settings, "ACCOUNT_ID", None)
    account_dir = base_dir / str(acc_id) if acc_id else base_dir

    if not account_dir.exists() and not create:
        return None
    if create:
        account_dir.mkdir(parents=True, exist_ok=True)

    ticker = _resolve_ticker(figi, acc_id)
    target_name = _sanitize_dir_name(ticker or figi)
    target_dir = account_dir / target_name
    legacy_dir = account_dir / figi

    if target_dir.exists():
        path = target_dir
    else:
        meta_dir = _find_dir_by_meta(account_dir, figi)
        if meta_dir is not None:
            path = meta_dir
        elif legacy_dir.exists():
            if create and target_dir != legacy_dir:
                try:
                    legacy_dir.rename(target_dir)
                    path = target_dir
                except Exception:
                    path = legacy_dir
            else:
                path = legacy_dir
        else:
            if not create:
                return None
            target_dir.mkdir(parents=True, exist_ok=True)
            path = target_dir

    if create:
        _write_meta(path, figi, ticker)
        if legacy_dir.exists() and target_dir.exists() and legacy_dir != target_dir:
            for filename in ("trades_history.json", "buy_history.json", "state.json"):
                legacy_file = legacy_dir / filename
                target_file = target_dir / filename
                if legacy_file.exists() and not target_file.exists():
                    try:
                        legacy_file.replace(target_file)
                    except Exception:
                        pass
    return path


def ensure_figi_dir(figi: str, account_id: str | None = None) -> Path:
    return get_figi_dir(figi, account_id, create=True) or (settings.BASE_DIR / figi)


def update_figi_meta(figi: str, account_id: str | None, info: dict | None):
    path = get_figi_dir(figi, account_id, create=True)
    if not path:
        return
    existing = _read_meta(path)
    ticker = existing.get("ticker") if isinstance(existing, dict) else None
    extra = {}
    if info and isinstance(info, dict):
        if info.get("ticker"):
            ticker = info.get("ticker")
        extra = {
            "name": info.get("name") or existing.get("name"),
            "type": info.get("type") or existing.get("type"),
            "currency": info.get("currency") or existing.get("currency"),
            "lot_size": info.get("lot_size") if info.get("lot_size") is not None else existing.get("lot_size"),
            "initial_margin": info.get("initial_margin") if info.get("initial_margin") is not None else existing.get("initial_margin"),
            "initial_margin_on_buy": info.get("initial_margin_on_buy") if info.get("initial_margin_on_buy") is not None else existing.get("initial_margin_on_buy"),
            "initial_margin_on_sell": info.get("initial_margin_on_sell") if info.get("initial_margin_on_sell") is not None else existing.get("initial_margin_on_sell"),
        }
    if ticker:
        target_name = _sanitize_dir_name(ticker)
        target_dir = path.parent / target_name
        if target_dir != path and not target_dir.exists():
            try:
                path.rename(target_dir)
                path = target_dir
            except Exception:
                pass
    _write_meta(path, figi, ticker, extra)


def list_figis_for_account(account_id: str | None):
    base_dir = settings.BASE_DIR
    acc_id = account_id or getattr(settings, "ACCOUNT_ID", None)
    account_dir = base_dir / str(acc_id) if acc_id else base_dir
    if not account_dir.exists():
        return []
    figis = []
    for entry in account_dir.iterdir():
        if not entry.is_dir():
            continue
        meta = _read_meta(entry)
        figi = meta.get("figi") if meta else None
        ticker = meta.get("ticker") if meta else None

        figi_candidate = figi or entry.name
        if not ticker:
            ticker = _resolve_ticker(figi_candidate, acc_id)

        if ticker:
            target_name = _sanitize_dir_name(ticker)
            target_dir = entry.parent / target_name
            if target_dir != entry and not target_dir.exists():
                try:
                    entry.rename(target_dir)
                    entry = target_dir
                except Exception:
                    pass
            _write_meta(entry, figi_candidate, ticker)

        figis.append(figi_candidate or entry.name)
    return figis


def load_json(path: Path, default):
    if not path.exists() or path.is_dir():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

__all__ = ["ensure_figi_dir", "get_figi_dir", "list_figis_for_account", "read_figi_meta", "update_figi_meta", "load_json", "save_json"]
