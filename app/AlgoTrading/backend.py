import asyncio
import json
import logging
import os
import shutil
import time
import sqlite3
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse, parse_qs

from fastapi import FastAPI, Request, HTTPException, Query, Header, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import uvicorn
import httpx
import jwt

# ── Import PriceAlert logic modules ───────────────────────────────────────────
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
    get_last_price as alert_get_last_price,
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

# ── Import Seller engine modules ──────────────────────────────────────────────
from engine import config, settings
from engine.client_factory import get_client
from engine.logging_utils import setup_logging, get_logger
from engine.market_data import compute_price_context, get_last_price as bot_get_last_price
from engine.orders import (
    estimate_order_value,
    get_bot_open_orders,
    get_order_lots,
    place_limit_order,
    place_stop_order,
    cancel_all_orders,
    clear_not_tradable,
)
from engine.plan import build_order_plan, build_short_plan
from engine.portfolio import get_portfolio, get_portfolio_position
from engine.price_utils import normalize_prices, percent_to_rub
from engine.storage import ensure_figi_dir, load_json, save_json, _resolve_ticker, read_figi_meta, update_figi_meta
from engine.figi_cache import get_figi_info
from engine.token_utils import get_trade_token, get_history_token
from engine.scheduler import is_trading_time, is_limit_orders_time, should_rebalance_now, rebalance_portfolio, is_rebalance_cutoff_time
from engine.history_engine import load_trade_history_from_broker, initialize_state, get_last_trade_timestamp, get_last_buy_price, get_avg_buy_price, get_last_trade_price
from engine.analytics_top100 import generate_if_needed, generate_top100_json

# Import complex analytical helper functions from dashboard_api.py
from engine.dashboard_api import (
    _load_live_portfolio,
    _get_last_prices,
    _history_path,
    _load_history,
    _load_state,
    _list_figis_from_data,
    _resolve_go_margins,
    _normalize_type,
    _compute_pnl_series,
    _xirr,
    _compute_mwr_for_figi,
    _estimate_start_capital_from_history,
    _save_figi_year_start_snapshot,
    _live_figi_value_for_mwr,
    _get_figi_year_start_value,
)

# ── Config and Constants ──────────────────────────────────────────────────────
ROOT_DIR = BASE_DIR.parent.parent  # Goals_Wiget root folder
PORT = int(os.environ.get("PORT", CONFIG["server"]["port"]))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("unified_backend")
log = logging.getLogger("pricealert")

# Active bots memory state: user_nick -> state dict
ACTIVE_BOTS: Dict[str, Dict[str, Any]] = {}

# ── Helpers for Seller ────────────────────────────────────────────────────────
def get_current_user_nick(request: Request) -> str:
    header_nick = request.headers.get("X-User-Nick")
    if header_nick:
        return header_nick.strip()
    nick = request.query_params.get("user")
    if nick:
        return nick.strip()
    referer = request.headers.get("referer")
    if referer:
        try:
            parsed = urlparse(referer)
            qs = parse_qs(parsed.query)
            if "user" in qs:
                return qs["user"][0].strip()
        except Exception:
            pass
    return "Admin"

def get_user_dir(nick: str) -> Path:
    p = ROOT_DIR / "data" / "users" / nick / "apps" / "Seller"
    p.mkdir(parents=True, exist_ok=True)
    return p

def get_user_config_path(nick: str) -> Path:
    return get_user_dir(nick) / "config.server.json"

def load_user_config(nick: str) -> dict:
    config_path = get_user_config_path(nick)
    if not config_path.exists():
        template_path = BASE_DIR / "config.template.json"
        if template_path.exists():
            shutil.copy(template_path, config_path)
            logger.info(f"Copied config template for user: {nick}")
        else:
            config_path.write_text(json.dumps({"settings": {}, "accounts": []}, indent=2), encoding="utf-8")
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {"settings": {}, "accounts": []}
    except Exception as e:
        logger.error(f"Error reading config for {nick}: {e}")
        return {"settings": {}, "accounts": []}

def save_user_config(nick: str, data: dict):
    config_path = get_user_config_path(nick)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def discover_accounts_for_token(token: str) -> list:
    if not token or not token.strip():
        return []
    try:
        with get_client(token.strip()) as client:
            resp = client.users.get_accounts()
            accounts = []
            for acc in resp.accounts:
                accounts.append({
                    "NAME": acc.name or f"Счет {acc.id}",
                    "ACCOUNT_ID": acc.id,
                    "ENABLED": True,
                    "SETTINGS": {
                        "ANALYSIS_INTERVAL": 180,
                        "CAPITAL_ALLOCATION": {
                            "share": 0.5,
                            "bond": 0.3,
                            "futures": 0.1,
                            "fund": 0.1
                        },
                        "TMON_REBALANCE_ENABLED": True
                    },
                    "TICKERS": {}
                })
            logger.info(f"Discovered {len(accounts)} accounts via Tinkoff API.")
            return accounts
    except Exception as e:
        logger.error(f"Failed to fetch accounts via Tinkoff API: {e}")
        return []

