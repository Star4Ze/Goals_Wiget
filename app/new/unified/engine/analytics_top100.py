import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pytz
from tinkoff.invest import Client, InstrumentStatus, CandleInterval

from engine import settings
from engine.analytics_config import load_analytics_settings
from engine.client_factory import get_client


RSI_PERIOD = 14
TREND_FLAT_PCT = 2.0


def _quotation_to_float(q):
    if q is None:
        return None
    if hasattr(q, "units") and hasattr(q, "nano"):
        return float(q.units) + float(q.nano) / 1e9
    try:
        return float(q)
    except Exception:
        return None


def _is_russian_rub_share(share) -> bool:
    if getattr(share, "currency", "").lower() != "rub":
        return False
    country = (getattr(share, "country_of_risk", "") or "").upper()
    if country and country not in ("RU", "RUS"):
        return False
    return True


def _get_lot_size(share) -> int:
    return int(getattr(share, "lot", None) or getattr(share, "lot_size", None) or 1)


def _get_last_daily_candle(client: Client, figi: str):
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=7)
    try:
        candles = client.market_data.get_candles(
            figi=figi,
            from_=start,
            to=now,
            interval=CandleInterval.CANDLE_INTERVAL_DAY,
        ).candles
    except Exception:
        return None
    if not candles:
        return None
    for candle in reversed(candles):
        if getattr(candle, "volume", 0) > 0:
            return candle
    return None


def _serialize_dt(value) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:
            pass
    return str(value)


