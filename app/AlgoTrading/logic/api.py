import asyncio
import json
import os
import sqlite3
import time
import logging
from pathlib import Path
from typing import Optional, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from logic.db import (
    BASE_DIR,
    CONFIG,
    init_user_db,
    init_registry_db,
    init_candles_db,
    get_user_db,
    get_registry_db,
    get_candles_db,
    get_ticker_by_figi
)
from logic.tinkoff import (
    load_all_registries,
    search_registry,
    get_candles_smart,
    get_last_price,
    get_last_prices_bulk,
    REGISTRY_LOADED
)
from logic.alerts import (
    manager,
    watched,
    stream_loop,
    send_native_notification
)
from logic.ha_analyzer import ha_analyzer

log = logging.getLogger("pricealert")

PORT = int(os.environ.get("PORT", CONFIG["server"]["port"]))

# Helper function to resolve the real user nickname from headers, query params or fallback
def resolve_nick(request: Request, nick: str = "Admin") -> str:
    header_nick = request.headers.get("X-User-Nick")
    if header_nick:
        return header_nick
    query_user = request.query_params.get("user")
    if query_user:
        return query_user
    query_nick = request.query_params.get("nick")
    if query_nick:
        return query_nick
    return nick

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="PriceAlert v2")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def startup():
    init_user_db("Admin")
    init_registry_db()
    init_candles_db()
    asyncio.create_task(stream_loop())
    asyncio.create_task(load_all_registries())
    for inst in CONFIG.get("default_instruments", []):
        watched[inst["figi"]] = 0.0
    # Инициализируем HA Analyzer
    ha_analyzer.configure(ws_manager=manager, notify_fn=send_native_notification)
    # Добавляем дефолтные инструменты в наблюдение HA
    for inst in CONFIG.get("default_instruments", []):
        ha_analyzer.add_symbol(inst["figi"], inst.get("ticker", inst["figi"]), inst.get("name", ""))
    asyncio.create_task(ha_analyzer.start())
    log.info(f"PriceAlert v2 started on :{PORT}")

@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "frontend.html")

@app.get("/health")
def health():
    return {"ok": True, "registry": REGISTRY_LOADED}

# ── Search ────────────────────────────────────────────────────────────────────
@app.get("/api/search")
async def search(q: str = Query(..., min_length=1)):
    local = search_registry(q)
    if local:
        return local
    # Fallback: Tinkoff live search
    try:
        from logic.tinkoff import t_post
        data = await t_post("/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument",
            {"query": q, "instrumentKind":"INSTRUMENT_TYPE_UNSPECIFIED", "apiTradeAvailableFlag": False})
        return [{"figi":i.get("figi"),"ticker":i.get("ticker"),"name":i.get("name"),"type":"share"}
                for i in data.get("instruments", [])[:15]]
    except Exception as e:
        log.warning(f"Tinkoff live search failed: {e}")
        return []

@app.get("/api/instruments/count")
def registry_count():
    conn = sqlite3.connect(get_registry_db())
    c = conn.execute("SELECT COUNT(*) FROM instruments").fetchone()[0]
    conn.close()
    return {"count": c, "loaded": REGISTRY_LOADED}

# ── Candles ───────────────────────────────────────────────────────────────────
@app.get("/api/candles")
async def candles(figi: str, interval: str = "hour", bars: int = 300, to: Optional[int] = None):
    watched.setdefault(figi, 0.0)
    data = await get_candles_smart(figi, interval, bars, to)
    return {"candles": data, "figi": figi, "interval": interval}

@app.get("/api/price/{figi}")
async def price_endpoint(figi: str):
    p = await get_last_price(figi)
    watched[figi] = p
    return {"figi": figi, "price": p}

# ── Lines CRUD (auto-save) ────────────────────────────────────────────────────
class LineCreate(BaseModel):
    nick: str = "Admin"; figi: str; ticker: str; timeframe: str
    type: str; price1: float; price2: Optional[float]=None
    time1: Optional[int]=None; time2: Optional[int]=None
    color: str="#FFD700"; width: int=1; dash: str="solid"
    label: Optional[str]=None; extra_json: Optional[str]=None

