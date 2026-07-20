import sqlite3
import time
import logging
from datetime import datetime, timezone, timedelta
import httpx

from logic.db import get_registry_db

log = logging.getLogger("pricealert")

INTERVAL_MAP_MOEX = {
    "1min": 1,
    "5min": 1,
    "15min": 1,
    "hour": 60,
    "4hour": 60,
    "day": 24
}

INTERVAL_SEC = {
    "1min": 60,
    "5min": 300,
    "15min": 900,
    "hour": 3600,
    "4hour": 14400,
    "day": 86400
}

def aggregate_candles(candles_1min: list, interval_sec: int) -> list:
    if not candles_1min:
        return []
    aggregated = []
    current_slot = None
    slot_candles = []
    
    for c in candles_1min:
        t = c["time"]
        slot = (t // interval_sec) * interval_sec
        if current_slot is None:
            current_slot = slot
            slot_candles = [c]
        elif slot == current_slot:
            slot_candles.append(c)
        else:
            aggregated.append({
                "time": current_slot,
                "open": slot_candles[0]["open"],
                "high": max(sc["high"] for sc in slot_candles),
                "low": min(sc["low"] for sc in slot_candles),
                "close": slot_candles[-1]["close"],
                "volume": sum(sc["volume"] for sc in slot_candles)
            })
            current_slot = slot
            slot_candles = [c]
            
    if slot_candles:
        aggregated.append({
            "time": current_slot,
            "open": slot_candles[0]["open"],
            "high": max(sc["high"] for sc in slot_candles),
            "low": min(sc["low"] for sc in slot_candles),
            "close": slot_candles[-1]["close"],
            "volume": sum(sc["volume"] for sc in slot_candles)
        })
    return aggregated

async def fetch_candles_moex(ticker: str, interval: str, from_ts: int, to_ts: int) -> list:
    moex_interval = INTERVAL_MAP_MOEX.get(interval, 60)
    tz_msk = timezone(timedelta(hours=3))
    
    # MOEX ISS requires dates in the format YYYY-MM-DD or YYYY-MM-DD HH:MM:SS
    from_dt = datetime.fromtimestamp(from_ts, tz=timezone.utc).astimezone(tz_msk)
    to_dt = datetime.fromtimestamp(to_ts, tz=timezone.utc).astimezone(tz_msk)
    
    from_str = from_dt.strftime("%Y-%m-%d %H:%M:%S")
    to_str = to_dt.strftime("%Y-%m-%d %H:%M:%S")
    
    candles = []
    start = 0
    while True:
        url = f"https://iss.moex.com/iss/engines/stock/markets/shares/securities/{ticker}/candles.json"
        params = {
            "from": from_str,
            "till": to_str,
            "interval": moex_interval,
            "start": start
        }
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.get(url, params=params)
                r.raise_for_status()
                res = r.json()
        except Exception as e:
            log.warning(f"MOEX candles request failed for {ticker} (start={start}): {e}")
            break
            
        if "candles" not in res or "data" not in res["candles"]:
            break
            
        data = res["candles"]["data"]
        if not data:
            break
            
        columns = res["candles"]["columns"]
        col_idx = {col: idx for idx, col in enumerate(columns)}
        
        page_candles = []
        for row in data:
            if row[col_idx["open"]] is None or row[col_idx["close"]] is None:
                continue
            begin_str = row[col_idx["begin"]]
            try:
                dt = datetime.strptime(begin_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=tz_msk)
                ts = int(dt.timestamp())
            except Exception as e:
                log.warning(f"Failed to parse MOEX begin date {begin_str}: {e}")
                continue
                
            page_candles.append({
                "time": ts,
                "open": float(row[col_idx["open"]]),
                "high": float(row[col_idx["high"]]),
                "low": float(row[col_idx["low"]]),
                "close": float(row[col_idx["close"]]),
                "volume": int(row[col_idx["volume"]]) if row[col_idx["volume"]] is not None else 0
            })
            
        candles.extend(page_candles)
        if len(data) < 500:
            break
        start += len(data)
        
    if interval in ("5min", "15min", "4hour"):
        sec = INTERVAL_SEC.get(interval, 300)
        candles = aggregate_candles(candles, sec)
        
    return candles

async def get_last_price_moex(ticker: str) -> float:
    try:
        url = f"https://iss.moex.com/iss/engines/stock/markets/shares/securities/{ticker}.json"
        params = {
            "iss.only": "marketdata",
            "marketdata.columns": "SECID,LAST"
        }
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            res = r.json()
            
        data = res.get("marketdata", {}).get("data", [])
        for row in data:
            if row[1] is not None:
                return float(row[1])
    except Exception as e:
        log.warning(f"Failed to fetch last price from MOEX for {ticker}: {e}")
    return 0.0

async def get_last_prices_bulk_moex(tickers: list) -> dict:
    if not tickers:
        return {}
    try:
        url = "https://iss.moex.com/iss/engines/stock/markets/shares/securities.json"
        params = {
            "iss.only": "marketdata",
            "marketdata.columns": "SECID,LAST"
        }
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            res = r.json()
            
        data = res.get("marketdata", {}).get("data", [])
        result = {}
        for row in data:
            secid = row[0]
            price = row[1]
            if secid in tickers and price is not None:
                result[secid] = float(price)
        return result
    except Exception as e:
        log.warning(f"Failed bulk last prices from MOEX: {e}")
    return {}

async def load_registry_moex():
    log.info("Loading instrument registry from MOEX...")
    try:
        url = "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities.json?iss.meta=off&iss.only=securities"
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(url)
            r.raise_for_status()
            res = r.json()
            
        securities = res.get("securities", {})
        columns = securities.get("columns", [])
        data = securities.get("data", [])
        if not data:
            return
            
        col_idx = {col: idx for idx, col in enumerate(columns)}
        
        conn = sqlite3.connect(get_registry_db())
        now = int(time.time())
        inserted = 0
        for row in data:
            ticker = row[col_idx["SECID"]]
            name = row[col_idx["SHORTNAME"]]
            lot = int(row[col_idx["LOTSIZE"]]) if row[col_idx["LOTSIZE"]] is not None else 1
            currency = row[col_idx["CURRENCYID"]]
            if currency == "SUR":
                currency = "RUB"
                
            figi = f"MOEX:{ticker}"
            conn.execute("""INSERT OR REPLACE INTO instruments(figi,ticker,name,type,currency,lot,exchange,sector,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?)""",
                (figi, ticker, name, "share", currency, lot, "MOEX", "", now))
            inserted += 1
            
        conn.commit()
        conn.execute("INSERT INTO instruments_fts(instruments_fts) VALUES('rebuild')")
        conn.commit()
        conn.close()
        log.info(f"Loaded {inserted} instruments from MOEX.")
    except Exception as e:
        log.error(f"Failed to load registry from MOEX: {e}")