def bind_user_context(nick: str, user_cfg: dict):
    settings_cfg = user_cfg.get("settings", {})
    token = settings_cfg.get("TOKEN", "")
    
    # 1. Bind storage BASE_DIR
    user_dir = get_user_dir(nick)
    settings.BASE_DIR = user_dir
    
    # 2. Bind logs location
    settings.LOG_FILE = str(user_dir / "bot_logs.log")
    settings.DETAILED_LOG_FILE = str(user_dir / "bot_logs_detailed.log")
    
    # 3. Bind core settings
    config.TOKEN = token
    settings.TOKEN = token
    settings.TOKEN_TRADE = settings_cfg.get("TOKEN_TRADE") or token
    settings.TOKEN_HISTORY = settings_cfg.get("TOKEN_HISTORY") or token
    
    # 4. Bind config file location
    config.CONFIG_FILE = str(get_user_config_path(nick))
    settings.CONFIG_FILE = str(get_user_config_path(nick))

def _apply_account_context_dynamic(account: dict, base_settings: dict):
    for key, value in base_settings.items():
        setattr(config, key, value)
        if key == "ANALYSIS_INTERVAL":
            setattr(settings, "UPDATE_DELAY", value)
        else:
            setattr(settings, key, value)

    account_settings = account.get("SETTINGS") or {}
    for key, value in account_settings.items():
        if hasattr(config, key):
            setattr(config, key, value)
        if key == "ANALYSIS_INTERVAL":
            setattr(settings, "UPDATE_DELAY", value)
        elif hasattr(settings, key):
            setattr(settings, key, value)

    settings.ACCOUNT_ID = account.get("ACCOUNT_ID")
    settings.TICKERS_CONFIG = account.get("TICKERS") or {}
    settings.LOG_ACCOUNT_NAME = account.get("NAME") or str(account.get("ACCOUNT_ID") or "")
    
    trade_token = get_trade_token(account, base_settings)
    history_token = get_history_token(account, base_settings)
    if trade_token:
        settings.TOKEN = trade_token
    settings.TOKEN_TRADE = trade_token or settings.TOKEN
    settings.TOKEN_HISTORY = history_token or trade_token or settings.TOKEN

# ── PriceAlert context resolver helper ────────────────────────────────────────
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

