from __future__ import annotations

import json
import threading
import io
import base64
from datetime import datetime, timezone
import pytz
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
from pathlib import Path
from typing import Optional
import re

from tinkoff.invest import Client, OperationType
import pandas as pd

from engine import settings
from engine.logging_utils import get_logger, log_detail
from engine.analytics_config import load_analytics_settings, get_analytics_token
from engine.client_factory import get_client
from engine.analytics_top100 import generate_top100_json
from engine.figi_cache import get_figi_info
from engine.utils import money_value_to_float, normalize_instrument_type, quotation_to_float
from engine.history_engine import load_trade_history_from_broker
from engine.storage import ensure_figi_dir, get_figi_dir, list_figis_for_account, read_figi_meta, update_figi_meta, load_json, save_json


_STATUS_LOCK = threading.Lock()
_STATUS: dict = {}

_ACTIONS_LOCK = threading.Lock()
_ACTIONS: dict = {"start": None, "stop": None, "cancel": None, "cancel_rebalance": None}
_CONFIG_LOCK = threading.Lock()
_CONFIG_RELOAD = None
_HISTORY_LOCK = threading.Lock()
_LAST_HISTORY_REFRESH = {}
_EXCLUDE_FIGIS = {"RUB000UTSTOM"}
_ZERO_COMMISSION_FIGIS = {"TCS70A106DL2"}
_FIGI_RE = re.compile(r"^[A-Z0-9]{8,12}$")

_CASHFLOW_DIR = Path(__file__).resolve().parent / "CashFlow"
_CASHFLOW_FILE = _CASHFLOW_DIR / "Data.xlsx"
_CASHFLOW_SHEET = "Доходы и Расходы"
_CASHFLOW_AUDIT_FILE = _CASHFLOW_DIR / "cashflow_audit.log"

_SWEETEARN_DIR = Path(__file__).resolve().parent / "SweetEarn"
_SWEETEARN_PROFILE_FILE = _SWEETEARN_DIR / "profile.json"

_CASHFLOW_INCOME_CATEGORIES = {
    "1": "Зарплата",
    "2": "Продажи",
    "3": "Кэшбек/бонусы",
    "4": "Подарки",
    "5": "Возвраты долгов",
}

_CASHFLOW_EXPENSE_CATEGORIES = {
    "1": "Еда/бакалея",
    "2": "Жилье/коммуналка",
    "3": "Транспорт",
    "4": "Покупки",
    "5": "Переводы/благотворительность",
}


def _cashflow_df():
    return pd.read_excel(_CASHFLOW_FILE, sheet_name=_CASHFLOW_SHEET)


def _cashflow_save_df(df):
    df.to_excel(_CASHFLOW_FILE, sheet_name=_CASHFLOW_SHEET, index=False)


def _sweetearn_load_profile():
    data = load_json(_SWEETEARN_PROFILE_FILE, {})
    return data if isinstance(data, dict) else {}


def _sweetearn_save_profile(profile: dict):
    if not isinstance(profile, dict):
        return False, "invalid_payload"
    payload = dict(profile)
    payload.setdefault("updatedAt", _moscow_now().isoformat())
    save_json(_SWEETEARN_PROFILE_FILE, payload)
    return True, payload


_MOSCOW_TZ = pytz.timezone("Europe/Moscow")


def _moscow_now():
    return datetime.now(_MOSCOW_TZ)


def _cashflow_current_month_name():
    months = {
        "January": "январь",
        "February": "февраль",
        "March": "март",
        "April": "апрель",
        "May": "май",
        "June": "июнь",
        "July": "июль",
        "August": "август",
        "September": "сентябрь",
        "October": "октябрь",
        "November": "ноябрь",
        "December": "декабрь",
    }
    now = _moscow_now()
    month = months.get(now.strftime("%B"), now.strftime("%B"))
    return f"{month.capitalize()} {now.year}"


def ensure_cashflow_current_month():
    try:
        _df, inserted = _cashflow_ensure_current_month(df=None, return_months=False)
        current_month = _cashflow_current_month_name()
        if inserted:
            get_logger().info(f"CashFlow: added current month header '{current_month}'")
        else:
            get_logger().info(f"CashFlow: current month header exists '{current_month}'")
    except Exception as exc:
        get_logger().error(f"CashFlow month check failed: {exc}")


def _cashflow_resolve_current_month(months: list[str]) -> str:
    current = _cashflow_current_month_name()
    if current in months:
        return current
    alt = _moscow_now().strftime("%B %Y")
    if alt in months:
        return alt
    return current


def _cashflow_get_months():
    df, months, _inserted = _cashflow_ensure_current_month(df=None, return_months=True)
    return months


def _parse_month_label(value: str):
    if not value:
        return None
    raw = _normalize_month_label(value)
    parts = raw.split()
    if len(parts) < 2:
        return None
    month_raw = parts[0].strip().lower()
    year_raw = parts[1].strip()
    if not year_raw.isdigit():
        return None
    year = int(year_raw)
    month_map = {
        "январь": 1,
        "февраль": 2,
        "март": 3,
        "апрель": 4,
        "май": 5,
        "июнь": 6,
        "июль": 7,
        "август": 8,
        "сентябрь": 9,
        "октябрь": 10,
        "ноябрь": 11,
        "декабрь": 12,
        "january": 1,
        "february": 2,
        "march": 3,
        "april": 4,
        "may": 5,
        "june": 6,
        "july": 7,
        "august": 8,
        "september": 9,
        "october": 10,
        "november": 11,
        "december": 12,
    }
    month = month_map.get(month_raw)
    if not month:
        return None
    return year, month


def _normalize_month_label(value: str) -> str:
    if value is None:
        return ""
    raw = str(value).replace("\u00a0", " ").strip()
    while "  " in raw:
        raw = raw.replace("  ", " ")
    return raw


def _cashflow_ensure_current_month(df=None, return_months: bool = False):
    if df is None:
        df = _cashflow_df()

    months = []
    seen = set()
    month_rows = []
    for idx, val in enumerate(df.iloc[:, 1]):
        label_raw = str(val) if isinstance(val, str) else ""
        label = _normalize_month_label(label_raw)
        if label and label not in ["Доход", "Расход"] and any(char.isdigit() for char in label):
            if label not in seen:
                months.append(label)
                seen.add(label)
            parsed = _parse_month_label(label)
            if parsed:
                month_rows.append((idx, parsed[0], parsed[1], label))

    current_month = _cashflow_current_month_name()
    inserted = False
    if current_month not in seen:
        parsed_current = _parse_month_label(current_month)
        insert_idx = len(df)
        if parsed_current and month_rows:
            cur_y, cur_m = parsed_current
            # find first month row that is later than current
            for idx, y, m, _label in sorted(month_rows, key=lambda x: (x[1], x[2], x[0])):
                if (y, m) > (cur_y, cur_m):
                    insert_idx = idx
                    break

        header = pd.DataFrame([["", current_month, "", "", "", ""]], columns=df.columns)
        if insert_idx >= len(df):
            df = pd.concat([df, header], ignore_index=True)
        else:
            df = pd.concat([df.iloc[:insert_idx], header, df.iloc[insert_idx:]], ignore_index=True)
        _cashflow_save_df(df)
        months = [current_month] + [m for m in months if m != current_month]
        inserted = True
    return (df, months, inserted) if return_months else (df, inserted)


def _cashflow_get_stats(month_name: str):
    df = _cashflow_df()
    found = False
    income = expense = 0
    for _, row in df.iterrows():
        if str(row.iloc[1]) == month_name:
            found = True
            continue
        if not found:
            continue
        if pd.isna(row.iloc[0]):
            break
        if row.iloc[1] == "Доход":
            income += row.iloc[2]
        elif row.iloc[1] == "Расход":
            expense += row.iloc[2]
    return income, expense


def _cashflow_get_logs(month: str):
    df = _cashflow_df()
    found = False
    logs = []
    for idx, row in df.iterrows():
        if str(row.iloc[1]).strip() == month.strip():
            found = True
            continue
        if not found:
            continue
        if pd.isna(row.iloc[0]):
            break
        try:
            amount = float(row.iloc[2])
            if amount <= 0:
                break
        except Exception:
            break
        date = int(row.iloc[0])
        type_tx = str(row.iloc[1]).strip()
        category = str(row.iloc[3]).strip() if not pd.isna(row.iloc[3]) else "—"
        added_by = str(row.iloc[4]).strip() if not pd.isna(row.iloc[4]) else "—"
        desc = str(row.iloc[5]).strip() if len(row) > 5 and not pd.isna(row.iloc[5]) else "—"
        logs.append({
            "row_index": int(idx),
            "date": date,
            "type": type_tx,
            "amount": int(amount),
            "category": category,
            "description": desc,
            "added_by": added_by,
        })
    return logs


def _cashflow_write_audit(action: str, user: str, tx_type: str, amount: float, category: str, description: str, month: str, row_index: int | None):
    _CASHFLOW_AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
    ts = _moscow_now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        amt_val = float(amount)
        amount_str = f"{int(amt_val)}" if amt_val.is_integer() else f"{amt_val:.2f}"
    except Exception:
        amount_str = str(amount)
    action_text = {
        "add": "добавил запись",
        "delete": "удалил запись",
        "delete_last": "удалил последнюю запись",
    }.get(action, action)
    line = (
        f"{ts} Пользователь {user} {action_text}: "
        f"{tx_type}, {amount_str}, {category}, {description or '—'}, {month or ''}\n"
    )
    with open(_CASHFLOW_AUDIT_FILE, "a", encoding="utf-8") as f:
        f.write(line)


