import asyncio
import json
import os
import sqlite3
import time
import logging
from pathlib import Path
from typing import Optional
import jwt
import httpx
from fastapi import WebSocket

from logic.db import CONFIG, get_user_db, get_candles_db
from logic.tinkoff import t_post, nano_to_float, INTERVAL_SEC, get_last_prices_bulk

log = logging.getLogger("pricealert")

BASE_DIR = Path(__file__).parent.parent

# ── Alert engine ──────────────────────────────────────────────────────────────
def trendline_price(p1, p2, t1, t2, now):
    if p1 is None or p2 is None or t1 is None or t2 is None:
        return 0.0
    if t2 == t1:
        return p1
    return p1 + (p2 - p1) * (now - t1) / (t2 - t1)

def check_alert(a, cur, prev) -> bool:
    now = int(time.time())
    if prev is None:
        prev = cur
    if a["type"] == "horizontal":
        target = a["price1"]
        if target is None:
            return False
    elif a["type"] == "trendline":
        if a["price1"] is None or a["price2"] is None or a["time1"] is None or a["time2"] is None:
            return False
        target = trendline_price(a["price1"], a["price2"], a["time1"], a["time2"], now)
    else:
        return False
    d = a["direction"]
    triggered = False
    if d == "above":
        triggered = prev < target <= cur
    elif d == "below":
        triggered = prev > target >= cur
    else:
        triggered = (prev < target <= cur) or (prev > target >= cur)
        
    log.debug(f"[ALERT CHECK] symbol={a.get('ticker')} level={target:.4f} prev={prev:.4f} curr={cur:.4f} → {'TRIGGERED' if triggered else 'NOT TRIGGERED'}")
    return triggered

# ── WebSocket manager ─────────────────────────────────────────────────────────
class WsManager:
    def __init__(self):
        self.conns: dict[str, list[WebSocket]] = {}

    async def connect(self, ws: WebSocket, nick: str):
        await ws.accept()
        self.conns.setdefault(nick, []).append(ws)

    def disconnect(self, ws: WebSocket, nick: str):
        if nick in self.conns:
            self.conns[nick] = [c for c in self.conns[nick] if c != ws]

    async def send(self, nick: str, data: dict):
        dead = []
        for ws in self.conns.get(nick, []):
            try:
                await ws.send_json(data)
            except:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, nick)

    async def broadcast(self, data: dict):
        for nick in list(self.conns):
            await self.send(nick, data)

manager = WsManager()

# ── Price streaming state ─────────────────────────────────────────────────────
watched: dict[str, float] = {}   # figi -> last price
prev_price: dict[str, float] = {}   # figi -> prev price (for alert check)
alert_prev: dict[int, float] = {}   # alert_id -> price at last check

def get_user_id_by_nick(nick: str) -> Optional[str]:
    # Path relative to apps/pricealert/logic/ is ../../../System/Lumi.db
    db_path = BASE_DIR.parent.parent / "System" / "Lumi.db"
    if not db_path.exists():
        log.warning(f"Main DB Lumi.db not found at {db_path.absolute()}")
        return None
    try:
        conn = sqlite3.connect(db_path)
        row = conn.execute("SELECT id FROM users WHERE nickname = ? COLLATE NOCASE", (nick,)).fetchone()
        conn.close()
        if row:
            return row[0]
    except Exception as e:
        log.warning(f"Error querying Lumi.db: {e}")
    return None

async def send_telegram_message(message: str):
    tg_config = CONFIG.get("notifications", {}).get("telegram", {})
    if not tg_config.get("enabled", False):
        return
    token = tg_config.get("bot_token")
    chat_id = tg_config.get("chat_id")
    if not token or not chat_id:
        log.warning("Telegram notification enabled but bot_token or chat_id is missing.")
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": message,
        "parse_mode": "HTML"
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            log.info("Telegram message sent successfully.")
    except Exception as e:
        log.warning(f"Failed to send Telegram message: {e}")