# ── Core Trading Loop (Ported from main.py) ──────────────────────────────────
def run_trading_cycle_for_account(account: dict, client):
    if not settings.TICKERS_CONFIG:
        return

    # Check trading window
    trading_now = is_trading_time()
    orders_now = is_limit_orders_time()
    if not trading_now:
        logger.info(f"[{account.get('NAME')}] Trading window closed, skipping analysis.")
        return

    # Load capital budgets
    _, available_capital_for_buy, _, _, _, success = get_portfolio(client, settings.ACCOUNT_ID)
    if not success:
        available_capital_for_buy = 0.0
    
    remaining_total_budget = available_capital_for_buy
    remaining_budgets = {
        "share": remaining_total_budget * float(settings.CAPITAL_ALLOCATION.get("share", 0)),
        "bond": remaining_total_budget * float(settings.CAPITAL_ALLOCATION.get("bond", 0)),
        "futures": remaining_total_budget * float(settings.CAPITAL_ALLOCATION.get("futures", 0)),
        "fund": remaining_total_budget * float(settings.CAPITAL_ALLOCATION.get("fund", 0)),
    }

    # Run analysis for each ticker
    for figi, figi_cfg_raw in settings.TICKERS_CONFIG.items():
        figi_cfg = dict(figi_cfg_raw)
        if not figi_cfg.get("ENABLED", True):
            continue

        clear_not_tradable(figi)
        ctx = compute_price_context(client, figi, figi_cfg)
        if not ctx:
            continue

        instrument_type = ctx["instrument_type"]
        last_price = ctx["last_price"]
        min_inc = ctx["min_inc"]
        limit_down = ctx["limit_down"]
        limit_up = ctx["limit_up"]

        # Default modes
        if "buy_base_mode" not in figi_cfg:
            figi_cfg["buy_base_mode"] = getattr(config, "DEFAULT_BUY_BASE_MODE", "last_trade")
        if "sell_base_mode" not in figi_cfg:
            figi_cfg["sell_base_mode"] = getattr(config, "DEFAULT_SELL_BASE_MODE", "last")

        if figi_cfg.get("auto_min_price_increment", True) and not figi_cfg.get("price_step"):
            figi_cfg["price_step"] = min_inc

        # Load positions history
        state_path = ensure_figi_dir(figi) / "state.json"
        state_data = load_json(state_path, {})
        trade_mode = figi_cfg.get("TRADE_MODE", "LONG").upper()
        
        positions = state_data.get("short_positions" if trade_mode == "SHORT" else "positions", []) or []
        prev_trade_ts = state_data.get("last_trade_ts")

        # History and positions sync
        portfolio_pos = get_portfolio_position(client, figi)
        position_qty = portfolio_pos["quantity"] if portfolio_pos else sum(p.get("qty", 0) for p in positions)
        position_qty_lots = position_qty
        if instrument_type == "share":
            lot_size = ctx["lot_size"] or 1
            position_qty_lots = int(position_qty / lot_size)

        # Trigger history refresh if needed
        if settings.REFRESH_HISTORY_ON_CHANGE:
            history_token = settings.TOKEN_HISTORY or settings.TOKEN
            with get_client(history_token) as history_client:
                load_trade_history_from_broker(
                    history_client,
                    settings.ACCOUNT_ID,
                    figi,
                    settings.HISTORY_YEARS,
                    None,
                    ensure_figi_dir,
                    load_json,
                    save_json,
                    logger.debug
                )
            
            last_trade_ts = get_last_trade_timestamp(figi, ensure_figi_dir, load_json)
            if (last_trade_ts != prev_trade_ts) or (position_qty != sum(p.get("qty", 0) for p in positions)):
                state_data = initialize_state(
                    client,
                    settings.ACCOUNT_ID,
                    figi,
                    settings.MODE,
                    ensure_figi_dir,
                    load_json,
                    save_json,
                    logger.debug,
                    get_portfolio_position,
                    bot_get_last_price
                )
                positions = state_data.get("short_positions" if trade_mode == "SHORT" else "positions", []) or []

        last_buy_price = get_last_buy_price(figi, ensure_figi_dir, load_json)
        avg_buy_price = get_avg_buy_price(figi, ensure_figi_dir, load_json)
        last_trade_price = get_last_trade_price(figi, ensure_figi_dir, load_json)

        if position_qty == 0:
            last_buy_price = avg_buy_price = last_trade_price = None

        base_price_buy = last_buy_price or avg_buy_price or last_price
        base_price_sell = max(last_price or 0, avg_buy_price or 0, last_buy_price or 0) or last_price

        # Normalize grid params
        normalized_cfg, base_price_buy, _ = normalize_prices(figi_cfg, base_price_buy, last_price)
        _, base_price_sell, _ = normalize_prices(figi_cfg, base_price_sell, last_price)

        open_orders, open_stop_orders = get_bot_open_orders(client, figi)
        open_sell_qty = sum(
            get_order_lots(o) for o in (open_orders + open_stop_orders)
            if o.direction in ("ORDER_DIRECTION_SELL", "STOP_ORDER_DIRECTION_SELL")
        )

        # Plan generation
        plan_debug = []
        if trade_mode == "SHORT":
            prices_buy, prices_sell, order_qty = build_short_plan(
                figi_cfg=normalized_cfg,
                base_price_buy=base_price_buy,
                base_price_sell=base_price_sell,
                short_qty=position_qty_lots,
                limit_down=limit_down,
                limit_up=limit_up,
                debug=plan_debug
            )
        else:
            prices_buy, prices_sell, order_qty = build_order_plan(
                figi_cfg=normalized_cfg,
                base_price_buy=base_price_buy,
                base_price_sell=base_price_sell,
                position_qty=position_qty_lots,
                open_sell_qty=open_sell_qty,
                limit_down=limit_down,
                limit_up=limit_up,
                debug=plan_debug
            )

        # Budget verification and order placement
        if not orders_now:
            continue

        # Place Buy orders
        if prices_buy:
            class_budget = remaining_budgets.get(instrument_type, 0.0)
            if class_budget > 0:
                for target_price in prices_buy[:normalized_cfg.get("MAX_BUY_ORDERS", 2)]:
                    # Check if already placed
                    if any(abs(getattr(o, "price", 0) - target_price) < min_inc for o in open_orders):
                        continue
                    
                    val_est = estimate_order_value(figi, target_price, normalized_cfg.get("BUY_LOTS_PER_ORDER", 1), ctx)
                    if val_est <= class_budget:
                        place_limit_order(client, settings.ACCOUNT_ID, figi, target_price, normalized_cfg.get("BUY_LOTS_PER_ORDER", 1), "ORDER_DIRECTION_BUY")
                        remaining_budgets[instrument_type] -= val_est
                        logger.info(f"[{settings.LOG_ACCOUNT_NAME}] Placed BUY limit order for {figi} @ {target_price}")

        # Place Sell orders
        if prices_sell:
            for target_price in prices_sell[:normalized_cfg.get("MAX_SELL_ORDERS", 2)]:
                if any(abs(getattr(o, "price", 0) - target_price) < min_inc for o in open_orders):
                    continue
                place_limit_order(client, settings.ACCOUNT_ID, figi, target_price, normalized_cfg.get("SELL_LOTS_PER_ORDER", 1), "ORDER_DIRECTION_SELL")
                logger.info(f"[{settings.LOG_ACCOUNT_NAME}] Placed SELL limit order for {figi} @ {target_price}")

