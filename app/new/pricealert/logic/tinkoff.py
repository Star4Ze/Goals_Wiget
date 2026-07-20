import asyncio
import sqlite3
import time
import logging
from datetime import datetime, timezone
import httpx
from typing import Optional
from logic.db import (
    CONFIG,
    get_registry_db,
    store_candles,
    get_cached_candles,
    find_gaps,
    get_ticker_by_figi
)

log = logging.getLogger("pricealert")

TOKEN = CONFIG["tinkoff"]["token"]
BASE_URL = CONFIG["tinkoff"]["base_url"]

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "accept": "application/json"
}

async def t_post(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=20) as c:
        r = await c.post(f"{BASE_URL}{path}", headers=HEADERS, json=body)
        r.raise_for_status()
        return r.json()

def nano_to_float(q: dict) -> float:
    if not q:
        return 0.0
    return round(int(q.get("units", 0)) + int(q.get("nano", 0)) / 1e9, 6)

def parse_ts(ts_str: str) -> int:
    try:
        return int(datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp())
    except:
        return 0

# ── Instrument registry ───────────────────────────────────────────────────────
REGISTRY_LOADED = False
REGISTRY_LOCK = asyncio.Lock()

async def load_registry():
    global REGISTRY_LOADED
    async with REGISTRY_LOCK:
        if REGISTRY_LOADED:
            return
        conn = sqlite3.connect(get_registry_db())
        count = conn.execute("SELECT COUNT(*) FROM instruments").fetchone()[0]
        conn.close()
        if count > 100:
            REGISTRY_LOADED = True
            log.info(f"Registry already loaded: {count} instruments")
            return
        log.info("Loading instrument registry from Tinkoff...")
        await _fetch_instruments("shares", "share")
        await _fetch_instruments("etfs", "etf")
        await _fetch_instruments("futures", "future")
        await _fetch_instruments("bonds", "bond")
        await _fetch_instruments("currencies", "currency")
        # Rebuild FTS
        conn = sqlite3.connect(get_registry_db())
        conn.execute("INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')")
        conn.commit()
        conn.close()
        REGISTRY_LOADED = True
        log.info("Registry loaded.")

async def load_all_registries():
    await load_registry()
    try:
        from logic.moex import load_registry_moex
        await load_registry_moex()
    except Exception as e:
        log.error(f"Failed to load MOEX registry: {e}")


