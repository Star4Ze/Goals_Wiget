import json
import os

from tinkoff.invest import InstrumentIdType

from engine import settings
from engine.utils import money_value_to_float


def _load_figi_cache():
    figi_path = settings.FIGI_FILE
    legacy_path = "figi_names.json"
    if not os.path.exists(figi_path) and os.path.exists(legacy_path):
        try:
            os.makedirs(os.path.dirname(figi_path), exist_ok=True)
            os.replace(legacy_path, figi_path)
        except Exception:
            pass
    if os.path.exists(figi_path):
        with open(figi_path, "r", encoding="utf-8") as f:
            try:
                return json.load(f)
            except json.JSONDecodeError:
                return {}
    return {}


FIGI_CACHE = _load_figi_cache()


def save_figi_cache():
    os.makedirs(os.path.dirname(settings.FIGI_FILE), exist_ok=True)
    with open(settings.FIGI_FILE, "w", encoding="utf-8") as f:
        json.dump(FIGI_CACHE, f, ensure_ascii=False, indent=2)


def get_figi_info(client, figi: str):
    if figi in FIGI_CACHE:
        cached = FIGI_CACHE[figi]
        if (
            isinstance(cached, dict)
            and cached.get("lot_size") is not None
            and cached.get("type")
            and cached.get("ticker")
            and cached.get("type") not in ("other", "1")
            and not (figi.upper().startswith("FUT") and cached.get("type") != "futures")
        ):
            return cached

    # Попытка найти инструмент в базе данных registry.db (PriceAlert реестр)
    import sqlite3
    from pathlib import Path
    db_path = Path(__file__).resolve().parent.parent / "data" / "registry.db"
    if db_path.exists():
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            row = conn.execute("SELECT * FROM instruments WHERE figi=?", (figi,)).fetchone()
            conn.close()
            if row:
                itype = row["type"]
                if itype == "future":
                    itype = "futures"
                elif itype == "etf":
                    itype = "fund"
                
                info = {
                    "name": row["name"],
                    "ticker": row["ticker"],
                    "type": itype,
                    "currency": (row["currency"] or "rub").lower(),
                    "lot_size": row["lot"] or 1,
                    "initial_margin": None,
                    "initial_margin_on_buy": None,
                    "initial_margin_on_sell": None
                }
                FIGI_CACHE[figi] = info
                return info
        except Exception:
            pass

    try:
        inst = client.instruments.get_instrument_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        if inst and hasattr(inst, "name"):
            kind = getattr(inst, "instrument_kind", None)
            kind_str = str(kind).lower() if kind is not None else "other"
            mapped = None
            if kind_str:
                if kind_str.isdigit():
                    numeric_map = {
                        "2": "share",
                        "3": "bond",
                        "4": "fund",
                        "5": "futures",
                        "6": "currency",
                    }
                    mapped = numeric_map.get(kind_str)
                if not mapped:
                    if "share" in kind_str:
                        mapped = "share"
                    elif "bond" in kind_str:
                        mapped = "bond"
                    elif "etf" in kind_str or "fund" in kind_str:
                        mapped = "fund"
                    elif "currency" in kind_str:
                        mapped = "currency"
                    elif "future" in kind_str:
                        mapped = "futures"
            lot_size = getattr(inst, "lot", None)
            if lot_size is None:
                lot_size = getattr(inst, "lot_size", None)
            initial_margin = money_value_to_float(getattr(inst, "initial_margin", None))
            initial_margin_on_buy = money_value_to_float(getattr(inst, "initial_margin_on_buy", None))
            initial_margin_on_sell = money_value_to_float(getattr(inst, "initial_margin_on_sell", None))
            info = {
                "name": inst.name,
                "ticker": getattr(inst, "ticker", None),
                "type": mapped or kind_str,
                "currency": getattr(inst, "currency", "rub").lower(),
                "lot_size": lot_size,
                "initial_margin": initial_margin,
                "initial_margin_on_buy": initial_margin_on_buy,
                "initial_margin_on_sell": initial_margin_on_sell,
            }
            FIGI_CACHE[figi] = info
            save_figi_cache()
            return info
    except Exception:
        pass

    search_methods = [
        ("bond", client.instruments.bond_by),
        ("share", client.instruments.share_by),
        ("futures", client.instruments.future_by),
        ("currency", client.instruments.currency_by),
        ("etf", client.instruments.etf_by),
    ]

    for inst_type, method in search_methods:
        try:
            inst = method(id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI, id=figi).instrument
            if inst and hasattr(inst, "name"):
                kind = getattr(inst, "instrument_kind", None)
                kind_str = str(kind).lower() if kind is not None else None
                mapped = None
                if kind_str:
                    if kind_str.isdigit():
                        numeric_map = {
                            "2": "share",
                            "3": "bond",
                            "4": "fund",
                            "5": "futures",
                            "6": "currency",
                        }
                        mapped = numeric_map.get(kind_str)
                    if not mapped:
                        if "share" in kind_str:
                            mapped = "share"
                        elif "bond" in kind_str:
                            mapped = "bond"
                        elif "etf" in kind_str or "fund" in kind_str:
                            mapped = "fund"
                        elif "currency" in kind_str:
                            mapped = "currency"
                        elif "future" in kind_str:
                            mapped = "futures"
                lot_size = getattr(inst, "lot", None)
                if lot_size is None:
                    lot_size = getattr(inst, "lot_size", None)
                initial_margin = money_value_to_float(getattr(inst, "initial_margin", None))
                initial_margin_on_buy = money_value_to_float(getattr(inst, "initial_margin_on_buy", None))
                initial_margin_on_sell = money_value_to_float(getattr(inst, "initial_margin_on_sell", None))
                info = {
                    "name": inst.name,
                    "ticker": getattr(inst, "ticker", None),
                    "type": mapped or inst_type,
                    "currency": getattr(inst, "currency", "rub").lower(),
                    "lot_size": lot_size,
                    "initial_margin": initial_margin,
                    "initial_margin_on_buy": initial_margin_on_buy,
                    "initial_margin_on_sell": initial_margin_on_sell,
                }
                FIGI_CACHE[figi] = info
                save_figi_cache()
                return info
        except Exception:
            continue

    FIGI_CACHE[figi] = {"name": figi, "type": "other", "currency": "rub"}
    save_figi_cache()
    return FIGI_CACHE[figi]


__all__ = ["FIGI_CACHE", "save_figi_cache", "get_figi_info"]