# ── Background Worker Loop (Bot trade engine) ────────────────────────────────
def background_trade_worker():
    logger.info("Background Trade Worker thread started.")
    while True:
        try:
            users_dir = ROOT_DIR / "data" / "users"
            if not users_dir.exists():
                time.sleep(5)
                continue

            for user_path in users_dir.iterdir():
                if not user_path.is_dir() or user_path.name.startswith("_"):
                    continue
                nick = user_path.name
                
                # Check user state in memory
                if nick not in ACTIVE_BOTS:
                    user_cfg = load_user_config(nick)
                    ACTIVE_BOTS[nick] = {
                        "bot_paused": True,
                        "bot_running": True,
                        "last_update": None,
                        "tickers_count": 0,
                    }

                state = ACTIVE_BOTS[nick]
                if state.get("bot_paused", True):
                    continue

                # Load config
                user_cfg = load_user_config(nick)
                settings_cfg = user_cfg.get("settings", {})
                token = settings_cfg.get("TOKEN")
                if not token or not token.strip():
                    logger.warning(f"Active user {nick} has no token, pausing bot.")
                    state["bot_paused"] = True
                    continue

                # Set dynamic context
                bind_user_context(nick, user_cfg)
                logger.info(f"[RUNNER] Running trading iteration for user: {nick}")

                accounts = user_cfg.get("accounts", [])
                for acc in accounts:
                    if not acc.get("ENABLED", True):
                        continue
                    
                    # Apply specific account environment variables
                    _apply_account_context_dynamic(acc, settings_cfg)
                    
                    try:
                        # Execute trading analysis
                        with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                            # Rebalance check
                            last_rebalance = state.get(f"rebalance_{acc['ACCOUNT_ID']}")
                            today = datetime.now(timezone.utc).date()
                            if should_rebalance_now(last_rebalance):
                                cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
                                rebalance_portfolio(client)
                                state[f"rebalance_{acc['ACCOUNT_ID']}"] = today
                                if is_rebalance_cutoff_time():
                                    continue
                            
                            # Run main calculations
                            run_trading_cycle_for_account(acc, client)
                            
                    except Exception as e:
                        logger.error(f"Error in bot execution for {nick}:{acc.get('NAME')}: {e}")

                state["last_update"] = datetime.now(timezone.utc).isoformat()
                state["tickers_count"] = sum(len(acc.get("TICKERS", {})) for acc in accounts if acc.get("ENABLED", True))
                
        except Exception as e:
            logger.error(f"Error in background trade loop: {e}")

        time.sleep(15)  # Runs every 15 seconds

# ── App Setup ─────────────────────────────────────────────────────────────────
app = FastAPI(title="Unified PriceAlert & Seller App")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Mount static files for Seller UI
app.mount("/assets", StaticFiles(directory=str(BASE_DIR / "assets")), name="assets")

@app.on_event("startup")
async def startup():
    # Initialize PriceAlert DBs
    init_user_db("Admin")
    init_registry_db()
    init_candles_db()
    
    # Start price streaming
    asyncio.create_task(stream_loop())
    asyncio.create_task(load_all_registries())
    for inst in CONFIG.get("default_instruments", []):
        watched[inst["figi"]] = 0.0
        
    # Initialize HA Analyzer
    ha_analyzer.configure(ws_manager=manager, notify_fn=send_native_notification)
    for inst in CONFIG.get("default_instruments", []):
        ha_analyzer.add_symbol(inst["figi"], inst.get("ticker", inst["figi"]), inst.get("name", ""))
    asyncio.create_task(ha_analyzer.start())
    
    # Start bot trading cycle in background daemon thread
    t = threading.Thread(target=background_trade_worker, daemon=True)
    t.start()
    
    logger.info(f"Unified Trading Platform started on :{PORT}")

