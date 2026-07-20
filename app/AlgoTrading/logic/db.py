from pathlib import Path
import json
import sqlite3

# Resolve BASE_DIR as the root of the pricealert app
BASE_DIR = Path(__file__).parent.parent
CONFIG_PATH = BASE_DIR / "config.json"
with open(CONFIG_PATH, encoding="utf-8") as f:
    CONFIG = json.load(f)

DATA_DIR = CONFIG["data_dir"]

# ── DB paths ──────────────────────────────────────────────────────────────────
def get_user_db(nick="Admin") -> Path:
    p = Path(DATA_DIR.replace("{nick}", nick))
    p.mkdir(parents=True, exist_ok=True)
    return p / "pricealert.db"

def get_registry_db() -> Path:
    p = BASE_DIR / "data"
    p.mkdir(exist_ok=True)
    return p / "registry.db"

def get_candles_db() -> Path:
    p = BASE_DIR / "data"
    p.mkdir(exist_ok=True)
    return p / "candles.db"

# ── DB init ───────────────────────────────────────────────────────────────────
def init_user_db(nick="Admin"):
    conn = sqlite3.connect(get_user_db(nick), timeout=15.0)
    try: conn.execute("PRAGMA journal_mode=WAL")
    except Exception: pass
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS alerts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        nick         TEXT NOT NULL,
        figi         TEXT NOT NULL,
        ticker       TEXT NOT NULL,
        timeframe    TEXT NOT NULL,
        type         TEXT NOT NULL,
        price1       REAL,  price2 REAL,
        time1        INTEGER, time2 INTEGER,
        direction    TEXT DEFAULT 'cross',
        message      TEXT,
        active       INTEGER DEFAULT 1,
        triggered    INTEGER DEFAULT 0,
        line_id      INTEGER,
        created_at   INTEGER NOT NULL,
        triggered_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS alert_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id     INTEGER, nick TEXT, figi TEXT, ticker TEXT,
        price        REAL, triggered_at INTEGER, message TEXT
    );
    CREATE TABLE IF NOT EXISTS lines (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        nick        TEXT NOT NULL,
        figi        TEXT NOT NULL,
        ticker      TEXT NOT NULL,
        timeframe   TEXT NOT NULL,
        type        TEXT NOT NULL,
        price1      REAL,  price2 REAL,
        time1       INTEGER, time2 INTEGER,
        color       TEXT DEFAULT '#FFD700',
        width       INTEGER DEFAULT 1,
        dash        TEXT DEFAULT 'solid',
        label       TEXT,
        extra_json  TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS watchlist (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        nick    TEXT NOT NULL,
        figi    TEXT NOT NULL,
        ticker  TEXT NOT NULL,
        name    TEXT,
        sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chart_settings (
        nick        TEXT NOT NULL,
        figi        TEXT NOT NULL,
        timeframe   TEXT NOT NULL,
        indicators  TEXT,
        settings    TEXT,
        PRIMARY KEY (nick, figi, timeframe)
    );
    CREATE TABLE IF NOT EXISTS ha_alerts (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol          TEXT NOT NULL,
        trigger_reversal INTEGER DEFAULT 1,
        reversal_tf      TEXT DEFAULT '1h,4h',
        reversal_min_candles INTEGER DEFAULT 3,
        trigger_spike    INTEGER DEFAULT 0,
        spike_tf         TEXT DEFAULT '1h',
        spike_pct        REAL DEFAULT 2.5,
        spike_direction  TEXT DEFAULT 'any',
        trigger_volume   INTEGER DEFAULT 0,
        volume_multiplier REAL DEFAULT 1.5,
        volume_trend_only INTEGER DEFAULT 1,
        trigger_combo    INTEGER DEFAULT 0,
        notify_push      INTEGER DEFAULT 1,
        notify_telegram  INTEGER DEFAULT 1,
        notify_sound     INTEGER DEFAULT 0,
        active           INTEGER DEFAULT 1,
        last_trigger_ts  INTEGER DEFAULT 0,
        created_at       TEXT
    );
    CREATE TABLE IF NOT EXISTS ha_alert_log (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id        INTEGER,
        nick            TEXT NOT NULL,
        symbol          TEXT NOT NULL,
        trigger_type    TEXT NOT NULL,
        message         TEXT,
        triggered_at    INTEGER
    );
    """)
    conn.commit()
    conn.close()

def init_registry_db():
    conn = sqlite3.connect(get_registry_db(), timeout=15.0)
    try: conn.execute("PRAGMA journal_mode=WAL")
    except Exception: pass
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS instruments (
        figi        TEXT PRIMARY KEY,
        ticker      TEXT NOT NULL,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        currency    TEXT,
        lot         INTEGER DEFAULT 1,
        exchange    TEXT,
        sector      TEXT,
        updated_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ticker ON instruments(ticker);
    CREATE VIRTUAL TABLE IF NOT EXISTS instruments_fts
        USING fts5(figi, ticker, name, content='instruments', content_rowid='rowid');
    """)
    conn.commit()
    conn.close()

def init_candles_db():
    conn = sqlite3.connect(get_candles_db(), timeout=15.0)
    try: conn.execute("PRAGMA journal_mode=WAL")
    except Exception: pass
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS candles (
        figi      TEXT NOT NULL,
        interval  TEXT NOT NULL,
        ts        INTEGER NOT NULL,
        open      REAL, high REAL, low REAL, close REAL,
        volume    INTEGER,
        PRIMARY KEY (figi, interval, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_candles ON candles(figi, interval, ts);
    """)
    conn.commit()
    conn.close()

# ── Candle DB helpers ─────────────────────────────────────────────────────────
def store_candles(figi: str, interval: str, candles: list):
    if not candles:
        return
    conn = sqlite3.connect(get_candles_db(), timeout=15.0)
    try: conn.execute("PRAGMA journal_mode=WAL")
    except Exception: pass
    conn.executemany(
        "INSERT OR REPLACE INTO candles(figi,interval,ts,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,?)",
        [(figi, interval, c["time"], c["open"], c["high"], c["low"], c["close"], c.get("volume",0)) for c in candles]
    )
    conn.commit()
    conn.close()

def get_cached_candles(figi: str, interval: str, from_ts: int, to_ts: int) -> list:
    conn = sqlite3.connect(get_candles_db(), timeout=15.0)
    rows = conn.execute(
        "SELECT ts,open,high,low,close,volume FROM candles WHERE figi=? AND interval=? AND ts>=? AND ts<=? ORDER BY ts",
        (figi, interval, from_ts, to_ts)
    ).fetchall()
    conn.close()
    return [{"time":r[0],"open":r[1],"high":r[2],"low":r[3],"close":r[4],"volume":r[5]} for r in rows]

def find_gaps(figi: str, interval: str, from_ts: int, to_ts: int, interval_sec: int) -> list:
    """Find missing ranges in candle cache. Returns list of (from,to) tuples."""
    cached = get_cached_candles(figi, interval, from_ts, to_ts)
    if not cached:
        return [(from_ts, to_ts)]
    gaps = []
    if cached[0]["time"] - from_ts > interval_sec * 2:
        gaps.append((from_ts, cached[0]["time"] - 1))
    for i in range(1, len(cached)):
        gap = cached[i]["time"] - cached[i-1]["time"]
        if gap > interval_sec * 2:
            gaps.append((cached[i-1]["time"] + interval_sec, cached[i]["time"] - 1))
    if to_ts - cached[-1]["time"] > interval_sec * 2:
        gaps.append((cached[-1]["time"] + interval_sec, to_ts))
    return gaps

def get_ticker_by_figi(figi: str) -> str:
    if figi.startswith("MOEX:"):
        return figi.split(":", 1)[1]
    try:
        conn = sqlite3.connect(get_registry_db())
        row = conn.execute("SELECT ticker FROM instruments WHERE figi=?", (figi,)).fetchone()
        conn.close()
        if row:
            return row[0]
    except Exception:
        pass
    return figi