def _cashflow_find_month_for_row(df, idx: int) -> str:
    for i in range(idx, -1, -1):
        val = df.iloc[i, 1]
        label = _normalize_month_label(val) if isinstance(val, str) else ""
        if label and label not in ["Доход", "Расход"] and any(char.isdigit() for char in label):
            return label
    return ""


def _cashflow_delete_row(row_index: int, deleted_by: str):
    df = _cashflow_df()
    if row_index < 0 or row_index >= len(df):
        return False, "Запись не найдена"
    row = df.iloc[row_index]
    try:
        date_val = row.iloc[0]
        type_tx = str(row.iloc[1]).strip()
        amount = float(row.iloc[2])
    except Exception:
        return False, "Неверная запись"
    if pd.isna(date_val) or type_tx not in ["Доход", "Расход"] or amount <= 0:
        return False, "Нельзя удалить заголовок или пустую строку"
    category = str(row.iloc[3]).strip() if not pd.isna(row.iloc[3]) else "—"
    added_by = str(row.iloc[4]).strip() if not pd.isna(row.iloc[4]) else "—"
    desc = str(row.iloc[5]).strip() if len(row) > 5 and not pd.isna(row.iloc[5]) else "—"
    month = _cashflow_find_month_for_row(df, row_index)
    df = df.drop(row_index).reset_index(drop=True)
    _cashflow_save_df(df)
    _cashflow_write_audit("delete", deleted_by, type_tx, amount, category, desc, month, row_index)
    return True, f"Удалено: {type_tx} {int(amount)} (добавил {added_by})"


def _cashflow_add_transaction(transaction_type: str, category_key: str, amount: float, description: str, added_by: str):
    if transaction_type not in ["Доход", "Расход"]:
        return False, "Неверный тип транзакции"
    categories = _CASHFLOW_INCOME_CATEGORIES if transaction_type == "Доход" else _CASHFLOW_EXPENSE_CATEGORIES
    if category_key not in categories:
        return False, "Неверная категория"
    if amount <= 0:
        return False, "Сумма должна быть положительной"
    category = categories[category_key]
    df = _cashflow_df()
    df, months, _inserted = _cashflow_ensure_current_month(df=df, return_months=True)
    current_month = _cashflow_resolve_current_month(months)
    if not any(_normalize_month_label(x) == current_month for x in df.iloc[:, 1]):
        header = pd.DataFrame([["", current_month, "", "", "", ""]], columns=df.columns)
        df = pd.concat([df, header], ignore_index=True)
    new_row = {
        "Дата": _moscow_now().day,
        "Транзакция": transaction_type,
        "Сумма": amount,
        "Источник": category,
        "Добавил": added_by,
        "Примечание": description or "—",
    }
    df = pd.concat([df, pd.DataFrame([new_row])], ignore_index=True)
    row_index = len(df) - 1
    _cashflow_save_df(df)
    _cashflow_write_audit("add", added_by, transaction_type, amount, category, description or "—", current_month, row_index)
    return True, "Транзакция добавлена"


def _cashflow_cancel_last(added_by: str):
    df = _cashflow_df()
    for idx in range(len(df) - 1, -1, -1):
        if str(df.iloc[idx]["Добавил"]) == added_by:
            removed = df.iloc[idx].copy()
            month = _cashflow_find_month_for_row(df, idx)
            df = df.drop(idx).reset_index(drop=True)
            _cashflow_save_df(df)
            try:
                amount = float(removed["Сумма"])
            except Exception:
                amount = 0
            _cashflow_write_audit(
                "delete_last",
                added_by,
                str(removed.get("Транзакция", "")).strip(),
                amount,
                str(removed.get("Источник", "")).strip(),
                str(removed.get("Примечание", "")).strip(),
                month,
                int(idx),
            )
            return True, f"Удалено: {removed['Транзакция']} {int(removed['Сумма'])}"
    return False, "Нет транзакций для отмены"


def _is_figi_like(value: str) -> bool:
    if not value:
        return False
    return bool(_FIGI_RE.match(value))


def _normalize_type(value):
    return normalize_instrument_type(value)


def _load_config_json():
    path = Path(getattr(settings, "CONFIG_FILE", "config.json"))
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_config_json(data: dict) -> bool:
    path = Path(getattr(settings, "CONFIG_FILE", "config.json"))
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def _settings_from_cfg(cfg: dict) -> dict:
    raw = cfg.get("settings") if isinstance(cfg, dict) else {}
    return raw if isinstance(raw, dict) else {}


def _get_account_configs():
    data = _load_config_json()
    accounts = []
    raw_accounts = data.get("accounts") if isinstance(data, dict) else None
    if isinstance(raw_accounts, list) and raw_accounts:
        for acc in raw_accounts:
            if not isinstance(acc, dict):
                continue
            accounts.append({
                "NAME": acc.get("NAME") or str(acc.get("ACCOUNT_ID") or "account"),
                "ACCOUNT_ID": str(acc.get("ACCOUNT_ID") or ""),
                "ENABLED": acc.get("ENABLED", True),
                "TICKERS": acc.get("TICKERS") or {},
                "SETTINGS": acc.get("SETTINGS") or {},
            })
    else:
        accounts.append({
            "NAME": "default",
            "ACCOUNT_ID": str(data.get("settings", {}).get("ACCOUNT_ID") or ""),
            "ENABLED": True,
            "TICKERS": data.get("tickers") or getattr(settings, "TICKERS_CONFIG", {}) or {},
            "SETTINGS": data.get("settings") or {},
        })
    return accounts


def _history_path(account_id: str, figi: str):
    figi_dir = get_figi_dir(figi, account_id, create=False)
    if figi_dir is None:
        base_dir = getattr(settings, "BASE_DIR", None)
        if not base_dir:
            base_dir = Path("data")
        if isinstance(base_dir, str):
            base_dir = Path(base_dir)
        return base_dir / str(account_id) / figi / "trades_history.json"
    return figi_dir / "trades_history.json"


def _load_history(account_id: str, figi: str):
    path = _history_path(account_id, figi)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _state_path(account_id: str, figi: str):
    figi_dir = get_figi_dir(figi, account_id, create=False)
    if figi_dir is None:
        base_dir = getattr(settings, "BASE_DIR", None)
        if not base_dir:
            base_dir = Path("data")
        if isinstance(base_dir, str):
            base_dir = Path(base_dir)
        return base_dir / str(account_id) / figi / "state.json"
    return figi_dir / "state.json"


def _load_state(account_id: str, figi: str):
    path = _state_path(account_id, figi)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _list_figis_from_data(account_id: str):
    figis = list_figis_for_account(account_id)
    return [f for f in figis if f and f not in _EXCLUDE_FIGIS]


def _load_live_portfolio(account_id: str):
    if not account_id:
        return {}, 0.0, 0.0
    try:
        token = get_analytics_token(account_id) or getattr(settings, "TOKEN", None)
        if not token:
            return {}, 0.0, 0.0
        with get_client(token) as client:
            portfolio = client.operations.get_portfolio(account_id=account_id)
            positions_map = {}
            total_pnl = 0.0

            for pos in portfolio.positions:
                figi = getattr(pos, "figi", None)
                if not figi or figi in _EXCLUDE_FIGIS:
                    continue
                qty = quotation_to_float(getattr(pos, "quantity", None)) or 0.0
                avg_price = money_value_to_float(getattr(pos, "average_position_price", None))
                current_price = quotation_to_float(getattr(pos, "current_price", None))
                expected_yield = money_value_to_float(getattr(pos, "expected_yield", None))
                initial_margin = money_value_to_float(getattr(pos, "initial_margin", None))
                blocked = money_value_to_float(getattr(pos, "blocked", None))
                pnl_value = expected_yield or 0.0
                value = None
                if current_price is not None and qty is not None:
                    value = current_price * qty
                invested = None
                if avg_price is not None and qty is not None:
                    invested = avg_price * qty
                pnl_percent = None
                if invested and invested != 0:
                    pnl_percent = (pnl_value / invested) * 100

                pos_type = getattr(pos, "instrument_type", None)
                if pos_type:
                    pos_type = str(pos_type).lower()
                try:
                    info = get_figi_info(client, figi)
                    name = info.get("name")
                    instrument_type = info.get("type")
                    lot_size = info.get("lot_size")
                    if info.get("ticker"):
                        ensure_figi_dir(figi, account_id)
                except Exception:
                    name = None
                    instrument_type = None
                    lot_size = None

                if pos_type:
                    instrument_type = pos_type

                positions_map[figi] = {
                    "name": name,
                    "instrument_type": instrument_type,
                    "lot_size": lot_size,
                    "qty": qty,
                    "avg_price": avg_price,
                    "current_price": current_price,
                    "value": value,
                    "invested": invested,
                    "pnl_value": pnl_value,
                    "pnl_percent": pnl_percent,
                    "initial_margin": initial_margin,
                    "blocked": blocked,
                }
                total_pnl += pnl_value

            total_value = money_value_to_float(getattr(portfolio, "total_amount_portfolio", None)) or 0.0
            return positions_map, total_pnl, total_value
    except Exception:
        return {}, 0.0, 0.0


def _get_last_prices(client: Client, figis: list[str]) -> dict[str, float]:
    if not figis:
        return {}
    try:
        response = client.market_data.get_last_prices(figi=figis)
    except Exception:
        return {}
    prices = {}
    for item in response.last_prices:
        figi = getattr(item, "figi", None)
        price = quotation_to_float(getattr(item, "price", None))
        if figi and price is not None:
            prices[figi] = price
    return prices