# ── Static UI ─────────────────────────────────────────────────────────────────
@app.get("/")
async def root():
    return FileResponse(BASE_DIR / "frontend.html")

@app.get("/seller")
async def seller_dashboard():
    return FileResponse(BASE_DIR / "seller.html")

@app.get("/favicon.png")
async def favicon():
    return FileResponse(BASE_DIR / "icon.png")

@app.get("/health")
def health():
    return {"ok": True, "registry": REGISTRY_LOADED, "server_time": datetime.now(timezone.utc).isoformat()}

# ── PriceAlert REST API ───────────────────────────────────────────────────────
@app.get("/api/search")
async def search(q: str = Query(..., min_length=1)):
    local = search_registry(q)
    if local:
        return local
    try:
        from logic.tinkoff import t_post as alert_t_post
        data = await alert_t_post("/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument",
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

@app.get("/api/candles")
async def candles(figi: str, interval: str = "hour", bars: int = 300, to: Optional[int] = None):
    watched.setdefault(figi, 0.0)
    data = await get_candles_smart(figi, interval, bars, to)
    return {"candles": data, "figi": figi, "interval": interval}

@app.get("/api/price/{figi}")
async def price_endpoint(figi: str):
    p = await alert_get_last_price(figi)
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
    notify_telegram: Optional[int] = 1

@app.post("/api/ha/symbols")
async def add_ha_symbol(request: Request, s: HASymbolAdd):
    user_nick = request.headers.get("X-User-Nick") or request.query_params.get("user") or "Admin"
    ha_analyzer.add_symbol(s.figi, s.ticker, s.name)
    watched.setdefault(s.figi, 0.0)
    return {"ok": True}

@app.get("/api/ha/symbols")
def list_ha_symbols():
    return ha_analyzer.get_symbols()

@app.delete("/api/ha/symbols/{figi}")
def del_ha_symbol(figi: str):
    ha_analyzer.remove_symbol(figi)
    return {"ok": True}

@app.get("/api/ha/status")
def ha_status():
    return {
        "is_running": ha_analyzer.is_running,
        "symbols_count": len(ha_analyzer.symbols),
        "last_run": ha_analyzer.last_run_timestamp,
        "next_run": ha_analyzer.last_run_timestamp + ha_analyzer.refresh_interval if ha_analyzer.last_run_timestamp else None,
        "config": {
            "refresh_interval_seconds": ha_analyzer.refresh_interval,
            "trend_min_candles": ha_analyzer.trend_min_candles,
            "volume_high_threshold": ha_analyzer.volume_high_threshold,
            "volume_low_threshold": ha_analyzer.volume_low_threshold
        }
    }

@app.get("/api/ha/signals")
def ha_signals():
    return ha_analyzer.get_signals()

@app.get("/api/ha/config")
def ha_config():
    return {
        "refresh_interval_seconds": ha_analyzer.refresh_interval,
        "trend_min_candles": ha_analyzer.trend_min_candles,
        "volume_high_threshold": ha_analyzer.volume_high_threshold,
        "volume_low_threshold": ha_analyzer.volume_low_threshold,
        "alerts_enabled": ha_analyzer.alerts_enabled,
        "alert_on_reversal_only": ha_analyzer.alert_on_reversal_only
    }

@app.post("/api/ha/config")
def ha_config_update(cfg: HAConfigUpdate):
    if cfg.refresh_interval_seconds is not None:
        ha_analyzer.refresh_interval = cfg.refresh_interval_seconds
    if cfg.trend_min_candles is not None:
        ha_analyzer.trend_min_candles = cfg.trend_min_candles
    if cfg.volume_high_threshold is not None:
        ha_analyzer.volume_high_threshold = cfg.volume_high_threshold
    if cfg.volume_low_threshold is not None:
        ha_analyzer.volume_low_threshold = cfg.volume_low_threshold
    if cfg.alerts_enabled is not None:
        ha_analyzer.alerts_enabled = cfg.alerts_enabled
    if cfg.alert_on_reversal_only is not None:
        ha_analyzer.alert_on_reversal_only = cfg.alert_on_reversal_only
    return {"ok": True}

@app.get("/api/ha/log")
async def ha_log():
    # Read last 50 lines from ha log
    log_path = BASE_DIR / "data" / "ha_analyzer.log"
    if not log_path.exists():
        return {"lines": []}
    with open(log_path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    return {"lines": [l.strip() for l in lines[-50:]]}

@app.websocket("/ws/{nick}")
async def websocket_endpoint(ws: WebSocket, nick: str):
    await manager.connect(ws, nick)
    try:
        while True:
            # Keepalive
            data = await ws.receive_text()
            # Echo or ping handler
            await ws.send_json({"type": "pong", "ts": int(time.time())})
    except WebSocketDisconnect:
        manager.disconnect(ws, nick)

# ── Seller Trading Bot REST API ───────────────────────────────────────────────
@app.get("/api/status")
async def get_status(request: Request):
    nick = get_current_user_nick(request)
    
    # Check if first launch for user to seed ACTIVE_BOTS
    user_cfg = load_user_config(nick)
    settings_cfg = user_cfg.get("settings", {})
    token = settings_cfg.get("TOKEN", "")
    
    if nick not in ACTIVE_BOTS:
        ACTIVE_BOTS[nick] = {
            "bot_paused": True,
            "bot_running": True,
            "last_update": None,
            "tickers_count": 0,
        }
        
    state = ACTIVE_BOTS[nick]
    
    accounts = user_cfg.get("accounts", [])
    active_acc = None
    for acc in accounts:
        if acc.get("ENABLED", True):
            active_acc = acc
            break
            
    account_info = {}
    if active_acc and token:
        try:
            bind_user_context(nick, user_cfg)
            _apply_account_context_dynamic(active_acc, settings_cfg)
            with get_client(token) as client:
                port, _, _, _, _, _ = get_portfolio(client, active_acc.get("ACCOUNT_ID"))
                account_info = {
                    "account_name": active_acc.get("NAME"),
                    "account_id": active_acc.get("ACCOUNT_ID"),
                    "currency": "rub",
                }
        except Exception:
            pass

    return {
        "ok": True,
        "engine_running": True,
        "bot_running": state.get("bot_running", True),
        "bot_paused": state.get("bot_paused", True),
        "trading_now": is_trading_time(),
        "trading_mode": settings_cfg.get("MODE", "LIFO"),
        "last_update": state.get("last_update"),
        "server_time": datetime.now(timezone.utc).isoformat(),
        "token_configured": bool(token),
        **account_info
    }

@app.get("/api/config")
async def get_config(request: Request):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    settings_cfg = user_cfg.get("settings", {})
    return {
        "ok": True,
        "accounts": user_cfg.get("accounts", []),
        "settings": settings_cfg,
        "token_configured": bool(settings_cfg.get("TOKEN"))
    }

@app.get("/api/config/raw")
async def get_config_raw(request: Request):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    return {"ok": True, "text": json.dumps(user_cfg, indent=2, ensure_ascii=False)}

class RawConfigUpdate(BaseModel):
    text: str

@app.post("/api/config/raw")
async def update_config_raw(request: Request, payload: RawConfigUpdate):
    nick = get_current_user_nick(request)
    try:
        data = json.loads(payload.text)
        if not isinstance(data, dict):
            raise HTTPException(400, "Конфигурация должна быть объектом JSON")
            
        settings_cfg = data.get("settings", {})
        token = settings_cfg.get("TOKEN", "").strip()
        
        # Proactively discover accounts if a token was added but accounts lists are empty
        if token and not data.get("accounts"):
            discovered = discover_accounts_for_token(token)
            if discovered:
                data["accounts"] = discovered
                
        save_user_config(nick, data)
        logger.info(f"Updated raw configuration for user: {nick}")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}

class ConfigUpdate(BaseModel):
    settings: Optional[dict] = None
    accounts: Optional[list] = None

@app.post("/api/config/update")
async def update_config(request: Request, payload: ConfigUpdate):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    
    if payload.settings is not None:
        user_cfg["settings"].update(payload.settings)
        token = payload.settings.get("TOKEN", "").strip()
        if token and not user_cfg.get("accounts"):
            discovered = discover_accounts_for_token(token)
            if discovered:
                user_cfg["accounts"] = discovered
                
    if payload.accounts is not None:
        user_cfg["accounts"] = payload.accounts
        
    save_user_config(nick, user_cfg)
    return {"ok": True}

@app.get("/api/portfolio")
async def get_portfolio_endpoint(request: Request, account_id: str, refresh: bool = False):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    settings_cfg = user_cfg.get("settings", {})
    
    account = None
    for acc in user_cfg.get("accounts", []):
        if acc.get("ACCOUNT_ID") == account_id:
            account = acc
            break
    if not account:
        raise HTTPException(404, "Аккаунт не найден")

    bind_user_context(nick, user_cfg)
    _apply_account_context_dynamic(account, settings_cfg)

    try:
        live_map, live_total_yield, total_value = _load_live_portfolio(account_id)
        commission_rate = float(settings_cfg.get("COMMISSION_RATE", 0.0005))
        mode = settings_cfg.get("MODE", "LIFO")
        
        config_figis = list((account.get("TICKERS") or {}).keys())
        live_figis = list(live_map.keys())
        data_figis = _list_figis_from_data(account_id)
        
        seen_figis = set()
        merged_figis = []
        for f in config_figis + live_figis + data_figis:
            if f and f not in seen_figis:
                seen_figis.add(f)
                merged_figis.append(f)
                
        prices = {}
        info_map = {}
        token = settings.TOKEN
        if token:
            with get_client(token) as client:
                prices = _get_last_prices(client, merged_figis)
                for f in merged_figis:
                    meta = read_figi_meta(f, account_id) or {}
                    if not meta.get("ticker"):
                        try:
                            info = get_figi_info(client, f)
                            if info:
                                info_map[f] = info
                                update_figi_meta(f, account_id, info)
                        except Exception:
                            info_map[f] = meta
                    else:
                        info_map[f] = meta

        assets = []
        for f in merged_figis:
            cfg = (account.get("TICKERS") or {}).get(f, {})
            history = _load_history(account_id, f)
            series = _compute_pnl_series(history, mode, commission_rate)
            last_pnl = series[-1]["v"] if series else 0.0
            
            live = live_map.get(f, {})
            meta = info_map.get(f, {})
            instrument_type = _normalize_type(live.get("instrument_type") or cfg.get("INSTRUMENT_TYPE") or meta.get("type"))
            go_margins = _resolve_go_margins(cfg, meta, live)
            
            start_value, start_note = _get_figi_year_start_value(account_id, f, cfg, instrument_type, go_margins, live)
            cashflows, mwr_series = _compute_mwr_for_figi(history, mode, commission_rate, instrument_type, go_margins, datetime(datetime.now(timezone.utc).year, 1, 1).date(), start_value)
            end_value = _live_figi_value_for_mwr(live, instrument_type, go_margins)
            
            mwr_rate = None
            if end_value is not None:
                mwr_rate = _xirr(cashflows + [(datetime.now(timezone.utc).date(), float(end_value))])
                
            assets.append({
                "figi": f,
                "ticker": meta.get("ticker") or cfg.get("NAME") or f,
                "name": meta.get("name") or cfg.get("NAME") or f,
                "instrument_type": instrument_type or "share",
                "in_portfolio": bool(live),
                "qty": live.get("qty", 0.0),
                "avg_price": live.get("avg_price", 0.0),
                "current_price": prices.get(f) or live.get("current_price", 0.0),
                "pnl_value": live.get("pnl_value", last_pnl),
                "pnl_percent": live.get("pnl_percent", 0.0),
                "mwr_rate": round(mwr_rate * 100, 2) if mwr_rate else 0.0,
                "mwr_note": start_note
            })

        return {
            "ok": True,
            "total_value": total_value,
            "total_pnl": live_total_yield,
            "assets": assets
        }
    except Exception as e:
        logger.error(f"Error compiling portfolio payload: {e}")
        return {"ok": False, "error": str(e)}

@app.get("/api/portfolios_summary")
async def get_portfolios_summary(request: Request):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    settings_cfg = user_cfg.get("settings", {})
    
    bind_user_context(nick, user_cfg)
    summary_accounts = []
    
    for acc in user_cfg.get("accounts", []):
        try:
            live_map, live_total, total_value = _load_live_portfolio(acc.get("ACCOUNT_ID"))
            summary_accounts.append({
                "name": acc.get("NAME"),
                "account_id": acc.get("ACCOUNT_ID"),
                "total_value": total_value,
                "pnl": live_total,
                "enabled": acc.get("ENABLED", True)
            })
        except Exception:
            summary_accounts.append({
                "name": acc.get("NAME"),
                "account_id": acc.get("ACCOUNT_ID"),
                "total_value": 0.0,
                "pnl": 0.0,
                "enabled": acc.get("ENABLED", True)
            })
            
    return {"ok": True, "accounts": summary_accounts}

@app.get("/api/summary")
async def get_summary(request: Request, range: str = "month"):
    return {"ok": True, "series": []}

@app.get("/api/portfolio_pnl")
async def get_portfolio_pnl(request: Request, account_id: str, range: str = "week"):
    return {"ok": True, "pnl_today": 0.0, "series": []}

@app.get("/api/figi_info")
async def get_figi_info_endpoint(request: Request, figi: str):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    token = user_cfg.get("settings", {}).get("TOKEN")
    
    if not token:
        raise HTTPException(400, "Токен не настроен")
        
    try:
        bind_user_context(nick, user_cfg)
        with get_client(token) as client:
            info = get_figi_info(client, figi)
            return {"ok": True, "info": info}
    except Exception as e:
        return {"ok": False, "error": str(e)}

@app.get("/api/estimate_max")
async def get_estimate(request: Request, account_id: str):
    return {"ok": True, "max_buy_estimated": 100000.0}

class ControlPayload(BaseModel):
    action: str

@app.post("/api/control")
async def send_command(request: Request, payload: ControlPayload):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    settings_cfg = user_cfg.get("settings", {})
    token = settings_cfg.get("TOKEN", "")
    
    if not token:
        raise HTTPException(400, "Токен не настроен")
        
    if nick not in ACTIVE_BOTS:
        ACTIVE_BOTS[nick] = {
            "bot_paused": True,
            "bot_running": True,
            "last_update": None,
            "tickers_count": 0,
        }
        
    state = ACTIVE_BOTS[nick]
    action = payload.action.lower()
    
    bind_user_context(nick, user_cfg)
    
    if action == "start":
        state["bot_paused"] = False
        logger.info(f"User {nick} STARTED the bot trading loop.")
        return {"ok": True}
        
    elif action == "stop":
        state["bot_paused"] = True
        logger.info(f"User {nick} STOPPED the bot trading loop. Cancelling orders...")
        try:
            for acc in user_cfg.get("accounts", []):
                _apply_account_context_dynamic(acc, settings_cfg)
                with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                    cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
                    rebalance_portfolio(client)
        except Exception as e:
            logger.error(f"Error during stop cancel/rebalance: {e}")
        return {"ok": True}
        
    elif action == "cancel":
        logger.info(f"User {nick} triggered CANCEL all orders.")
        try:
            for acc in user_cfg.get("accounts", []):
                _apply_account_context_dynamic(acc, settings_cfg)
                with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                    cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}
        
    elif action == "cancel_rebalance":
        logger.info(f"User {nick} triggered CANCEL & REBALANCE.")
        try:
            for acc in user_cfg.get("accounts", []):
                _apply_account_context_dynamic(acc, settings_cfg)
                with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                    cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
                    rebalance_portfolio(client)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True}
        
    return {"ok": False, "error": "Неизвестная команда"}