class LineUpdate(BaseModel):
    price1: Optional[float]=None; price2: Optional[float]=None
    time1: Optional[int]=None; time2: Optional[int]=None
    color: Optional[str]=None; width: Optional[int]=None
    dash: Optional[str]=None; label: Optional[str]=None
    extra_json: Optional[str]=None

@app.post("/api/lines")
async def create_line(request: Request, l: LineCreate):
    user_nick = request.headers.get("X-User-Nick") or request.query_params.get("user") or l.nick
    init_user_db(user_nick)
    
    now = int(time.time())
    conn = sqlite3.connect(get_user_db(user_nick))
    c = conn.cursor()
    c.execute("""INSERT INTO lines(nick,figi,ticker,timeframe,type,price1,price2,time1,time2,
                 color,width,dash,label,extra_json,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (user_nick,l.figi,l.ticker,l.timeframe,l.type,l.price1,l.price2,
         l.time1,l.time2,l.color,l.width,l.dash,l.label,l.extra_json,now,now))
    lid = c.lastrowid
    conn.commit()
    conn.close()
    return {"ok":True,"line_id":lid}

@app.patch("/api/lines/{line_id}")
async def update_line(request: Request, line_id: int, u: LineUpdate, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    row = conn.execute("SELECT * FROM lines WHERE id=? AND nick=?", (line_id, user_nick)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404)
    fields = {k:v for k,v in u.dict().items() if v is not None}
    fields["updated_at"] = now = int(time.time())
    set_clause = ", ".join(f"{k}=?" for k in fields)
    conn.execute(f"UPDATE lines SET {set_clause} WHERE id=? AND nick=?",
        list(fields.values()) + [line_id, user_nick])
    conn.commit()
    conn.close()
    
    # Also update linked alert
    conn2 = sqlite3.connect(get_user_db(user_nick))
    conn2.execute("UPDATE alerts SET price1=COALESCE(?,price1), price2=COALESCE(?,price2), time1=COALESCE(?,time1), time2=COALESCE(?,time2) WHERE line_id=? AND nick=?",
        (u.price1,u.price2,u.time1,u.time2,line_id,user_nick))
    conn2.commit()
    conn2.close()
    return {"ok":True}

@app.get("/api/lines")
async def list_lines(request: Request, nick: str="Admin", figi: str=None, timeframe: str=None):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    q = "SELECT * FROM lines WHERE nick=?"
    params = [user_nick]
    if figi:
        q += " AND figi=?"
        params.append(figi)
    if timeframe:
        q += " AND timeframe=?"
        params.append(timeframe)
    rows = [dict(r) for r in conn.execute(q+" ORDER BY created_at DESC", params).fetchall()]
    conn.close()
    return rows

@app.delete("/api/lines/{line_id}")
async def delete_line(request: Request, line_id: int, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("DELETE FROM lines WHERE id=? AND nick=?", (line_id, user_nick))
    conn.commit()
    conn.close()
    return {"ok":True}

# ── Alerts CRUD ───────────────────────────────────────────────────────────────
class AlertCreate(BaseModel):
    nick: str="Admin"; figi: str; ticker: str; timeframe: str="hour"
    type: str; price1: float; price2: Optional[float]=None
    time1: Optional[int]=None; time2: Optional[int]=None
    direction: str="cross"; message: Optional[str]=None
    line_id: Optional[int]=None

@app.post("/api/alerts")
async def create_alert(request: Request, a: AlertCreate):
    user_nick = request.headers.get("X-User-Nick") or request.query_params.get("user") or a.nick
    init_user_db(user_nick)
    
    now = int(time.time())
    conn = sqlite3.connect(get_user_db(user_nick))
    c = conn.cursor()
    c.execute("""INSERT INTO alerts(nick,figi,ticker,timeframe,type,price1,price2,time1,time2,
                 direction,message,line_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (user_nick,a.figi,a.ticker,a.timeframe,a.type,a.price1,a.price2,
         a.time1,a.time2,a.direction,a.message,a.line_id,now))
    aid = c.lastrowid
    conn.commit()
    conn.close()
    watched.setdefault(a.figi, 0.0)
    return {"ok":True,"alert_id":aid}

@app.get("/api/alerts")
async def list_alerts(request: Request, nick: str="Admin", figi: str=None):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    q = "SELECT * FROM alerts WHERE nick=?"
    params = [user_nick]
    if figi:
        q += " AND figi=?"
        params.append(figi)
    rows = [dict(r) for r in conn.execute(q+" ORDER BY created_at DESC", params).fetchall()]
    conn.close()
    return rows

@app.delete("/api/alerts/{alert_id}")
async def delete_alert(request: Request, alert_id: int, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("DELETE FROM alerts WHERE id=? AND nick=?", (alert_id, user_nick))
    conn.commit()
    conn.close()
    return {"ok":True}

@app.patch("/api/alerts/{alert_id}/reset")
async def reset_alert(request: Request, alert_id: int, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("UPDATE alerts SET triggered=0, triggered_at=NULL WHERE id=? AND nick=?", (alert_id, user_nick))
    conn.commit()
    conn.close()
    return {"ok":True}

class AlertUpdate(BaseModel):
    price1: Optional[float] = None
    price2: Optional[float] = None
    direction: Optional[str] = None
    message: Optional[str] = None
    active: Optional[int] = None

@app.patch("/api/alerts/{alert_id}")
async def update_alert(request: Request, alert_id: int, u: AlertUpdate, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    row = conn.execute("SELECT * FROM alerts WHERE id=? AND nick=?", (alert_id, user_nick)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Alert not found")
    
    fields = {k:v for k,v in u.dict().items() if v is not None}
    if fields:
        set_clause = ", ".join(f"{k}=?" for k in fields)
        conn.execute(f"UPDATE alerts SET {set_clause} WHERE id=? AND nick=?",
            list(fields.values()) + [alert_id, user_nick])
        conn.commit()
    conn.close()
    return {"ok":True}


@app.get("/api/alert_log")
async def alert_log(request: Request, nick: str="Admin", limit: int=50):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM alert_log WHERE nick=? ORDER BY triggered_at DESC LIMIT ?", (user_nick, limit)).fetchall()]
    conn.close()
    return rows

# ── Watchlist ─────────────────────────────────────────────────────────────────
class WatchItem(BaseModel):
    nick: str="Admin"; figi: str; ticker: str; name: str=""

@app.post("/api/watchlist")
async def add_watchlist(request: Request, item: WatchItem):
    user_nick = request.headers.get("X-User-Nick") or request.query_params.get("user") or item.nick
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    exists = conn.execute("SELECT id FROM watchlist WHERE nick=? AND figi=?", (user_nick, item.figi)).fetchone()
    if not exists:
        conn.execute("INSERT INTO watchlist(nick,figi,ticker,name) VALUES(?,?,?,?)",
            (user_nick, item.figi, item.ticker, item.name))
        conn.commit()
    conn.close()
    watched.setdefault(item.figi, 0.0)
    return {"ok":True}

@app.get("/api/watchlist")
async def get_watchlist(request: Request, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute(
        "SELECT * FROM watchlist WHERE nick=? ORDER BY sort_order,id", (user_nick,)).fetchall()]
    conn.close()
    
    # Attach live prices
    figis = [r["figi"] for r in rows]
    prices = {}
    try:
        prices = await get_last_prices_bulk(figis)
    except Exception as e:
        log.warning(f"Failed to fetch bulk last prices: {e}")
        
    for r in rows:
        r["price"] = prices.get(r["figi"], watched.get(r["figi"], 0))
        watched.setdefault(r["figi"], r["price"])
    return rows

@app.delete("/api/watchlist/{figi}")
async def del_watchlist(request: Request, figi: str, nick: str="Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("DELETE FROM watchlist WHERE nick=? AND figi=?", (user_nick, figi))
    conn.commit()
    conn.close()
    return {"ok":True}

# ── Chart settings ────────────────────────────────────────────────────────────
@app.get("/api/settings")
async def get_settings(request: Request, nick: str="Admin", figi: str="", timeframe: str="hour"):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    row = conn.execute("SELECT * FROM chart_settings WHERE nick=? AND figi=? AND timeframe=?",
        (user_nick, figi, timeframe)).fetchone()
    conn.close()
    if row:
        return {"indicators": row[3], "settings": row[4]}
    return {"indicators": "[]", "settings": "{}"}

@app.post("/api/settings")
async def save_settings(request: Request, nick: str="Admin", figi: str="", timeframe: str="hour",
                         indicators: str="[]", settings: str="{}"):
    user_nick = request.headers.get("X-User-Nick") or request.query_params.get("user") or nick
    init_user_db(user_nick)
    
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("""INSERT OR REPLACE INTO chart_settings(nick,figi,timeframe,indicators,settings)
                    VALUES(?,?,?,?,?)""", (user_nick, figi, timeframe, indicators, settings))
    conn.commit()
    conn.close()
    return {"ok":True}

# ── HA Analyzer API ──────────────────────────────────────────────────────────

class HASymbolAdd(BaseModel):
    figi: str
    ticker: str
    name: str = ""

class HAConfigUpdate(BaseModel):
    refresh_interval_seconds: Optional[int] = None
    trend_min_candles: Optional[int] = None
    volume_high_threshold: Optional[float] = None
    volume_low_threshold: Optional[float] = None
    alerts_enabled: Optional[bool] = None
    alert_on_reversal_only: Optional[bool] = None

@app.get("/api/ha/signals")
async def ha_signals():
    """Текущие HA сигналы по всем отслеживаемым инструментам."""
    return {
        "signals": ha_analyzer.get_signals(),
        "symbols": list(ha_analyzer.symbols.keys()),
        "last_update": ha_analyzer.last_update,
        "next_update": ha_analyzer.last_update + ha_analyzer.config["refresh_interval_seconds"],
        "refresh_interval": ha_analyzer.config["refresh_interval_seconds"],
    }

@app.get("/api/ha/signals/{figi}")
async def ha_signal_by_figi(figi: str):
    """Текущий HA сигнал для конкретного инструмента."""
    signal = ha_analyzer.get_signal(figi)
    if not signal:
        raise HTTPException(status_code=404, detail="Signal not found for this figi")
    return signal

@app.get("/api/ha/history/{figi}")
async def ha_history(figi: str):
    """История HA сигналов для инструмента (последние 20)."""
    return {"figi": figi, "history": ha_analyzer.get_history(figi)}

@app.post("/api/ha/symbols")
async def ha_add_symbol(item: HASymbolAdd):
    """Добавить инструмент в HA наблюдение."""
    ha_analyzer.add_symbol(item.figi, item.ticker, item.name)
    watched.setdefault(item.figi, 0.0)
    return {"ok": True, "figi": item.figi, "ticker": item.ticker}

@app.delete("/api/ha/symbols/{figi}")
async def ha_remove_symbol(figi: str):
    """Убрать инструмент из HA наблюдения."""
    ha_analyzer.remove_symbol(figi)
    return {"ok": True}

@app.post("/api/ha/refresh")
async def ha_refresh():
    """Ручной триггер немедленного обновления HA анализа."""
    asyncio.create_task(ha_analyzer.trigger_now())
    return {"ok": True, "message": "Refresh triggered"}

@app.get("/api/ha/config")
async def ha_get_config():
    """Получить конфигурацию HA Analyzer."""
    return ha_analyzer.config

@app.post("/api/ha/config")
async def ha_update_config(cfg: HAConfigUpdate):
    """Обновить конфигурацию HA Analyzer."""
    updates = {k: v for k, v in cfg.dict().items() if v is not None}
    ha_analyzer.update_config(updates)
    return {"ok": True, "config": ha_analyzer.config}

# ── HA Alerts CRUD ────────────────────────────────────────────────────────────

class HAAlertCreateUpdate(BaseModel):
    symbol: str
    trigger_reversal: Optional[int] = 1
    reversal_tf: Optional[str] = '1h,4h'
    reversal_min_candles: Optional[int] = 3
    trigger_spike: Optional[int] = 0
    spike_tf: Optional[str] = '1h'
    spike_pct: Optional[float] = 2.5
    spike_direction: Optional[str] = 'any'
    trigger_volume: Optional[int] = 0
    volume_multiplier: Optional[float] = 1.5
    volume_trend_only: Optional[int] = 1
    trigger_combo: Optional[int] = 0
    notify_push: Optional[int] = 1
    notify_telegram: Optional[int] = 1
    notify_sound: Optional[int] = 0
    active: Optional[int] = 1

@app.get("/api/ha-alerts")
async def list_ha_alerts(request: Request, nick: str = "Admin"):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM ha_alerts ORDER BY created_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.post("/api/ha-alerts")
async def create_or_update_ha_alert(request: Request, a: HAAlertCreateUpdate, nick: str = "Admin"):
    from datetime import datetime
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    
    # Check if exists
    exists = conn.execute("SELECT id FROM ha_alerts WHERE symbol=?", (a.symbol,)).fetchone()
    now = datetime.now().isoformat()
    if exists:
        conn.execute("""
            UPDATE ha_alerts SET
                trigger_reversal=?, reversal_tf=?, reversal_min_candles=?,
                trigger_spike=?, spike_tf=?, spike_pct=?, spike_direction=?,
                trigger_volume=?, volume_multiplier=?, volume_trend_only=?,
                trigger_combo=?, notify_push=?, notify_telegram=?, notify_sound=?,
                active=?
            WHERE symbol=?
        """, (
            a.trigger_reversal, a.reversal_tf, a.reversal_min_candles,
            a.trigger_spike, a.spike_tf, a.spike_pct, a.spike_direction,
            a.trigger_volume, a.volume_multiplier, a.volume_trend_only,
            a.trigger_combo, a.notify_push, a.notify_telegram, a.notify_sound,
            a.active, a.symbol
        ))
        msg = "Alert updated"
    else:
        conn.execute("""
            INSERT INTO ha_alerts (
                symbol, trigger_reversal, reversal_tf, reversal_min_candles,
                trigger_spike, spike_tf, spike_pct, spike_direction,
                trigger_volume, volume_multiplier, volume_trend_only,
                trigger_combo, notify_push, notify_telegram, notify_sound,
                active, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            a.symbol, a.trigger_reversal, a.reversal_tf, a.reversal_min_candles,
            a.trigger_spike, a.spike_tf, a.spike_pct, a.spike_direction,
            a.trigger_volume, a.volume_multiplier, a.volume_trend_only,
            a.trigger_combo, a.notify_push, a.notify_telegram, a.notify_sound,
            a.active, now
        ))
        msg = "Alert created"
    conn.commit()
    conn.close()
    
    # Make sure symbol is watched by HA analyzer
    ha_analyzer.add_symbol(a.symbol, get_ticker_by_figi(a.symbol), get_ticker_by_figi(a.symbol))
    
    return {"ok": True, "message": msg}

@app.delete("/api/ha-alerts/{alert_id}")
async def delete_ha_alert(request: Request, alert_id: int, nick: str = "Admin"):
    user_nick = resolve_nick(request, nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.execute("DELETE FROM ha_alerts WHERE id=?", (alert_id,))
    conn.commit()
    conn.close()
    return {"ok": True}

@app.get("/api/ha-alerts/log")
async def get_ha_alerts_log(request: Request, nick: str = "Admin", limit: int = 50):
    user_nick = resolve_nick(request, nick)
    init_user_db(user_nick)
    conn = sqlite3.connect(get_user_db(user_nick))
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM ha_alert_log ORDER BY triggered_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

# ── WebSocket ─────────────────────────────────────────────────────────────────
@app.websocket("/ws/{nick}")
async def ws_endpoint(ws: WebSocket, nick: str):
    await manager.connect(ws, nick)
    try:
        while True:
            msg = await ws.receive_json()
            cmd = msg.get("cmd")
            if cmd == "watch":
                figi = msg.get("figi")
                if figi:
                    watched.setdefault(figi, 0.0)
                    await ws.send_json({"type":"watching","figi":figi})
            elif cmd == "unwatch":
                pass  # keep watching, multiple clients may need it
    except WebSocketDisconnect:
        manager.disconnect(ws, nick)
    except Exception as e:
        log.warning(f"WS Exception for {nick}: {e}")
        manager.disconnect(ws, nick)