def _refresh_history_for_account(account_id: str, figis: list[str], history_years: int, history_from: Optional[datetime] = None):
    now = datetime.now(timezone.utc).timestamp()
    with _HISTORY_LOCK:
        last = _LAST_HISTORY_REFRESH.get(account_id, 0)
        if now - last < 300:
            return False
        _LAST_HISTORY_REFRESH[account_id] = now
    try:
        token = get_analytics_token(account_id) or getattr(settings, "TOKEN", None)
        if not token:
            return False
        with get_client(token) as client:
            for figi in figis:
                load_trade_history_from_broker(
                    client,
                    account_id,
                    figi,
                    history_years,
                    history_from,
                    lambda f, acc_id=account_id: ensure_figi_dir(f, acc_id),
                    load_json,
                    save_json,
                    log_detail,
                )
        return True
    except Exception:
        return False


def _list_accounts_from_data():
    base_dir = getattr(settings, "BASE_DIR", None)
    if not base_dir:
        base_dir = Path("data")
    if isinstance(base_dir, str):
        base_dir = Path(base_dir)
    if not base_dir.exists():
        return []
    accounts = []
    for entry in base_dir.iterdir():
        if entry.is_dir():
            accounts.append(entry.name)
    return accounts


def _year_start_date(now: Optional[datetime] = None):
    if now is None:
        now = datetime.now(timezone.utc)
    return datetime(now.year, 1, 1, tzinfo=timezone.utc).date()


def _year_start_snapshot_path(account_id: str, year: int):
    base_dir = getattr(settings, "BASE_DIR", None)
    if not base_dir:
        base_dir = Path("data")
    if isinstance(base_dir, str):
        base_dir = Path(base_dir)
    return base_dir / str(account_id) / f"year_start_{year}.json"




def _load_year_start_snapshot(account_id: str, year: int):
    path = _year_start_snapshot_path(account_id, year)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_year_start_snapshot(account_id: str, year: int, value: float, source: str):
    path = _year_start_snapshot_path(account_id, year)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "year": year,
            "value": round(float(value or 0), 6),
            "source": source,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        return payload
    except Exception:
        return None


def _year_start_value_from_settings(account_settings: dict, settings_cfg: dict, year: int):
    for source in (account_settings or {}, settings_cfg or {}):
        if not isinstance(source, dict):
            continue
        values = source.get("YEAR_START_VALUES")
        if isinstance(values, dict):
            raw = values.get(str(year))
            if raw is not None:
                try:
                    return float(raw)
                except Exception:
                    pass
        raw = source.get("YEAR_START_VALUE")
        if raw is not None:
            raw_year = source.get("YEAR_START_YEAR")
            if raw_year is not None:
                try:
                    if int(raw_year) != int(year):
                        continue
                except Exception:
                    continue
            try:
                return float(raw)
            except Exception:
                pass
    return None


def _get_year_start_value(account_id: str, account_settings: dict, settings_cfg: dict):
    now = datetime.now(timezone.utc)
    year = now.year
    override = _year_start_value_from_settings(account_settings, settings_cfg, year)
    if override is not None:
        return override, "config"

    snapshot = _load_year_start_snapshot(account_id, year)
    if isinstance(snapshot, dict) and snapshot.get("year") == year and snapshot.get("value") is not None:
        try:
            return float(snapshot.get("value")), snapshot.get("source") or "snapshot"
        except Exception:
            pass

    # Auto-capture only during the first week of the year
    jan1 = datetime(year, 1, 1, tzinfo=timezone.utc).date()
    if now.date().toordinal() - jan1.toordinal() <= 7:
        _positions, _pnl, live_value = _load_live_portfolio(account_id)
        if live_value is not None:
            saved = _save_year_start_snapshot(account_id, year, live_value, "auto")
            if saved:
                return float(saved.get("value", 0.0)), "auto"

    return None, "missing"


def _figi_year_start_snapshot_path(account_id: str, figi: str, year: int):
    figi_dir = get_figi_dir(figi, account_id, create=False)
    if figi_dir is None:
        base_dir = getattr(settings, "BASE_DIR", None)
        if not base_dir:
            base_dir = Path("data")
        if isinstance(base_dir, str):
            base_dir = Path(base_dir)
        figi_dir = base_dir / str(account_id) / figi
    return figi_dir / f"year_start_{year}.json"


def _load_figi_year_start_snapshot(account_id: str, figi: str, year: int):
    path = _figi_year_start_snapshot_path(account_id, figi, year)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_figi_year_start_snapshot(account_id: str, figi: str, year: int, value: float, source: str):
    path = _figi_year_start_snapshot_path(account_id, figi, year)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "year": year,
            "value": round(float(value or 0), 6),
            "source": source,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)
        return payload
    except Exception:
        return None


def _figi_year_start_value_from_cfg(ticker_cfg: dict, year: int):
    if not isinstance(ticker_cfg, dict):
        return None
    values = ticker_cfg.get("YEAR_START_VALUES")
    if isinstance(values, dict):
        raw = values.get(str(year))
        if raw is not None:
            try:
                return float(raw)
            except Exception:
                pass
    raw = ticker_cfg.get("YEAR_START_VALUE")
    if raw is not None:
        raw_year = ticker_cfg.get("YEAR_START_YEAR")
        if raw_year is not None:
            try:
                if int(raw_year) != int(year):
                    return None
            except Exception:
                return None
        try:
            return float(raw)
        except Exception:
            pass
    return None


def _resolve_go_margins(cfg: dict, meta: dict, live: dict):
    go_buy = None
    go_sell = None
    for src in (cfg or {}, meta or {}, live or {}):
        if not isinstance(src, dict):
            continue
        for key in ("INITIAL_MARGIN_ON_BUY", "initial_margin_on_buy", "GO_BUY_QUAL"):
            raw = src.get(key)
            if raw is not None:
                try:
                    go_buy = float(raw)
                except Exception:
                    pass
        for key in ("INITIAL_MARGIN_ON_SELL", "initial_margin_on_sell", "GO_SELL_QUAL"):
            raw = src.get(key)
            if raw is not None:
                try:
                    go_sell = float(raw)
                except Exception:
                    pass
        if go_buy is None or go_sell is None:
            raw = src.get("INITIAL_MARGIN")
            if raw is None:
                raw = src.get("initial_margin")
            if raw is None:
                raw = src.get("blocked")
            if raw is not None:
                try:
                    raw_val = float(raw)
                    if go_buy is None:
                        go_buy = raw_val
                    if go_sell is None:
                        go_sell = raw_val
                except Exception:
                    pass
    if go_buy is None and go_sell is not None:
        go_buy = go_sell
    if go_sell is None and go_buy is not None:
        go_sell = go_buy
    return go_buy, go_sell


def _live_figi_value_for_mwr(live: dict, instrument_type: str, go_margins: tuple[Optional[float], Optional[float]]):
    if not isinstance(live, dict):
        return None
    qty = float(live.get("qty") or 0)
    pnl = float(live.get("pnl_value") or 0)
    if instrument_type == "futures":
        go_buy, go_sell = go_margins
        go = go_buy if qty >= 0 else go_sell
        if go is None:
            return None
        return abs(qty) * go + pnl
    value = live.get("value")
    if value is None:
        return None
    return float(value)


def _get_figi_year_start_value(
    account_id: str,
    figi: str,
    ticker_cfg: dict,
    instrument_type: str,
    go_margins: tuple[Optional[float], Optional[float]],
    live: dict,
):
    now = datetime.now(timezone.utc)
    year = now.year
    override = _figi_year_start_value_from_cfg(ticker_cfg, year)
    if override is not None:
        return override, "config"

    snapshot = _load_figi_year_start_snapshot(account_id, figi, year)
    if isinstance(snapshot, dict) and snapshot.get("year") == year and snapshot.get("value") is not None:
        try:
            return float(snapshot.get("value")), snapshot.get("source") or "snapshot"
        except Exception:
            pass

    jan1 = datetime(year, 1, 1, tzinfo=timezone.utc).date()
    if now.date().toordinal() - jan1.toordinal() <= 7:
        live_value = _live_figi_value_for_mwr(live, instrument_type, go_margins)
        if live_value is not None:
            saved = _save_figi_year_start_snapshot(account_id, figi, year, live_value, "auto")
            if saved:
                return float(saved.get("value", 0.0)), "auto"
    return None, "missing"