@app.get("/api/logs")
async def get_logs(request: Request, limit: int = 200):
    nick = get_current_user_nick(request)
    log_path = get_user_dir(nick) / "bot_logs.log"
    
    if not log_path.exists():
        log_path.write_text(f"[{datetime.now().isoformat()}] Бот инициализирован. Ожидание запуска...\n", encoding="utf-8")
        
    lines = []
    try:
        with open(log_path, "rb") as f:
            raw = f.read()
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("cp1251", errors="replace")
        lines = text.splitlines()[-limit:]
    except Exception as e:
        return {"ok": False, "error": str(e), "lines": []}
        
    return {"ok": True, "lines": lines}

@app.get("/api/logs/download")
async def download_logs(request: Request, detail: bool = False):
    nick = get_current_user_nick(request)
    user_dir = get_user_dir(nick)
    filename = "bot_logs_detailed.log" if detail else "bot_logs.log"
    log_path = user_dir / filename
    if not log_path.exists():
        log_path.write_text(f"[{datetime.now().isoformat()}] Лог файл пуст.\n", encoding="utf-8")
    return FileResponse(log_path, media_type="text/plain", filename=filename)

@app.get("/api/analytics/top100")
async def get_top100(request: Request, refresh: bool = False):
    nick = get_current_user_nick(request)
    user_cfg = load_user_config(nick)
    token = user_cfg.get("settings", {}).get("TOKEN")
    file_path = ROOT_DIR / "data" / "analytics" / "top100_shares_rub.json"
    
    if refresh and token:
        bind_user_context(nick, user_cfg)
        prev_token = settings.TOKEN
        settings.TOKEN = token
        monthly_dir = ROOT_DIR / "data" / "analytics" / datetime.now(timezone.utc).strftime("%Y-%m")
        try:
            generate_top100_json(file_path, monthly_dir=monthly_dir)
        except Exception:
            pass
        finally:
            settings.TOKEN = prev_token
            
    if not file_path.exists():
        return {"ok": True, "items": []}
        
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            payload.setdefault("ok", True)
        return payload if isinstance(payload, dict) else {"ok": True, "items": payload}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ── Entrypoint ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