def _compute_rsi(closes: list[float], period: int = RSI_PERIOD) -> Optional[float]:
    if len(closes) <= period:
        return None
    gains = []
    losses = []
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0.0))
        losses.append(max(-change, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    if avg_loss == 0:
        rsi = 100.0
    else:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        gain = max(change, 0.0)
        loss = max(-change, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        if avg_loss == 0:
            rsi = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
    return round(rsi, 2)


def _compute_hourly_range_pct(candles) -> Optional[float]:
    ranges = []
    for c in candles:
        high = _quotation_to_float(getattr(c, "high", None))
        low = _quotation_to_float(getattr(c, "low", None))
        close = _quotation_to_float(getattr(c, "close", None))
        if high is None or low is None or close is None or close <= 0:
            continue
        ranges.append(((high - low) / close) * 100.0)
    if not ranges:
        return None
    return round(sum(ranges) / len(ranges), 4)


def _trend_month(closes: list[float]) -> Optional[str]:
    if len(closes) < 2:
        return None
    first = closes[0]
    last = closes[-1]
    if first == 0:
        return None
    change_pct = ((last - first) / first) * 100.0
    if change_pct >= TREND_FLAT_PCT:
        return "вверх"
    if change_pct <= -TREND_FLAT_PCT:
        return "вниз"
    return "флет"


def _compute_wave_averages_pct_from_candles(candles) -> tuple[Optional[float], Optional[float]]:
    if len(candles) < 3:
        return None, None
    direction = 0
    first = candles[0]
    first_close = _quotation_to_float(getattr(first, "close", None))
    first_low = _quotation_to_float(getattr(first, "low", None))
    first_high = _quotation_to_float(getattr(first, "high", None))
    if first_close is None or first_low is None or first_high is None:
        return None, None
    pivot_low = first_low
    pivot_high = first_high
    prev_close = first_close
    up_moves = []
    down_moves = []
    for c in candles[1:]:
        close = _quotation_to_float(getattr(c, "close", None))
        low = _quotation_to_float(getattr(c, "low", None))
        high = _quotation_to_float(getattr(c, "high", None))
        if close is None or low is None or high is None:
            continue
        change = close - prev_close
        new_dir = 1 if change > 0 else -1 if change < 0 else direction
        if direction == 0:
            direction = new_dir
        elif new_dir != 0 and new_dir != direction:
            if direction > 0:
                move_pct = ((pivot_high - pivot_low) / pivot_low) * 100.0 if pivot_low else 0.0
                if move_pct > 0:
                    up_moves.append(move_pct)
                pivot_high = high
                pivot_low = low
            else:
                move_pct = ((pivot_high - pivot_low) / pivot_high) * 100.0 if pivot_high else 0.0
                if move_pct > 0:
                    down_moves.append(move_pct)
                pivot_high = high
                pivot_low = low
            direction = new_dir
        if direction >= 0:
            pivot_high = max(pivot_high, high)
        if direction <= 0:
            pivot_low = min(pivot_low, low)
        prev_close = close
    if direction > 0:
        move_pct = ((pivot_high - pivot_low) / pivot_low) * 100.0 if pivot_low else 0.0
        if move_pct > 0:
            up_moves.append(move_pct)
    elif direction < 0:
        move_pct = ((pivot_high - pivot_low) / pivot_high) * 100.0 if pivot_high else 0.0
        if move_pct > 0:
            down_moves.append(move_pct)
    avg_up = round(sum(up_moves) / len(up_moves), 4) if up_moves else None
    avg_down = round(sum(down_moves) / len(down_moves), 4) if down_moves else None
    return avg_up, avg_down


def _get_hourly_candles(client: Client, figi: str):
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=30)
    try:
        return client.market_data.get_candles(
            figi=figi,
            from_=start,
            to=now,
            interval=CandleInterval.CANDLE_INTERVAL_HOUR,
        ).candles
    except Exception:
        return []


def _get_daily_candles_month(client: Client, figi: str):
    now = datetime.now(timezone.utc)
    start = now - timedelta(days=30)
    try:
        return client.market_data.get_candles(
            figi=figi,
            from_=start,
            to=now,
            interval=CandleInterval.CANDLE_INTERVAL_DAY,
        ).candles
    except Exception:
        return []


def _compute_daily_waves_pct(candles, reversal_pct: float) -> tuple[Optional[float], Optional[float]]:
    if len(candles) < 3:
        return None, None
    # ZigZag-like on daily high/low with reversal threshold
    direction = 0  # 1 up, -1 down
    first = candles[0]
    first_low = _quotation_to_float(getattr(first, "low", None))
    first_high = _quotation_to_float(getattr(first, "high", None))
    if first_low is None or first_high is None:
        return None, None
    pivot_low = first_low
    pivot_high = first_high
    up_moves = []
    down_moves = []
    for c in candles[1:]:
        low = _quotation_to_float(getattr(c, "low", None))
        high = _quotation_to_float(getattr(c, "high", None))
        if low is None or high is None:
            continue
        # Initialize direction once movement exceeds reversal_pct
        if direction == 0:
            if high >= pivot_high * (1 + reversal_pct / 100.0):
                direction = 1
                pivot_high = high
                pivot_low = min(pivot_low, low)
            elif low <= pivot_low * (1 - reversal_pct / 100.0):
                direction = -1
                pivot_low = low
                pivot_high = max(pivot_high, high)
            else:
                pivot_high = max(pivot_high, high)
                pivot_low = min(pivot_low, low)
            continue

        if direction > 0:
            # Up wave: track new highs
            if high > pivot_high:
                pivot_high = high
            # Reversal to down?
            if low <= pivot_high * (1 - reversal_pct / 100.0):
                move_pct = ((pivot_high - pivot_low) / pivot_low) * 100.0 if pivot_low else 0.0
                if move_pct >= reversal_pct:
                    up_moves.append(move_pct)
                pivot_low = low
                pivot_high = high
                direction = -1
        else:
            # Down wave: track new lows
            if low < pivot_low:
                pivot_low = low
            # Reversal to up?
            if high >= pivot_low * (1 + reversal_pct / 100.0):
                move_pct = ((pivot_high - pivot_low) / pivot_high) * 100.0 if pivot_high else 0.0
                if move_pct >= reversal_pct:
                    down_moves.append(move_pct)
                pivot_high = high
                pivot_low = low
                direction = 1

    # finalize last wave
    if direction > 0:
        move_pct = ((pivot_high - pivot_low) / pivot_low) * 100.0 if pivot_low else 0.0
        if move_pct >= reversal_pct:
            up_moves.append(move_pct)
    elif direction < 0:
        move_pct = ((pivot_high - pivot_low) / pivot_high) * 100.0 if pivot_high else 0.0
        if move_pct >= reversal_pct:
            down_moves.append(move_pct)

    avg_up = round(sum(up_moves) / len(up_moves), 4) if up_moves else None
    avg_down = round(sum(down_moves) / len(down_moves), 4) if down_moves else None
    return avg_up, avg_down


def generate_top100_json(output_path: Path, monthly_dir: Optional[Path] = None) -> Optional[dict]:
    analytics_cfg = load_analytics_settings()
    token = analytics_cfg.get("TOKEN") or getattr(settings, "TOKEN", None)
    if not token:
        return None
    recommend_k = analytics_cfg.get("WAVE_RECOMMEND_K")
    reversal_pct = analytics_cfg.get("WAVE_REVERSAL_PCT", 1.5)
    try:
        recommend_k = float(recommend_k)
    except Exception:
        recommend_k = 0.5
    try:
        reversal_pct = float(reversal_pct)
    except Exception:
        reversal_pct = 1.5
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    with get_client(token) as client:
        shares = client.instruments.shares(
            instrument_status=InstrumentStatus.INSTRUMENT_STATUS_BASE
        ).instruments

        filtered = [s for s in shares if _is_russian_rub_share(s)]
        for idx, share in enumerate(filtered, 1):
            figi = getattr(share, "figi", "")
            candle = _get_last_daily_candle(client, figi)
            if candle is None:
                continue
            close_price = _quotation_to_float(getattr(candle, "close", None))
            volume = getattr(candle, "volume", 0) or 0
            if close_price is None or volume <= 0:
                continue
            lot = _get_lot_size(share)
            turnover = close_price * float(volume) * float(lot)
            rows.append({
                "ticker": getattr(share, "ticker", "") or "",
                "figi": figi,
                "name": getattr(share, "name", "") or "",
                "price": round(close_price, 6),
                "turnover_rub": round(turnover, 2),
                "volume_lots": int(volume),
                "lot_size": lot,
                "candle_date": _serialize_dt(getattr(candle, "time", None)),
            })

            if idx % 25 == 0:
                time.sleep(0.1)

    rows.sort(key=lambda r: r["turnover_rub"], reverse=True)
    top = rows[:100]

    enriched = []
    with get_client(token) as client:
        for item in top:
            figi = item.get("figi")
            candles_1h = _get_hourly_candles(client, figi) if figi else []
            candles_day = _get_daily_candles_month(client, figi) if figi else []
            closes = []
            for c in candles_1h:
                close = _quotation_to_float(getattr(c, "close", None))
                if close is not None:
                    closes.append(close)
            prices_3d = closes[-72:] if len(closes) >= 2 else []
            avg_range_pct = _compute_hourly_range_pct(candles_1h)
            wave_up_pct, wave_down_pct = _compute_daily_waves_pct(candles_day, reversal_pct)
            rsi = _compute_rsi(closes, RSI_PERIOD) if closes else None
            trend = _trend_month(closes) if closes else None
            recommended_step_pct = round(avg_range_pct * recommend_k, 4) if avg_range_pct is not None else None
            recommended_buy_pct = round(wave_down_pct * recommend_k, 4) if wave_down_pct is not None else None
            recommended_sell_pct = round(wave_up_pct * recommend_k, 4) if wave_up_pct is not None else None
            enriched.append({
                **item,
                "prices_3d": prices_3d,
                "trend_month": trend,
                "rsi": rsi,
                "recommended_step_pct": recommended_step_pct,
                "wave_up_pct": wave_up_pct,
                "wave_down_pct": wave_down_pct,
                "recommended_buy_pct": recommended_buy_pct,
                "recommended_sell_pct": recommended_sell_pct,
            })

            if monthly_dir and figi:
                try:
                    ticker = item.get("ticker") or figi
                    safe_ticker = "".join(ch for ch in str(ticker) if ch.isalnum() or ch in ("_", "-")).strip()
                    if not safe_ticker:
                        safe_ticker = figi
                    month_candles_path = monthly_dir / f"{safe_ticker}.json"
                    payload_candles = [
                        {
                            "t": _serialize_dt(getattr(c, "time", None)),
                            "h": _quotation_to_float(getattr(c, "high", None)),
                            "l": _quotation_to_float(getattr(c, "low", None)),
                            "c": _quotation_to_float(getattr(c, "close", None)),
                        }
                        for c in candles_1h
                    ]
                    month_candles_path.write_text(
                        json.dumps(payload_candles, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    month_daily_path = monthly_dir / f"{safe_ticker}_day.json"
                    payload_day = [
                        {
                            "t": _serialize_dt(getattr(c, "time", None)),
                            "h": _quotation_to_float(getattr(c, "high", None)),
                            "l": _quotation_to_float(getattr(c, "low", None)),
                            "c": _quotation_to_float(getattr(c, "close", None)),
                        }
                        for c in candles_day
                    ]
                    month_daily_path.write_text(
                        json.dumps(payload_day, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                except Exception:
                    pass

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "items": [
            {**row, "rank": i} for i, row in enumerate(enriched, 1)
        ],
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    if monthly_dir:
        try:
            monthly_dir.mkdir(parents=True, exist_ok=True)
            month_file = monthly_dir / output_path.name
            month_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
    return payload


def should_generate_today(last_date: Optional[datetime.date], now_msk: datetime) -> bool:
    if last_date == now_msk.date():
        return False
    target_time = now_msk.replace(hour=23, minute=0, second=0, microsecond=0)
    return now_msk >= target_time


def generate_if_needed(last_date: Optional[datetime.date]) -> Optional[datetime.date]:
    now_msk = datetime.now(pytz.timezone("Europe/Moscow"))
    if not should_generate_today(last_date, now_msk):
        return last_date
    output_path = Path("data") / "analytics" / "top100_shares_rub.json"
    monthly_dir = Path("data") / "analytics" / now_msk.strftime("%Y-%m")
    result = generate_top100_json(output_path, monthly_dir=monthly_dir)
    if result is None:
        return last_date
    return now_msk.date()


__all__ = ["generate_if_needed", "generate_top100_json"]