def _compute_mwr_for_figi(
    history: list,
    mode: str,
    commission_rate: float,
    instrument_type: str,
    go_margins: tuple[Optional[float], Optional[float]],
    start_date: datetime.date,
    start_value: Optional[float],
):
    cashflows: list[tuple[datetime.date, float]] = []
    if start_value is not None and abs(start_value) > 1e-9:
        cashflows.append((start_date, -float(start_value)))

    long_pos: list[dict] = []
    short_pos: list[dict] = []
    series: list[dict] = []

    def pop_position(items):
        if not items:
            return None
        if mode == "FIFO":
            return items[0]
        return items[-1]

    def trim_position(items, item):
        if item["qty"] <= 0:
            if mode == "FIFO":
                items.pop(0)
            else:
                items.pop()

    def capital_amount(price: float, qty: float, side: str):
        if instrument_type == "futures":
            go_buy, go_sell = go_margins
            go = go_buy if side == "long" else go_sell
            if go is not None:
                return go * qty
        return price * qty

    def append_flow(flow_date: datetime.date, amount: float):
        if abs(amount) <= 1e-9:
            return
        cashflows.append((flow_date, float(amount)))

    for trade in history:
        side = trade.get("side")
        ts = trade.get("timestamp")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts).date()
        except Exception:
            continue
        if dt < start_date:
            continue
        price = float(trade.get("price", 0) or 0)
        qty = int(trade.get("qty", 0) or 0)
        if qty <= 0 or price == 0:
            continue

        trade_commission = price * qty * commission_rate
        append_flow(dt, -trade_commission)

        if side == "buy":
            # close shorts
            while qty > 0 and short_pos:
                item = pop_position(short_pos)
                close_qty = min(qty, item["qty"])
                realized = close_qty * (item["price"] - price)
                append_flow(dt, realized)
                if instrument_type == "futures":
                    append_flow(dt, capital_amount(price, close_qty, "short"))
                else:
                    append_flow(dt, capital_amount(item["price"], close_qty, "long"))
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(short_pos, item)
            if qty > 0:
                if instrument_type == "futures":
                    append_flow(dt, -capital_amount(price, qty, "long"))
                else:
                    append_flow(dt, -capital_amount(price, qty, "long"))
                long_pos.append({"price": price, "qty": qty})
        elif side == "sell":
            # close longs
            while qty > 0 and long_pos:
                item = pop_position(long_pos)
                close_qty = min(qty, item["qty"])
                realized = close_qty * (price - item["price"])
                append_flow(dt, realized)
                append_flow(dt, capital_amount(item["price"], close_qty, "long"))
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(long_pos, item)
            if qty > 0:
                if instrument_type == "futures":
                    append_flow(dt, -capital_amount(price, qty, "short"))
                else:
                    append_flow(dt, -capital_amount(price, qty, "short"))
                short_pos.append({"price": price, "qty": qty})

        # Build series point using current trade price as mark
        unrealized = 0.0
        for item in long_pos:
            unrealized += (price - item["price"]) * item["qty"]
        for item in short_pos:
            unrealized += (item["price"] - price) * item["qty"]

        if instrument_type == "futures":
            go_buy, go_sell = go_margins
            if go_buy is not None and go_sell is not None:
                long_qty = sum(i["qty"] for i in long_pos)
                short_qty = sum(i["qty"] for i in short_pos)
                end_value = go_buy * long_qty + go_sell * short_qty + unrealized
            else:
                end_value = 0.0
        else:
            net_qty = sum(i["qty"] for i in long_pos) - sum(i["qty"] for i in short_pos)
            end_value = price * net_qty

        rate = _xirr(cashflows + [(dt, end_value)])
        if rate is not None:
            series.append({"t": trade.get("timestamp"), "v": round(rate * 100, 4)})

    return cashflows, series


def _estimate_start_capital_from_history(
    history: list,
    mode: str,
    start_date: datetime.date,
    instrument_type: str,
    go_margins: tuple[Optional[float], Optional[float]],
):
    long_pos: list[dict] = []
    short_pos: list[dict] = []

    def pop_position(items):
        if not items:
            return None
        if mode == "FIFO":
            return items[0]
        return items[-1]

    def trim_position(items, item):
        if item["qty"] <= 0:
            if mode == "FIFO":
                items.pop(0)
            else:
                items.pop()

    for trade in history:
        side = trade.get("side")
        ts = trade.get("timestamp")
        if not ts:
            continue
        try:
            dt = datetime.fromisoformat(ts).date()
        except Exception:
            continue
        if dt >= start_date:
            continue
        price = float(trade.get("price", 0) or 0)
        qty = int(trade.get("qty", 0) or 0)
        if qty <= 0 or price == 0:
            continue
        if side == "buy":
            while qty > 0 and short_pos:
                item = pop_position(short_pos)
                close_qty = min(qty, item["qty"])
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(short_pos, item)
            if qty > 0:
                long_pos.append({"price": price, "qty": qty})
        elif side == "sell":
            while qty > 0 and long_pos:
                item = pop_position(long_pos)
                close_qty = min(qty, item["qty"])
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(long_pos, item)
            if qty > 0:
                short_pos.append({"price": price, "qty": qty})

    if instrument_type == "futures":
        go_buy, go_sell = go_margins
        if go_buy is None or go_sell is None:
            return None
        total_long = sum(i["qty"] for i in long_pos)
        total_short = sum(i["qty"] for i in short_pos)
        return float(total_long) * float(go_buy) + float(total_short) * float(go_sell)

    long_cost = sum(i["price"] * i["qty"] for i in long_pos)
    short_cost = sum(i["price"] * i["qty"] for i in short_pos)
    return float(long_cost + short_cost)


def _xnpv(rate: float, cashflows: list[tuple[datetime.date, float]]):
    if rate <= -1:
        return float("inf")
    t0 = cashflows[0][0]
    total = 0.0
    for dt, amount in cashflows:
        days = (dt - t0).days / 365.0
        total += amount / ((1 + rate) ** days)
    return total


def _xirr(cashflows: list[tuple[datetime.date, float]]):
    if not cashflows:
        return None
    has_pos = any(cf > 0 for _, cf in cashflows)
    has_neg = any(cf < 0 for _, cf in cashflows)
    if not (has_pos and has_neg):
        return None
    cashflows = sorted(cashflows, key=lambda x: x[0])
    low = -0.9999
    high = 1.0
    f_low = _xnpv(low, cashflows)
    f_high = _xnpv(high, cashflows)
    for _ in range(60):
        if f_low == 0:
            return low
        if f_high == 0:
            return high
        if f_low * f_high < 0:
            break
        high *= 2
        if high > 1e6:
            return None
        f_high = _xnpv(high, cashflows)
    if f_low * f_high > 0:
        return None
    mid = None
    for _ in range(100):
        mid = (low + high) / 2
        f_mid = _xnpv(mid, cashflows)
        if abs(f_mid) < 1e-7:
            return mid
        if f_low * f_mid < 0:
            high = mid
            f_high = f_mid
        else:
            low = mid
            f_low = f_mid
    return mid


def _external_cashflows(account_id: str, start_dt: datetime, end_dt: datetime):
    token = get_analytics_token(account_id) or getattr(settings, "TOKEN", None)
    if not token:
        return {}, "no_token"
    try:
        with get_client(token) as client:
            ops = client.operations.get_operations(
                account_id=account_id,
                from_=start_dt,
                to=end_dt,
                state=1,
            ).operations
    except Exception:
        return {}, "fetch_failed"

    flows: dict[str, float] = {}
    for op in ops:
        if op.type not in (
            OperationType.OPERATION_TYPE_INPUT,
            OperationType.OPERATION_TYPE_OUTPUT,
        ):
            continue
        amount = money_value_to_float(getattr(op, "payment", None))
        if amount is None:
            continue
        if op.type == OperationType.OPERATION_TYPE_INPUT:
            cf = -abs(amount)
        else:
            cf = abs(amount)
        dt = getattr(op, "date", None) or getattr(op, "operation_date", None)
        if not dt:
            continue
        key = dt.date().isoformat()
        flows[key] = flows.get(key, 0.0) + float(cf)
    return flows, None


def _realized_pnl_deltas(account_id: str, start_date: datetime.date):
    daily = _aggregate_pnl_daily_for_account(account_id)
    if not daily:
        return {}, 0.0
    start_iso = start_date.isoformat()
    deltas: dict[str, float] = {}
    prev_val = 0.0
    for point in sorted(daily, key=lambda x: x.get("date") or ""):
        date_key = point.get("date")
        if not date_key:
            continue
        value = float(point.get("value", 0.0) or 0.0)
        if date_key < start_iso:
            prev_val = value
            continue
        delta = value - prev_val
        if abs(delta) > 1e-9:
            deltas[date_key] = deltas.get(date_key, 0.0) + delta
        prev_val = value
    total = sum(deltas.values())
    return deltas, total


def _compute_mwr_ytd_for_account(
    account_id: str,
    account_settings: dict,
    settings_cfg: dict,
    end_value_override: Optional[float] = None,
):
    if not account_id:
        return {"value": None, "note": "no_account"}
    now = datetime.now(timezone.utc)
    start_date = _year_start_date(now)
    start_value, start_note = _get_year_start_value(account_id, account_settings, settings_cfg)
    if start_value is None:
        return {"value": None, "note": start_note, "start_value": None}

    cashflows: list[tuple[datetime.date, float]] = []
    if abs(start_value) > 1e-9:
        cashflows.append((start_date, -float(start_value)))

    external, external_note = _external_cashflows(
        account_id,
        datetime.combine(start_date, datetime.min.time(), tzinfo=timezone.utc),
        now,
    )
    for date_key, amount in external.items():
        try:
            dt = datetime.fromisoformat(date_key).date()
        except Exception:
            continue
        if abs(amount) > 1e-9:
            cashflows.append((dt, float(amount)))

    realized_daily, realized_total = _realized_pnl_deltas(account_id, start_date)
    for date_key, amount in realized_daily.items():
        try:
            dt = datetime.fromisoformat(date_key).date()
        except Exception:
            continue
        if abs(amount) > 1e-9:
            cashflows.append((dt, float(amount)))

    end_value = end_value_override
    if end_value is None:
        _positions, _pnl, live_value = _load_live_portfolio(account_id)
        end_value = live_value
    end_value = float(end_value or 0.0)
    adjusted_end = end_value - float(realized_total or 0.0)
    cashflows.append((now.date(), adjusted_end))

    rate = _xirr(cashflows)
    note = None
    if rate is None:
        note = "not_enough_cashflows"
    elif external_note:
        note = external_note

    return {
        "value": rate,
        "note": note or start_note,
        "start_value": float(start_value),
        "end_value": adjusted_end,
    }