async def send_native_notification(nick: str, ticker: str, price: float, message: str):
    # Отправляем в Telegram
    await send_telegram_message(f"<b>[Алерт: {ticker}]</b>\nЦена: {price:.4f}\n{message}")

    user_id = get_user_id_by_nick(nick)
    caller_id = user_id or "local_system_user"
    
    secret = os.environ.get("JWT_SECRET_KEY", "change-me-please-123")
    payload = {
        "sub": caller_id,
        "type": "access",
        "exp": int(time.time()) + 300,
        "iat": int(time.time()),
    }
    try:
        token = jwt.encode(payload, secret, algorithm="HS256")
    except Exception as e:
        log.warning(f"Failed to encode JWT token: {e}")
        return

    # Check environment
    is_docker = os.path.exists("/.dockerenv") or os.environ.get("RUNNING_IN_DOCKER") == "true"
    backend_url = "http://backend:8000" if is_docker else "http://127.0.0.1:8001"
    
    notification_payload = {
        "target_user_identifier": nick,
        "app_key": "pricealert",
        "title": f"Алерт: {ticker}",
        "message": message or f"Цена {ticker} пересекла уровень {price:.4f}",
        "action_data": {
            "link": "/miniapps/pricealert"
        }
    }
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{backend_url}/api/apps/notifications/send", json=notification_payload, headers=headers)
            r.raise_for_status()
            log.info(f"Notification sent successfully: {r.json()}")
    except Exception as e:
        log.warning(f"Failed to send backend notification for {nick}: {e}")


async def check_alerts_for_user(nick: str, figi: str, price: float, prev: float):
    db_path = get_user_db(nick)
    if not db_path.exists():
        return
    
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM alerts WHERE figi=? AND active=1 AND triggered=0", (figi,)).fetchall()
    
    for row in rows:
        a = dict(row)
        aid = a["id"]
        p = alert_prev.get(aid, prev)
        if check_alert(a, price, p):
            now = int(time.time())
            conn.execute("UPDATE alerts SET triggered=1, triggered_at=? WHERE id=?", (now, aid))
            conn.execute("INSERT INTO alert_log(alert_id,nick,figi,ticker,price,triggered_at,message) VALUES(?,?,?,?,?,?,?)",
                (aid, nick, figi, a["ticker"], price, now, a.get("message","")))
            conn.commit()
            msg = a.get("message") or f"Алерт: {a['ticker']} @ {price:.4f}"
            
            # Send to local WS connections
            await manager.send(nick, {"type":"alert_triggered","alert_id":aid,
                "ticker":a["ticker"],"price":price,"message":msg,"ts":now})
            
            # Send native notification to the Android WS via backend
            await send_native_notification(nick, a["ticker"], price, msg)
            log.info(f"ALERT: {a['ticker']} @ {price} for user {nick}")
        alert_prev[aid] = price
    conn.commit()
    conn.close()

async def check_alerts(figi: str, price: float, prev: float):
    users_dir = BASE_DIR.parent.parent / "data" / "users"
    if not users_dir.exists():
        log.warning("data/users directory not found, checking only Admin")
        await check_alerts_for_user("Admin", figi, price, prev)
        return
        
    for item in users_dir.iterdir():
        if item.is_dir() and not item.name.startswith("_"):
            db_file = item / "apps" / "pricealert" / "pricealert.db"
            if db_file.exists():
                await check_alerts_for_user(item.name, figi, price, prev)

def _upsert_tick(figi, interval, ts, price):
    try:
        conn = sqlite3.connect(get_candles_db(), timeout=15.0)
        try: conn.execute("PRAGMA journal_mode=WAL")
        except Exception: pass
        row = conn.execute("SELECT open,high,low FROM candles WHERE figi=? AND interval=? AND ts=?", (figi,interval,ts)).fetchone()
        if row:
            o,h,l = row
            conn.execute("UPDATE candles SET high=?,low=?,close=? WHERE figi=? AND interval=? AND ts=?",
                (max(h,price), min(l,price), price, figi, interval, ts))
        else:
            conn.execute("INSERT OR REPLACE INTO candles(figi,interval,ts,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,0)",
                (figi, interval, ts, price, price, price, price))
        conn.commit()
        conn.close()
    except Exception as e:
        log.warning(f"Error in _upsert_tick: {e}")

async def stream_loop():
    """Poll prices every 3s for all watched FIGIs, check alerts, push WS."""
    while True:
        await asyncio.sleep(3)
        if not watched:
            continue
        try:
            figis = list(watched.keys())
            prices = await get_last_prices_bulk(figis)
            now = int(time.time())
            for figi, price in prices.items():
                if price == 0:
                    continue
                old = watched.get(figi, price)
                watched[figi] = price
                # Store as last candle tick
                sec = INTERVAL_SEC.get("1min", 60)
                slot = (now // sec) * sec
                _upsert_tick(figi, "1min", slot, price)
                # Push to frontend
                await manager.broadcast({"type":"price","figi":figi,"price":price,"ts":now})
                # Check alerts for all users
                await check_alerts(figi, price, old)
                prev_price[figi] = price
        except Exception as e:
            log.warning(f"Stream loop error: {e}")