async def _fetch_instruments(endpoint: str, itype: str):
    try:
        svc = "tinkoff.public.invest.api.contract.v1.InstrumentsService"
        method = endpoint[0].upper() + endpoint[1:]  # Shares, Etfs...
        data = await t_post(f"/{svc}/{method}", {"instrumentStatus": "INSTRUMENT_STATUS_BASE"})
        instruments = data.get("instruments", [])
        conn = sqlite3.connect(get_registry_db())
        now = int(time.time())
        for inst in instruments:
            figi = inst.get("figi", "")
            ticker = inst.get("ticker", "")
            name = inst.get("name", "")
            if not figi or not ticker:
                continue
            conn.execute("""INSERT OR REPLACE INTO instruments(figi,ticker,name,type,currency,lot,exchange,sector,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (figi, ticker, name, itype,
                 inst.get("currency", ""), inst.get("lot", 1),
                 inst.get("exchange", ""), inst.get("sector", ""), now))
        conn.commit()
        conn.close()
        log.info(f"  Loaded {len(instruments)} {itype}s")
    except Exception as e:
        log.warning(f"Failed to load {endpoint}: {e}")

def search_registry(q: str, limit=20) -> list:
    q = q.strip().upper()
    conn = sqlite3.connect(get_registry_db())
    conn.row_factory = sqlite3.Row
    # Exact ticker match first
    rows = conn.execute(
        "SELECT * FROM instruments WHERE ticker LIKE ? ORDER BY ticker LIMIT ?",
        (q+"%", limit)
    ).fetchall()
    if len(rows) < limit:
        extra = conn.execute(
            "SELECT * FROM instruments WHERE name LIKE ? AND ticker NOT LIKE ? ORDER BY name LIMIT ?",
            ("%"+q+"%", q+"%", limit - len(rows))
        ).fetchall()
        rows = list(rows) + list(extra)
    conn.close()
    return [dict(r) for r in rows[:limit]]

# ── Fetch candles from Tinkoff ────────────────────────────────────────────────
INTERVAL_MAP = {
    "1min": "CANDLE_INTERVAL_1_MIN",
    "5min": "CANDLE_INTERVAL_5_MIN",
    "15min": "CANDLE_INTERVAL_15_MIN",
    "hour": "CANDLE_INTERVAL_HOUR",
    "4hour": "CANDLE_INTERVAL_4_HOUR",
    "day": "CANDLE_INTERVAL_DAY"
}
INTERVAL_SEC = {"1min": 60, "5min": 300, "15min": 900, "hour": 3600, "4hour": 14400, "day": 86400}

async def fetch_candles_api(figi: str, interval: str, from_ts: int, to_ts: int) -> list:
    if figi.startswith("MOEX:"):
        ticker = figi.split(":", 1)[1]
        from logic.moex import fetch_candles_moex
        return await fetch_candles_moex(ticker, interval, from_ts, to_ts)
        
    try:
        from_dt = datetime.fromtimestamp(from_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        to_dt = datetime.fromtimestamp(to_ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        data = await t_post(
            "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetCandles",
            {"figi": figi, "from": from_dt, "to": to_dt, "interval": INTERVAL_MAP.get(interval, "CANDLE_INTERVAL_HOUR")}
        )
        candles = []
        for c in data.get("candles", []):
            candles.append({
                "time": parse_ts(c.get("time", "")),
                "open": nano_to_float(c.get("open")),
                "high": nano_to_float(c.get("high")),
                "low": nano_to_float(c.get("low")),
                "close": nano_to_float(c.get("close")),
                "volume": int(c.get("volume", 0))
            })
        return [c for c in candles if c["open"] > 0]
    except Exception as e:
        log.warning(f"Tinkoff candles fetch failed for {figi}: {e}. Trying MOEX fallback...")
        ticker = get_ticker_by_figi(figi)
        if ticker and ticker != figi:
            try:
                from logic.moex import fetch_candles_moex
                return await fetch_candles_moex(ticker, interval, from_ts, to_ts)
            except Exception as ex:
                log.error(f"MOEX fallback candles fetch failed for {ticker}: {ex}")
        raise e


async def get_candles_smart(figi: str, interval: str, bars: int, to_ts: Optional[int] = None) -> list:
    """Return candles: from DB if fresh, fill gaps from API synchronously, return full data."""
    sec = INTERVAL_SEC.get(interval, 3600)
    now = int(time.time())
    if to_ts is None:
        to_ts = now
    from_ts = to_ts - bars * sec

    cached = get_cached_candles(figi, interval, from_ts, to_ts)
    gaps = find_gaps(figi, interval, from_ts, to_ts, sec)

    if gaps:
        for g_from, g_to in gaps:
            try:
                await asyncio.sleep(0.2)  # rate limit delay
                fresh = await fetch_candles_api(figi, interval, g_from, g_to)
                if fresh:
                    store_candles(figi, interval, fresh)
            except Exception as e:
                log.warning(f"Sync gap fill {figi} {interval}: {e}")
        return get_cached_candles(figi, interval, from_ts, to_ts)

    return cached


# ── Last price ────────────────────────────────────────────────────────────────
async def get_last_price(figi: str) -> float:
    if figi.startswith("MOEX:"):
        ticker = figi.split(":", 1)[1]
        from logic.moex import get_last_price_moex
        return await get_last_price_moex(ticker)
        
    try:
        data = await t_post(
            "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices",
            {"figi": [figi]}
        )
        prices = data.get("lastPrices", [])
        if prices:
            return nano_to_float(prices[0].get("price", {}))
    except Exception as e:
        log.warning(f"Failed to fetch Tinkoff last price for {figi}: {e}. Trying MOEX fallback...")
        ticker = get_ticker_by_figi(figi)
        if ticker and ticker != figi:
            try:
                from logic.moex import get_last_price_moex
                return await get_last_price_moex(ticker)
            except Exception as ex:
                log.error(f"MOEX fallback last price failed for {ticker}: {ex}")
    return 0.0

async def get_last_prices_bulk(figis: list) -> dict:
    if not figis:
        return {}
        
    moex_figis = [f for f in figis if f.startswith("MOEX:")]
    tinkoff_figis = [f for f in figis if not f.startswith("MOEX:")]
    
    result = {}
    
    if moex_figis:
        moex_tickers = [f.split(":", 1)[1] for f in moex_figis]
        from logic.moex import get_last_prices_bulk_moex
        try:
            moex_prices = await get_last_prices_bulk_moex(moex_tickers)
            for f in moex_figis:
                ticker = f.split(":", 1)[1]
                if ticker in moex_prices:
                    result[f] = moex_prices[ticker]
        except Exception as e:
            log.warning(f"MOEX bulk last prices failed: {e}")
            
    if tinkoff_figis:
        try:
            data = await t_post(
                "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices",
                {"figi": tinkoff_figis}
            )
            for p in data.get("lastPrices", []):
                result[p["figi"]] = nano_to_float(p.get("price", {}))
        except Exception as e:
            log.warning(f"Tinkoff bulk last prices failed: {e}. Trying MOEX fallback...")
            fallback_tickers = []
            ticker_to_figi = {}
            for f in tinkoff_figis:
                ticker = get_ticker_by_figi(f)
                if ticker and ticker != f:
                    fallback_tickers.append(ticker)
                    ticker_to_figi[ticker] = f
                    
            if fallback_tickers:
                from logic.moex import get_last_prices_bulk_moex
                try:
                    moex_fallback = await get_last_prices_bulk_moex(fallback_tickers)
                    for t, p in moex_fallback.items():
                        f = ticker_to_figi[t]
                        result[f] = p
                except Exception as ex:
                    log.error(f"MOEX fallback bulk last prices failed: {ex}")
                    
    return result