def _aggregate_pnl_daily_for_account(account_id: str):
    cfg = _load_config_json()
    settings_cfg = _settings_from_cfg(cfg)
    commission_rate = float(settings_cfg.get("COMMISSION_RATE", getattr(settings, "COMMISSION_RATE", 0.0005)) or 0.0005)
    daily_totals = {}
    if not account_id:
        return []
    figis = _list_figis_from_data(account_id)
    for acc in _get_account_configs():
        if acc.get("ACCOUNT_ID") == account_id:
            figis = list({*figis, *[f for f in (acc.get("TICKERS") or {}).keys() if f not in _EXCLUDE_FIGIS]})
            break
    for figi in figis:
        history = _load_history(account_id, figi)
        figi_commission = 0.0 if figi in _ZERO_COMMISSION_FIGIS else commission_rate
        series = _compute_pnl_series(history, settings_cfg.get("MODE", getattr(settings, "MODE", "LIFO")), figi_commission)
        if not series:
            continue
        last_by_date = {}
        for point in series:
            ts = point.get("t")
            if not ts:
                continue
            try:
                dt = datetime.fromisoformat(ts)
            except Exception:
                continue
            d = dt.date().isoformat()
            last_by_date[d] = point.get("v", 0.0)
        for d, v in last_by_date.items():
            daily_totals[d] = daily_totals.get(d, 0.0) + float(v)

    if not daily_totals:
        return []
    dates = sorted(daily_totals.keys())
    return [{"date": d, "value": round(daily_totals[d], 6)} for d in dates]


def _pnl_today_for_account(account_id: str):
    daily = _aggregate_pnl_daily_for_account(account_id)
    today = datetime.now(timezone.utc).date().isoformat()
    yesterday = (datetime.now(timezone.utc).date()).toordinal() - 1
    yesterday = datetime.fromordinal(yesterday).date().isoformat()
    today_val = next((d["value"] for d in daily if d["date"] == today), 0.0)
    yesterday_val = next((d["value"] for d in daily if d["date"] == yesterday), 0.0)
    return round(today_val - yesterday_val, 2)


def _aggregate_pnl_daily_all():
    accounts = _get_account_configs()
    account_ids = {a.get("ACCOUNT_ID") for a in accounts if a.get("ACCOUNT_ID")}
    account_ids.update(_list_accounts_from_data())
    daily_totals = {}
    for account_id in account_ids:
        daily = _aggregate_pnl_daily_for_account(account_id)
        for d in daily:
            daily_totals[d["date"]] = daily_totals.get(d["date"], 0.0) + float(d["value"])
    if not daily_totals:
        return []
    dates = sorted(daily_totals.keys())
    return [{"date": d, "value": round(daily_totals[d], 6)} for d in dates]


def _slice_daily_series(daily: list[dict], range_key: str):
    if not daily:
        return []
    if range_key == "all":
        return daily
    if range_key == "month":
        return daily[-30:]
    return daily[-7:]


def _estimate_max_for_account(account_id: str):
    accounts = _get_account_configs()
    account = next((a for a in accounts if a.get("ACCOUNT_ID") == account_id), None)
    if not account:
        return {"total": 0.0, "items": []}

    tickers_cfg = account.get("TICKERS") or {}
    figis = [f for f in tickers_cfg.keys() if f not in _EXCLUDE_FIGIS]
    if not figis:
        return {"total": 0.0, "items": []}

    items = []
    total = 0.0
    try:
        token = get_analytics_token(account_id) or getattr(settings, "TOKEN", None)
        if not token:
            return {"total": 0.0, "items": []}
        with get_client(token) as client:
            prices = _get_last_prices(client, figis)
            for figi in figis:
                cfg = tickers_cfg.get(figi, {}) or {}
                if cfg.get("ENABLED", True) is False:
                    continue
                max_lots = int(cfg.get("MAX_LOTS") or 0)
                if max_lots <= 0:
                    continue
                lot_size = cfg.get("LOT_SIZE")
                if lot_size:
                    lot_size = int(lot_size)
                else:
                    try:
                        info = get_figi_info(client, figi)
                        lot_size = int(info.get("lot_size") or 1)
                    except Exception:
                        lot_size = 1
                price = prices.get(figi)
                if price is None:
                    continue
                cost = price * max_lots * lot_size
                min_lots = int(cfg.get("MIN_LOTS_TO_HOLD") or 0)
                min_cost = price * min_lots * lot_size
                total += cost
                items.append({
                    "figi": figi,
                    "name": cfg.get("NAME"),
                    "price": round(price, 6),
                    "max_lots": max_lots,
                    "lot_size": lot_size,
                    "cost": round(cost, 2),
                    "min_lots": min_lots,
                    "min_cost": round(min_cost, 2),
                })
    except Exception:
        return {"total": 0.0, "items": []}

    return {"total": round(total, 2), "items": items}


def _get_instrument_info(figi: str):
    if not figi:
        return None
    try:
        token = get_analytics_token(None) or getattr(settings, "TOKEN", None)
        if not token:
            return None
        with get_client(token) as client:
            inst = client.instruments.get_instrument_by(
                id_type=1,  # INSTRUMENT_ID_TYPE_FIGI
                id=figi,
            ).instrument
            if inst:
                lot_size = getattr(inst, "lot", None)
                if lot_size is None:
                    lot_size = getattr(inst, "lot_size", None)
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
                return {
                    "figi": figi,
                    "ticker": getattr(inst, "ticker", None),
                    "name": getattr(inst, "name", None),
                    "type": mapped or kind_str,
                    "currency": getattr(inst, "currency", None),
                    "lot_size": lot_size,
                }
    except Exception:
        return None
    return None


def _compute_pnl_series(history, mode: str, commission_rate: float):
    # FIFO/LIFO realized PnL based on trade history
    pnl = 0.0
    series = []
    long_pos = []
    short_pos = []

    def pop_position(items):
        if not items:
            return None
        if mode == "FIFO":
            return items[0]
        return items[-1]

    def trim_position(items, item):
        if item["qty"] <= 0:
            if mode == "FIFO":
                items.pop(0)
            else:
                items.pop()

    for trade in history:
        side = trade.get("side")
        price = float(trade.get("price", 0) or 0)
        qty = int(trade.get("qty", 0) or 0)
        if qty <= 0 or price == 0:
            continue
        trade_commission = price * qty * commission_rate
        pnl -= trade_commission
        if side == "buy":
            # cover shorts first
            while qty > 0 and short_pos:
                item = pop_position(short_pos)
                close_qty = min(qty, item["qty"])
                pnl += close_qty * (item["price"] - price)
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(short_pos, item)
            if qty > 0:
                long_pos.append({"price": price, "qty": qty})
        elif side == "sell":
            # close longs first
            while qty > 0 and long_pos:
                item = pop_position(long_pos)
                close_qty = min(qty, item["qty"])
                pnl += close_qty * (price - item["price"])
                item["qty"] -= close_qty
                qty -= close_qty
                trim_position(long_pos, item)
            if qty > 0:
                short_pos.append({"price": price, "qty": qty})

        series.append({
            "t": trade.get("timestamp"),
            "v": round(pnl, 6),
        })

    return series


def update_status(**kwargs):
    with _STATUS_LOCK:
        _STATUS.update(kwargs)


def get_status_snapshot() -> dict:
    with _STATUS_LOCK:
        return dict(_STATUS)


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _DashboardHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload: dict, status_code: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "https://4tseller.ru")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        try:
            self.wfile.write(body)
        except ConnectionAbortedError:
            return
        except Exception:
            return

    def _send_file(self, file_path: Path, download_name: str):
        try:
            data = file_path.read_bytes()
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status_code=404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Disposition", f'attachment; filename="{download_name}"')
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "https://4tseller.ru")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        try:
            self.wfile.write(data)
        except Exception:
            return

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "https://4tseller.ru")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/health", "/api/health"):
            self._send_json({"ok": True, "time": _iso_now()})
            return
        if path in ("/api/status", "/status"):
            payload = get_status_snapshot()
            payload.setdefault("ok", True)
            payload.setdefault("server_time", _iso_now())
            analytics_cfg = load_analytics_settings()
            payload.setdefault("footer_sync_text", analytics_cfg.get("FOOTER_SYNC_TEXT"))
            payload.setdefault("footer_version", analytics_cfg.get("FOOTER_VERSION"))
            self._send_json(payload)
            return
        if path in ("/api/sweetearn/profile", "/sweetearn/profile"):
            profile = _sweetearn_load_profile()
            self._send_json({"ok": True, "profile": profile})
            return
        if path in ("/api/logs", "/logs"):
            qs = parse_qs(parsed.query or "")
            try:
                limit = int((qs.get("limit") or ["200"])[0])
            except Exception:
                limit = 200
            limit = max(10, min(limit, 2000))
            log_path = getattr(settings, "LOG_FILE", "data/bot_logs.log")
            lines = []
            try:
                with open(log_path, "rb") as f:
                    raw = f.read()
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("cp1251", errors="replace")
                lines = text.splitlines()[-limit:]
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc), "lines": []}, status_code=200)
                return
            self._send_json({"ok": True, "lines": lines})
            return
        if path in ("/api/analytics/top100", "/analytics/top100"):
            qs = parse_qs(parsed.query or "")
            refresh = (qs.get("refresh") or ["0"])[0] in ("1", "true", "yes")
            file_path = Path("data") / "analytics" / "top100_shares_rub.json"
            if refresh:
                cfg = load_analytics_settings()
                token = cfg.get("TOKEN") or getattr(settings, "TOKEN", None)
                if token:
                    prev_token = settings.TOKEN
                    settings.TOKEN = token
                    monthly_dir = Path("data") / "analytics" / datetime.now(timezone.utc).strftime("%Y-%m")
                    try:
                        generate_top100_json(file_path, monthly_dir=monthly_dir)
                    finally:
                        settings.TOKEN = prev_token
            if not file_path.exists():
                self._send_json({"ok": False, "error": "not_ready"}, status_code=200)
                return
            try:
                payload = json.loads(file_path.read_text(encoding="utf-8"))
            except Exception as exc:
                self._send_json({"ok": False, "error": str(exc)}, status_code=200)
                return
            if isinstance(payload, dict):
                payload.setdefault("ok", True)
            self._send_json(payload if isinstance(payload, dict) else {"ok": True, "items": payload})
            return
        if path in ("/api/logs/download", "/logs/download"):
            qs = parse_qs(parsed.query or "")
            detail = (qs.get("detail") or ["0"])[0] in ("1", "true", "yes")
            if detail:
                log_path = getattr(settings, "DETAILED_LOG_FILE", None)
                if not log_path:
                    self._send_json({"ok": False, "error": "detailed_log_not_configured"}, status_code=404)
                    return
                file_path = Path(log_path)
                self._send_file(file_path, file_path.name or "bot_logs_detailed.log")
                return
            log_path = getattr(settings, "LOG_FILE", "data/bot_logs.log")
            file_path = Path(log_path)
            self._send_file(file_path, file_path.name or "bot_logs.log")
            return
        if path in ("/api/config", "/config"):
            cfg = _load_config_json()
            self._send_json({"ok": True, "accounts": _get_account_configs(), "settings": _settings_from_cfg(cfg)})
            return
        if path in ("/api/config/raw", "/config/raw"):
            data = _load_config_json()
            self._send_json({"ok": True, "text": json.dumps(data, indent=2, ensure_ascii=False)})
            return
        if path.startswith("/api/cashflow/"):
            if path.startswith("/api/cashflow/stats-chart/"):
                month = unquote(path.split("/api/cashflow/stats-chart/")[1])
                qs = parse_qs(parsed.query or "")
                theme = (qs.get("theme") or ["dark"])[0].lower()
                try:
                    income, expense = _cashflow_get_stats(month)
                    import matplotlib
                    matplotlib.use("Agg")
                    import matplotlib.pyplot as plt
                    is_light = theme == "light"
                    bg = "#ffffff" if is_light else "#0a0a0a"
                    text_color = "#111111" if is_light else "white"
                    grid_color = "#d0d0d0" if is_light else "#333333"
                    fig, ax = plt.subplots(figsize=(6, 4), facecolor=bg)
                    ax.set_facecolor(bg)
                    bars = ax.bar(["Доходы", "Расходы"], [income, expense], color=["#10b981", "#ef4444"])
                    max_val = max(income, expense, 1)
                    ax.set_ylim(0, max_val * 1.2)
                    for rect, val in zip(bars, [income, expense]):
                        ax.text(
                            rect.get_x() + rect.get_width() / 2,
                            rect.get_height() + max_val * 0.03,
                            f"{val:,.0f}",
                            ha="center",
                            va="bottom",
                            fontsize=14,
                            fontweight="bold",
                            color=text_color,
                        )
                    ax.set_ylabel("Сумма", color=text_color, fontsize=12)
                    ax.tick_params(axis="y", labelcolor=text_color)
                    ax.tick_params(axis="x", labelcolor=text_color)
                    ax.spines["bottom"].set_color(text_color)
                    ax.spines["left"].set_color(text_color)
                    ax.spines["top"].set_visible(False)
                    ax.spines["right"].set_visible(False)
                    ax.grid(axis="y", color=grid_color, alpha=0.3)
                    plt.tight_layout()
                    bio = io.BytesIO()
                    plt.savefig(bio, format="png", transparent=True)
                    bio.seek(0)
                    plt.close("all")
                    img_base64 = base64.b64encode(bio.getvalue()).decode("utf-8")
                    self._send_json({"chart": f"data:image/png;base64,{img_base64}"})
                except Exception as exc:
                    self._send_json({"error": str(exc)}, status_code=400)
                return
            if path.startswith("/api/cashflow/stats/"):
                month = unquote(path.split("/api/cashflow/stats/")[1])
                try:
                    income, expense = _cashflow_get_stats(month)
                    self._send_json({"income": income, "expense": expense})
                except Exception as exc:
                    self._send_json({"error": str(exc)}, status_code=400)
                return
            if path.startswith("/api/cashflow/logs/"):
                month = unquote(path.split("/api/cashflow/logs/")[1])
                try:
                    logs = _cashflow_get_logs(month)
                    self._send_json({"logs": logs})
                except Exception as exc:
                    self._send_json({"error": str(exc)}, status_code=400)
                return
            if path in ("/api/cashflow/months",):
                try:
                    months = _cashflow_get_months()
                    self._send_json({
                        "months": months,
                        "current_month": _cashflow_resolve_current_month(months),
                    })
                except Exception as exc:
                    self._send_json({"error": str(exc)}, status_code=400)
                return
            if path in ("/api/cashflow/delete",):
                qs = parse_qs(parsed.query or "")
                row_raw = (qs.get("row") or [""])[0]
                deleted_by = (qs.get("added_by") or [""])[0]
                try:
                    row_index = int(row_raw)
                except Exception:
                    self._send_json({"ok": False, "message": "Неверный индекс"}, status_code=400)
                    return
                ok, message = _cashflow_delete_row(row_index, deleted_by or "—")
                self._send_json({"ok": ok, "message": message})
                return
            if path in ("/api/cashflow/download",):
                qs = parse_qs(parsed.query or "")
                file_type = (qs.get("type") or ["data"])[0]
                if file_type == "logs":
                    file_path = _CASHFLOW_AUDIT_FILE
                    if not file_path.exists():
                        _CASHFLOW_AUDIT_FILE.parent.mkdir(parents=True, exist_ok=True)
                        file_path.write_text("", encoding="utf-8")
                    self._send_file(file_path, file_path.name or "cashflow_audit.log")
                    return
                file_path = _CASHFLOW_FILE
                self._send_file(file_path, file_path.name or "CashFlow.xlsx")
                return
        if path in ("/api/portfolio", "/portfolio"):
            qs = parse_qs(parsed.query or "")
            account_id = (qs.get("account_id") or [""])[0]
            refresh = (qs.get("refresh") or ["0"])[0] == "1"
            accounts = _get_account_configs()
            account = None
            if account_id:
                for acc in accounts:
                    if acc.get("ACCOUNT_ID") == account_id:
                        account = acc
                        break
            if account is None and accounts:
                account = accounts[0]
            if account is None:
                self._send_json({"ok": False, "error": "no_accounts"}, status_code=200)
                return
            cfg = _load_config_json()
            settings_cfg = _settings_from_cfg(cfg)
            commission_rate = float(settings_cfg.get("COMMISSION_RATE", getattr(settings, "COMMISSION_RATE", 0.0005)) or 0.0005)
            mode = str(account.get("SETTINGS", {}).get("MODE") or settings_cfg.get("MODE") or getattr(settings, "MODE", "LIFO"))
            config_figis = [f for f in (account.get("TICKERS") or {}).keys() if f not in _EXCLUDE_FIGIS]
            data_figis = _list_figis_from_data(account.get("ACCOUNT_ID"))
            live_map, live_total, live_value = _load_live_portfolio(account.get("ACCOUNT_ID"))
            live_figis = list(live_map.keys())
            data_figis = [
                f for f in data_figis
                if f in config_figis or f in live_figis or _is_figi_like(f)
            ]
            merged_figis = []
            seen = set()
            for figi in config_figis + live_figis + data_figis:
                if figi in seen:
                    continue
                seen.add(figi)
                merged_figis.append(figi)

            figis = []
            total_pnl = 0.0
            tickers_cfg = account.get("TICKERS") or {}
            info_map = {}
            prices = {}
            try:
                token = get_analytics_token(account.get("ACCOUNT_ID")) or getattr(settings, "TOKEN", None)
                if token:
                    with get_client(token) as client:
                        prices = _get_last_prices(client, merged_figis)
                        for figi in merged_figis:
                            meta = read_figi_meta(figi, account.get("ACCOUNT_ID")) or {}
                            needs_fetch = not meta.get("ticker") or not meta.get("type") or meta.get("lot_size") is None
                            if not needs_fetch:
                                info_map[figi] = meta
                                continue
                            try:
                                info = get_figi_info(client, figi) or {}
                                if isinstance(info, dict) and str(info.get("type")) == "futures":
                                    try:
                                        margin_req = client.instruments.get_futures_margin(figi=figi)
                                        info["initial_margin_on_buy"] = money_value_to_float(
                                            getattr(margin_req, "initial_margin_on_buy", None)
                                        )
                                        info["initial_margin_on_sell"] = money_value_to_float(
                                            getattr(margin_req, "initial_margin_on_sell", None)
                                        )
                                    except Exception:
                                        pass
                                info_map[figi] = info or meta
                                update_figi_meta(figi, account.get("ACCOUNT_ID"), info)
                            except Exception:
                                info_map[figi] = meta
            except Exception:
                info_map = {}

            history_refreshed = False
            if refresh:
                history_from = None
                if bool(settings_cfg.get("HISTORY_FROM_YEAR_START", True)):
                    year_start = _year_start_date()
                    history_from = datetime.combine(year_start, datetime.min.time(), tzinfo=timezone.utc)
                history_refreshed = _refresh_history_for_account(
                    account.get("ACCOUNT_ID"),
                    merged_figis,
                    int(settings_cfg.get("HISTORY_YEARS", getattr(settings, "HISTORY_YEARS", 3)) or 3),
                    history_from,
                )
            for figi in merged_figis:
                cfg = tickers_cfg.get(figi, {})
                history = _load_history(account.get("ACCOUNT_ID"), figi)
                figi_commission = 0.0 if figi in _ZERO_COMMISSION_FIGIS else commission_rate
                series = _compute_pnl_series(history, mode, figi_commission)
                turnover_total = 0.0
                for trade in history:
                    try:
                        price = float(trade.get("price", 0) or 0)
                        qty = float(trade.get("qty", 0) or 0)
                        turnover_total += abs(price * qty)
                    except Exception:
                        continue
                if len(series) > 200:
                    series = series[-200:]
                last_val = series[-1]["v"] if series else 0.0
                total_pnl += float(last_val)
                state_data = _load_state(account.get("ACCOUNT_ID"), figi)
                positions = state_data.get("positions", []) or []
                short_positions = state_data.get("short_positions", []) or []
                qty_long = sum(int(p.get("qty", 0) or 0) for p in positions)
                qty_short = sum(int(p.get("qty", 0) or 0) for p in short_positions)
                live = live_map.get(figi)
                meta = info_map.get(figi, {})
                live_type = _normalize_type(live.get("instrument_type") if live else None)
                cfg_type = _normalize_type(cfg.get("INSTRUMENT_TYPE"))
                meta_type = _normalize_type(meta.get("type"))
                instrument_type = live_type or cfg_type or meta_type
                live_qty = live.get("qty") if live and live.get("qty") is not None else 0
                in_portfolio = abs(live_qty) > 0
                asset_price = None
                if live and live.get("current_price") is not None:
                    asset_price = live.get("current_price")
                else:
                    asset_price = prices.get(figi)
                go_margins = _resolve_go_margins(cfg, meta, live)
                go_buy, go_sell = go_margins
                live_invested = live.get("invested") if live else None
                live_pnl_percent = live.get("pnl_percent") if live else None
                if instrument_type == "futures" and live:
                    qty_for_go = float(live.get("qty") or 0)
                    go_value = None
                    if qty_for_go > 0 and go_buy is not None:
                        go_value = abs(qty_for_go) * go_buy
                    elif qty_for_go < 0 and go_sell is not None:
                        go_value = abs(qty_for_go) * go_sell
                    if go_value is not None:
                        live_invested = go_value
                        pnl_val = float(live.get("pnl_value") or 0)
                        if go_value != 0:
                            live_pnl_percent = (pnl_val / go_value) * 100
                start_value, start_note = _get_figi_year_start_value(
                    account.get("ACCOUNT_ID"),
                    figi,
                    cfg,
                    instrument_type,
                    go_margins,
                    live or {},
                )
                if start_value is None:
                    estimated = _estimate_start_capital_from_history(
                        history,
                        mode,
                        _year_start_date(),
                        instrument_type,
                        go_margins,
                    )
                    if estimated is not None and estimated > 0:
                        saved = _save_figi_year_start_snapshot(
                            account.get("ACCOUNT_ID"),
                            figi,
                            datetime.now(timezone.utc).year,
                            estimated,
                            "history",
                        )
                        if saved:
                            start_value = float(saved.get("value", 0.0))
                            start_note = "history"
                cashflows, mwr_series = _compute_mwr_for_figi(
                    history,
                    mode,
                    figi_commission,
                    instrument_type,
                    go_margins,
                    _year_start_date(),
                    start_value,
                )
                end_value_now = _live_figi_value_for_mwr(live or {}, instrument_type, go_margins)
                mwr_rate = None
                mwr_note = start_note
                if instrument_type == "futures" and (go_margins[0] is None or go_margins[1] is None):
                    mwr_note = "missing_go"
                    mwr_series = []
                elif end_value_now is not None:
                    mwr_rate = _xirr(cashflows + [(datetime.now(timezone.utc).date(), float(end_value_now))])
                    if isinstance(mwr_rate, (int, float)):
                        mwr_series = list(mwr_series or [])
                        mwr_series.append({
                            "t": datetime.now(timezone.utc).isoformat(),
                            "v": round(mwr_rate * 100, 4),
                        })
                cfg_name = cfg.get("NAME")
                if not cfg_name or _is_figi_like(str(cfg_name)):
                    cfg_name = None
                live_name = live.get("name") if live and live.get("name") else None
                meta_name = meta.get("name") if isinstance(meta, dict) else None
                figis.append({
                    "figi": figi,
                    "name": live_name or cfg_name or meta_name or figi,
                    "instrument_type": instrument_type,
                    "lot_size": (
                        live.get("lot_size") if live and live.get("lot_size") else
                        cfg.get("LOT_SIZE") or meta.get("lot_size")
                    ),
                    "asset_price": asset_price,
                    "in_config": figi in tickers_cfg,
                    "enabled": cfg.get("ENABLED", True) if figi in tickers_cfg else None,
                    "in_portfolio": in_portfolio,
                    "qty_long": qty_long,
                    "qty_short": qty_short,
                    "live": True if live else False,
                    "live_qty": live.get("qty") if live else None,
                    "live_value": live.get("value") if live else None,
                    "live_invested": live_invested,
                    "live_pnl_value": live.get("pnl_value") if live else None,
                    "live_pnl_percent": live_pnl_percent,
                    "turnover_total": round(turnover_total, 2),
                    "series": series,
                    "mwr_series": mwr_series[-200:] if isinstance(mwr_series, list) else [],
                    "mwr_ytd": round(mwr_rate * 100, 4) if isinstance(mwr_rate, (int, float)) else None,
                    "mwr_note": mwr_note,
                    "last": last_val,
                })
            mwr_info = _compute_mwr_ytd_for_account(
                account.get("ACCOUNT_ID"),
                account.get("SETTINGS") or {},
                settings_cfg,
                end_value_override=live_value,
            )
            self._send_json({
                "ok": True,
                "account_id": account.get("ACCOUNT_ID"),
                "name": account.get("NAME"),
                "total_pnl": round(total_pnl, 6),
                "total_pnl_live": round(live_total, 6),
                "total_value_live": round(live_value, 2),
                "mwr_ytd": round(mwr_info["value"] * 100, 4) if isinstance(mwr_info.get("value"), (int, float)) else None,
                "mwr_note": mwr_info.get("note"),
                "mwr_start_value": mwr_info.get("start_value"),
                "history_refreshed": history_refreshed,
                "figis": figis,
            })
            return
        if path in ("/api/portfolios_summary", "/portfolios_summary"):
            accounts = _get_account_configs()
            cfg = _load_config_json()
            settings_cfg = _settings_from_cfg(cfg)
            commission_rate = float(settings_cfg.get("COMMISSION_RATE", getattr(settings, "COMMISSION_RATE", 0.0005)) or 0.0005)
            result = []
            for acc in accounts:
                mode = str(acc.get("SETTINGS", {}).get("MODE") or settings_cfg.get("MODE") or getattr(settings, "MODE", "LIFO"))
                config_figis = [f for f in (acc.get("TICKERS") or {}).keys() if f not in _EXCLUDE_FIGIS]
                data_figis = _list_figis_from_data(acc.get("ACCOUNT_ID"))
                live_map, live_total, live_value = _load_live_portfolio(acc.get("ACCOUNT_ID"))
                live_figis = list(live_map.keys())
                data_figis = [
                    f for f in data_figis
                    if f in config_figis or f in live_figis or _is_figi_like(f)
                ]
                merged = []
                seen = set()
                for figi in config_figis + live_figis + data_figis:
                    if figi in seen:
                        continue
                    seen.add(figi)
                    merged.append(figi)
                total = 0.0
                for figi in merged:
                    history = _load_history(acc.get("ACCOUNT_ID"), figi)
                    figi_commission = 0.0 if figi in _ZERO_COMMISSION_FIGIS else commission_rate
                    series = _compute_pnl_series(history, mode, figi_commission)
                    last_val = series[-1]["v"] if series else 0.0
                    total += float(last_val)
                mwr_info = _compute_mwr_ytd_for_account(
                    acc.get("ACCOUNT_ID"),
                    acc.get("SETTINGS") or {},
                    settings_cfg,
                    end_value_override=live_value,
                )
                result.append({
                    "ACCOUNT_ID": acc.get("ACCOUNT_ID"),
                    "NAME": acc.get("NAME"),
                    "total_pnl": round(total, 6),
                    "total_pnl_live": round(live_total, 6),
                    "total_value_live": round(live_value, 2),
                    "pnl_today": _pnl_today_for_account(acc.get("ACCOUNT_ID")),
                    "mwr_ytd": round(mwr_info["value"] * 100, 4) if isinstance(mwr_info.get("value"), (int, float)) else None,
                    "mwr_note": mwr_info.get("note"),
                    "mwr_start_value": mwr_info.get("start_value"),
                })
            self._send_json({"ok": True, "accounts": result})
            return
        if path in ("/api/summary", "/summary"):
            qs = parse_qs(parsed.query or "")
            range_key = (qs.get("range") or ["month"])[0]
            if range_key not in ("day", "week", "month", "all"):
                range_key = "month"
            daily = _aggregate_pnl_daily_all()
            today = datetime.now(timezone.utc).date().isoformat()
            yesterday = (datetime.now(timezone.utc).date()).toordinal() - 1
            yesterday = datetime.fromordinal(yesterday).date().isoformat()
            today_val = next((d["value"] for d in daily if d["date"] == today), 0.0)
            yesterday_val = next((d["value"] for d in daily if d["date"] == yesterday), 0.0)
            pnl_today = today_val - yesterday_val
            if range_key == "day":
                series = daily[-1:] if daily else []
            else:
                series = _slice_daily_series(daily, range_key)

            total_value = 0.0
            for acc in _get_account_configs():
                _, _, live_value = _load_live_portfolio(acc.get("ACCOUNT_ID"))
                total_value += float(live_value or 0)

            self._send_json({
                "ok": True,
                "total_value": round(total_value, 2),
                "pnl_today": round(pnl_today, 2),
                "series": series,
                "range": range_key,
            })
            return
        if path in ("/api/portfolio_pnl", "/portfolio_pnl"):
            qs = parse_qs(parsed.query or "")
            account_id = (qs.get("account_id") or [""])[0]
            range_key = (qs.get("range") or ["week"])[0]
            if range_key not in ("week", "month", "all"):
                range_key = "week"
            daily = _aggregate_pnl_daily_for_account(account_id)
            series = _slice_daily_series(daily, range_key)
            pnl_today = _pnl_today_for_account(account_id)
            self._send_json({
                "ok": True,
                "account_id": account_id,
                "range": range_key,
                "pnl_today": round(pnl_today, 2),
                "series": series,
            })
            return
        if path in ("/api/estimate_max", "/estimate_max"):
            qs = parse_qs(parsed.query or "")
            account_id = (qs.get("account_id") or [""])[0]
            data = _estimate_max_for_account(account_id)
            self._send_json({
                "ok": True,
                "account_id": account_id,
                "total": data.get("total", 0.0),
                "items": data.get("items", []),
            })
            return
        if path in ("/api/figi_info", "/figi_info"):
            qs = parse_qs(parsed.query or "")
            figi = (qs.get("figi") or [""])[0]
            info = _get_instrument_info(figi)
            if not info:
                self._send_json({"ok": False, "error": "not_found"}, status_code=200)
                return
            self._send_json({"ok": True, "info": info})
            return
        self._send_json({"ok": False, "error": "not_found"}, status_code=404)

    def do_POST(self):
        if self.path not in ("/api/control", "/control"):
            if self.path in ("/api/sweetearn/profile", "/sweetearn/profile"):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except Exception:
                    payload = {}
                ok, result = _sweetearn_save_profile(payload if isinstance(payload, dict) else {})
                if not ok:
                    self._send_json({"ok": False, "error": result}, status_code=400)
                else:
                    self._send_json({"ok": True, "profile": result})
                return
            if self.path in ("/api/cashflow/add-transaction",):
                length = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(length) if length > 0 else b""
                try:
                    params = parse_qs(raw.decode("utf-8"))
                except Exception:
                    params = {}
                transaction_type = (params.get("transaction_type") or [""])[0]
                category_key = (params.get("category_key") or [""])[0]
                amount_raw = (params.get("amount") or ["0"])[0]
                description = (params.get("description") or [""])[0]
                added_by = (params.get("added_by") or [""])[0] or "Web"
                try:
                    amount = float(amount_raw)
                except Exception:
                    amount = 0.0
                try:
                    ok, msg = _cashflow_add_transaction(transaction_type, category_key, amount, description, added_by)
                    if not ok:
                        self._send_json({"message": msg}, status_code=400)
                    else:
                        self._send_json({"message": msg})
                except Exception as exc:
                    self._send_json({"message": str(exc)}, status_code=400)
                return
            if self.path in ("/api/config/raw", "/config/raw"):
                length = int(self.headers.get("Content-Length", "0"))
                try:
                    raw = self.rfile.read(length) if length > 0 else b"{}"
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json({"ok": False, "error": "bad_json"}, status_code=400)
                    return
                text = data.get("text")
                if not isinstance(text, str):
                    self._send_json({"ok": False, "error": "missing_text"}, status_code=400)
                    return
                try:
                    parsed = json.loads(text)
                except Exception as exc:
                    self._send_json({"ok": False, "error": f"invalid_json: {exc}"}, status_code=400)
                    return
                if not isinstance(parsed, dict):
                    self._send_json({"ok": False, "error": "root_not_object"}, status_code=400)
                    return
                ok = _save_config_json(parsed)
                if ok:
                    _trigger_config_reload()
                self._send_json({"ok": ok})
                return
            if self.path in ("/api/config/update", "/config/update"):
                length = int(self.headers.get("Content-Length", "0"))
                try:
                    raw = self.rfile.read(length) if length > 0 else b"{}"
                    data = json.loads(raw.decode("utf-8"))
                except Exception:
                    self._send_json({"ok": False, "error": "bad_json"}, status_code=400)
                    return
                cfg = _load_config_json()
                if not isinstance(cfg, dict):
                    cfg = {}
                cfg.setdefault("settings", {})
                cfg.setdefault("accounts", [])

                account_id = str(data.get("account_id") or "")
                settings_fields = data.get("settings_fields")
                account_fields = data.get("account_fields")
                account_settings = data.get("account_settings")
                figi = data.get("figi")
                figi_fields = data.get("figi_fields")

                if isinstance(settings_fields, dict):
                    cfg["settings"].update(settings_fields)

                if account_id:
                    accounts = cfg.get("accounts")
                    if not isinstance(accounts, list):
                        accounts = []
                        cfg["accounts"] = accounts
                    target = None
                    for acc in accounts:
                        if str(acc.get("ACCOUNT_ID") or "") == account_id:
                            target = acc
                            break
                    if target is None:
                        target = {"ACCOUNT_ID": account_id, "TICKERS": {}, "SETTINGS": {}}
                        accounts.append(target)

                    if isinstance(account_fields, dict):
                        target.update(account_fields)
                    if isinstance(account_settings, dict):
                        target.setdefault("SETTINGS", {})
                        target["SETTINGS"].update(account_settings)
                    if figi and isinstance(figi_fields, dict):
                        target.setdefault("TICKERS", {})
                        if figi_fields.get("_delete"):
                            try:
                                target["TICKERS"].pop(figi, None)
                            except Exception:
                                pass
                        else:
                            target["TICKERS"].setdefault(figi, {})
                            target["TICKERS"][figi].update(figi_fields)

                ok = _save_config_json(cfg)
                if ok:
                    _trigger_config_reload()
                self._send_json({"ok": ok})
                return

            self._send_json({"ok": False, "error": "not_found"}, status_code=404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            raw = self.rfile.read(length) if length > 0 else b"{}"
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send_json({"ok": False, "error": "bad_json"}, status_code=400)
            return
        action = str(data.get("action") or "").strip().lower()
        if action not in ("start", "stop", "cancel", "cancel_rebalance"):
            self._send_json({"ok": False, "error": "unknown_action"}, status_code=400)
            return
        with _ACTIONS_LOCK:
            callback = _ACTIONS.get(action)
        if callback is None:
            self._send_json({"ok": False, "error": "action_not_available"}, status_code=400)
            return
        try:
            result = callback()
            self._send_json({"ok": True, "action": action, "result": result})
        except Exception as exc:
            self._send_json({"ok": False, "error": str(exc)}, status_code=500)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/api/cashflow/cancel-last",):
            qs = parse_qs(parsed.query or "")
            added_by = (qs.get("added_by") or [""])[0]
            try:
                ok, msg = _cashflow_cancel_last(added_by)
                if ok:
                    self._send_json({"message": msg})
                else:
                    self._send_json({"message": msg}, status_code=404)
            except Exception as exc:
                self._send_json({"message": str(exc)}, status_code=400)
            return
        if path in ("/api/cashflow/delete",):
            qs = parse_qs(parsed.query or "")
            row_raw = (qs.get("row") or [""])[0]
            deleted_by = (qs.get("added_by") or [""])[0]
            try:
                row_index = int(row_raw)
            except Exception:
                self._send_json({"ok": False, "message": "Неверный индекс"}, status_code=400)
                return
            ok, message = _cashflow_delete_row(row_index, deleted_by or "—")
            self._send_json({"ok": ok, "message": message})
            return
        self._send_json({"ok": False, "error": "not_found"}, status_code=404)

    def log_message(self, _format, *_args):
        # Silence default HTTP server logs.
        return


def start_dashboard_api() -> Optional[ThreadingHTTPServer]:
    logger = get_logger()
    if not getattr(settings, "DASHBOARD_API_ENABLED", False):
        logger.info("Dashboard API disabled - skipping API startup")
        return None

    host = getattr(settings, "DASHBOARD_API_HOST", "127.0.0.1")
    port = int(getattr(settings, "DASHBOARD_API_PORT", 8000))

    try:
        server = ThreadingHTTPServer((host, port), _DashboardHandler)
    except Exception as exc:
        logger.error(f"Failed to start dashboard API: {exc}")
        return None

    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    logger.info(f"Dashboard API started at http://{host}:{port}")
    return server


def stop_dashboard_api(server: Optional[ThreadingHTTPServer]):
    if server is None:
        return
    try:
        server.shutdown()
        server.server_close()
    except Exception:
        pass


def register_dashboard_actions_extended(on_start=None, on_stop=None, on_cancel=None, on_cancel_rebalance=None):
    with _ACTIONS_LOCK:
        _ACTIONS["start"] = on_start
        _ACTIONS["stop"] = on_stop
        _ACTIONS["cancel"] = on_cancel
        _ACTIONS["cancel_rebalance"] = on_cancel_rebalance


def register_config_reload(callback):
    global _CONFIG_RELOAD
    with _CONFIG_LOCK:
        _CONFIG_RELOAD = callback


def _trigger_config_reload():
    with _CONFIG_LOCK:
        cb = _CONFIG_RELOAD
    if cb:
        try:
            cb()
        except Exception:
            pass
