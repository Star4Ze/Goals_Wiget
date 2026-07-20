"""
HeikinAshi Trend Analyzer — фоновый аналитический модуль.

Каждые N минут (по умолчанию 5) загружает 100 свечей 1H и 4H
для каждого отслеживаемого инструмента, рассчитывает Heikin Ashi,
анализирует тренд и эмитит MTF-сигнал через WebSocket.
"""

import asyncio
import logging
import time
import os
import sqlite3
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional
from logic.db import get_user_db, BASE_DIR

log = logging.getLogger("ha_analyzer")

# ── Default Configuration ──────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "refresh_interval_seconds": 300,   # 5 минут
    "candles_lookback": 100,
    "trend_min_candles": 3,            # минимум свечей для определения тренда
    "volume_high_threshold": 1.5,      # vol_ratio > 1.5 → HIGH
    "volume_low_threshold": 0.7,       # vol_ratio < 0.7 → LOW
    "alerts_enabled": True,
    "alert_on_reversal_only": False,
    "no_wick_threshold": 0.05,         # 5% от тела = "нет хвоста"
    "small_body_threshold": 0.30,      # < 30% от средн. тела = "маленькое тело"
}


class HeikinAshiAnalyzer:
    """
    Центральный класс HA Analyzer.
    Использует asyncio для планировщика и ссылается на
    get_candles_smart из tinkoff.py для загрузки данных.
    """

    def __init__(self):
        self.config = dict(DEFAULT_CONFIG)
        # figi -> {ticker, name}
        self.symbols: dict[str, dict] = {}
        # figi -> текущий сигнал (последний)
        self.current_signals: dict[str, dict] = {}
        # figi -> list of signals (история, последние 20)
        self.signal_history: dict[str, list] = {}
        # figi -> предыдущий mtf_signal (для определения изменений)
        self.prev_mtf: dict[str, Optional[str]] = {}
        # флаг что цикл запущен
        self._running = False
        # ссылка на ws manager (внедряется из api.py)
        self.ws_manager = None
        # ссылка на send_native_notification
        self.notify_fn = None
        # время последнего обновления (timestamp)
        self.last_update: float = 0

    def configure(self, ws_manager, notify_fn):
        """Внедрить зависимости (вызывается из api.py при startup)."""
        self.ws_manager = ws_manager
        self.notify_fn = notify_fn

    def add_symbol(self, figi: str, ticker: str, name: str = ""):
        """Добавить инструмент в наблюдение."""
        self.symbols[figi] = {"ticker": ticker, "name": name}
        if figi not in self.signal_history:
            self.signal_history[figi] = []
        log.info(f"HA Analyzer: добавлен {ticker} ({figi})")

    def remove_symbol(self, figi: str):
        """Убрать инструмент из наблюдения."""
        self.symbols.pop(figi, None)
        self.current_signals.pop(figi, None)
        log.info(f"HA Analyzer: убран {figi}")

    def get_signals(self) -> list:
        """Вернуть текущие сигналы по всем инструментам."""
        return list(self.current_signals.values())

    def get_signal(self, figi: str) -> Optional[dict]:
        """Вернуть текущий сигнал по конкретному figi."""
        return self.current_signals.get(figi)

    def get_history(self, figi: str) -> list:
        """Вернуть историю сигналов (последние 20)."""
        return self.signal_history.get(figi, [])

    def update_config(self, updates: dict):
        """Обновить конфигурацию."""
        self.config.update(updates)

    async def start(self):
        """Запустить планировщик."""
        if self._running:
            return
        self._running = True
        log.info("HA Analyzer: планировщик запущен")
        # Первый прогон немедленно
        await self._safe_run_cycle()
        while self._running:
            await asyncio.sleep(self.config["refresh_interval_seconds"])
            await self._safe_run_cycle()

    async def stop(self):
        """Остановить планировщик."""
        self._running = False

    async def trigger_now(self):
        """Ручной триггер обновления."""
        await self._safe_run_cycle()

    async def _safe_run_cycle(self):
        """Обёртка с retry при ошибке."""
        try:
            await self.run_cycle()
        except Exception as e:
            log.error(f"HA Analyzer цикл упал: {e}. Retry через 30 сек.")
            await asyncio.sleep(30)
            try:
                await self.run_cycle()
            except Exception as e2:
                log.error(f"HA Analyzer retry тоже упал: {e2}")

    async def run_cycle(self):
        """Один цикл анализа всех инструментов."""
        if not self.symbols:
            return

        # Импорт здесь чтобы избежать циклических импортов
        from logic.tinkoff import get_candles_smart

        self.last_update = time.time()
        log.info(f"HA Analyzer: цикл для {len(self.symbols)} инструментов")

        for figi, meta in list(self.symbols.items()):
            try:
                await self._analyze_symbol(figi, meta, get_candles_smart)
            except Exception as e:
                log.warning(f"HA Analyzer: ошибка для {meta.get('ticker', figi)}: {e}")

    async def _analyze_symbol(self, figi: str, meta: dict, get_candles_smart):
        """Анализ одного инструмента."""
        lookback = self.config["candles_lookback"]
        ticker = meta.get("ticker", figi)

        # Загружаем 1H и 4H параллельно
        candles_1h, candles_4h = await asyncio.gather(
            get_candles_smart(figi, "hour", lookback),
            get_candles_smart(figi, "4hour", lookback),
            return_exceptions=True
        )

        if isinstance(candles_1h, Exception) or not candles_1h:
            log.warning(f"HA: нет данных 1H для {ticker}")
            candles_1h = []
        if isinstance(candles_4h, Exception) or not candles_4h:
            log.warning(f"HA: нет данных 4H для {ticker}")
            candles_4h = []

        if len(candles_1h) < 10 or len(candles_4h) < 10:
            log.warning(f"HA: недостаточно свечей для {ticker} (1H:{len(candles_1h)}, 4H:{len(candles_4h)})")
            return

        # Рассчитываем HA
        ha_1h = self.calc_ha(candles_1h)
        ha_4h = self.calc_ha(candles_4h)

        # Анализ объёмов
        vol_1h = self.calc_volume(candles_1h)
        vol_4h = self.calc_volume(candles_4h)

        # Тренд по каждому ТФ
        trend_1h = self.analyze_trend(ha_1h, vol_1h)
        trend_4h = self.analyze_trend(ha_4h, vol_4h)

        # MTF сигнал
        mtf = self.mtf_signal(trend_1h["trend"], trend_4h["trend"])

        # Финальный объект
        signal = self._build_signal(
            figi, ticker, mtf, trend_1h, trend_4h,
            ha_1h, ha_4h, vol_1h, vol_4h
        )

        # Проверяем изменение сигнала
        prev = self.prev_mtf.get(figi)
        signal_changed = (prev != mtf)

        self.current_signals[figi] = signal
        self.prev_mtf[figi] = mtf

        # История (последние 20)
        hist = self.signal_history.setdefault(figi, [])
        hist.append(signal)
        if len(hist) > 20:
            hist.pop(0)

        # Отправляем WS-событие
        if self.ws_manager:
            ws_event = {"type": "ha_signal", **signal}
            await self.ws_manager.broadcast(ws_event)

        # Check user-specific HA alerts
        await self.check_user_ha_alerts(figi, ticker, signal, ha_1h, ha_4h)

        # Отправляем нативное уведомление при изменении сигнала
        if signal_changed and self.config.get("alerts_enabled"):
            await self._maybe_send_alert(figi, ticker, signal, prev)

        log.info(f"HA [{ticker}]: {mtf} (1H:{trend_1h['trend']}, 4H:{trend_4h['trend']})")

    # ── HA Calculator ──────────────────────────────────────────────────────────

    def calc_ha(self, candles: list) -> list:
        """
        Рассчитать Heikin Ashi свечи из обычных.
        Входные свечи: [{time, open, high, low, close, volume}, ...]
        """
        if not candles:
            return []
        result = []
        ha_open_prev = None
        ha_close_prev = None

        for i, c in enumerate(candles):
            o = float(c["open"])
            h = float(c["high"])
            l = float(c["low"])
            cl = float(c["close"])
            vol = float(c.get("volume", 0))

            ha_close = (o + h + l + cl) / 4.0

            if i == 0:
                ha_open = (o + cl) / 2.0
            else:
                ha_open = (ha_open_prev + ha_close_prev) / 2.0

            ha_high = max(h, ha_open, ha_close)
            ha_low  = min(l, ha_open, ha_close)

            body_size = abs(ha_close - ha_open)
            upper_wick = ha_high - max(ha_open, ha_close)
            lower_wick = min(ha_open, ha_close) - ha_low
            is_bullish = ha_close > ha_open

            thresh = self.config["no_wick_threshold"]
            # Порог 5% от тела (минимум 0.0001 чтобы не делить на 0)
            body_thresh = body_size * thresh if body_size > 0 else 0.0001

            result.append({
                "time": c["time"],
                "open":  ha_open,
                "high":  ha_high,
                "low":   ha_low,
                "close": ha_close,
                "volume": vol,
                # Производные метрики
                "body_size":    body_size,
                "upper_wick":   upper_wick,
                "lower_wick":   lower_wick,
                "is_bullish":   is_bullish,
                "no_lower_wick": lower_wick < body_thresh,
                "no_upper_wick": upper_wick < body_thresh,
            })

            ha_open_prev  = ha_open
            ha_close_prev = ha_close

        return result

    # ── Volume Analyzer ────────────────────────────────────────────────────────

    def calc_volume(self, candles: list) -> dict:
        """
        Анализ объёмов.
        Возвращает: {vol_sma20, vol_ratio, vol_trend, vol_signal}
        """
        if len(candles) < 5:
            return {"vol_sma20": 0, "vol_ratio": 1.0, "vol_trend": "FLAT", "vol_signal": "NORMAL"}

        vols = [float(c.get("volume", 0)) for c in candles]
        cur_vol = vols[-1]

        # SMA20 по последним 20 свечам (или сколько есть)
        sma_window = vols[-20:] if len(vols) >= 20 else vols
        vol_sma20 = sum(sma_window) / len(sma_window) if sma_window else 1

        vol_ratio = cur_vol / vol_sma20 if vol_sma20 > 0 else 1.0

        # vol_trend: среднее последних 5 vs предыдущих 5
        if len(vols) >= 10:
            recent_avg = sum(vols[-5:]) / 5
            prev_avg   = sum(vols[-10:-5]) / 5
            vol_trend  = "UP" if recent_avg > prev_avg * 1.1 else ("DOWN" if recent_avg < prev_avg * 0.9 else "FLAT")
        else:
            vol_trend = "FLAT"

        high_th = self.config["volume_high_threshold"]
        low_th  = self.config["volume_low_threshold"]

        if vol_ratio > high_th:
            vol_signal = "HIGH"
        elif vol_ratio < low_th:
            vol_signal = "LOW"
        else:
            vol_signal = "NORMAL"

        return {
            "vol_sma20":  round(vol_sma20, 2),
            "vol_ratio":  round(vol_ratio, 4),
            "vol_trend":  vol_trend,
            "vol_signal": vol_signal,
        }

    # ── Trend Engine ───────────────────────────────────────────────────────────

    def analyze_trend(self, ha_candles: list, vol_data: dict) -> dict:
        """
        Определить тренд по HA-свечам.
        Возвращает:
        {
          trend: UPTREND|DOWNTREND|REVERSAL_BULL|REVERSAL_BEAR|FLAT,
          strength: STRONG|MODERATE|WEAK,
          consecutive_candles: int,
          volume_confirms: bool
        }
        """
        if len(ha_candles) < 3:
            return {
                "trend": "FLAT", "strength": "WEAK",
                "consecutive_candles": 0, "volume_confirms": False
            }

        min_candles = self.config["trend_min_candles"]
        recent = ha_candles[-10:]  # последние 10 для анализа

        # --- Считаем серию подряд идущих свечей одного цвета ---
        consecutive = 1
        last_bullish = recent[-1]["is_bullish"]
        for i in range(len(recent) - 2, -1, -1):
            if recent[i]["is_bullish"] == last_bullish:
                consecutive += 1
            else:
                break

        # --- Средний размер тела за последние 20 (или сколько есть) ---
        all_bodies = [c["body_size"] for c in ha_candles[-20:] if c["body_size"] > 0]
        avg_body = sum(all_bodies) / len(all_bodies) if all_bodies else 0.0001

        # Последние N свечей
        last_n = recent[-min_candles:]

        # Подсчёт без нижних / верхних хвостов
        bullish_count = sum(1 for c in last_n if c["is_bullish"])
        no_lower_count = sum(1 for c in last_n if c["no_lower_wick"])
        no_upper_count = sum(1 for c in last_n if c["no_upper_wick"])

        majority = len(last_n) // 2 + 1  # большинство

        # --- Динамика тел (растут?) ---
        body_growing = False
        if len(recent) >= 3:
            bodies_recent = [c["body_size"] for c in recent[-3:]]
            body_growing = bodies_recent[-1] > bodies_recent[0]

        # Проверяем уменьшение тела (сигнал разворота)
        body_shrinking = False
        if len(recent) >= 3:
            bodies_recent = [c["body_size"] for c in recent[-3:]]
            body_shrinking = bodies_recent[-1] < bodies_recent[0] * 0.5  # уменьшилось вдвое

        small_body_thresh = self.config["small_body_threshold"]
        last_body_small = (recent[-1]["body_size"] < avg_body * small_body_thresh)

        # --- Предыдущая серия (для обнаружения разворота) ---
        prev_bullish = not last_bullish  # противоположный тренд до текущей серии
        prev_consecutive = 0
        for i in range(len(recent) - 1 - consecutive, -1, -1):
            if recent[i]["is_bullish"] == prev_bullish:
                prev_consecutive += 1
            else:
                break

        was_trend = prev_consecutive >= min_candles

        # --- Определяем тренд ---
        trend = "FLAT"
        strength = "WEAK"

        if consecutive >= min_candles:
            if last_bullish:
                # Проверка разворота: была нисходящая серия, теперь первая бычья
                if was_trend and not prev_bullish and consecutive < min_candles:
                    trend = "REVERSAL_BULL"
                    strength = "MODERATE"
                else:
                    trend = "UPTREND"
                    if no_lower_count >= majority:
                        strength = "STRONG" if consecutive >= min_candles + 1 else "MODERATE"
                    elif body_growing:
                        strength = "MODERATE"
                    else:
                        strength = "WEAK"
            else:
                # Медвежий
                if was_trend and prev_bullish and consecutive < min_candles:
                    trend = "REVERSAL_BEAR"
                    strength = "MODERATE"
                else:
                    trend = "DOWNTREND"
                    if no_upper_count >= majority:
                        strength = "STRONG" if consecutive >= min_candles + 1 else "MODERATE"
                    elif body_growing:
                        strength = "MODERATE"
                    else:
                        strength = "WEAK"

        # Признаки разворота при текущем тренде
        if trend == "UPTREND" and (body_shrinking or last_body_small or recent[-1].get("upper_wick", 0) > recent[-1]["body_size"] * 0.5):
            # Появление верхней тени при восходящем
            if recent[-1]["is_bullish"] is False:
                trend = "REVERSAL_BEAR"
                strength = "MODERATE"

        if trend == "DOWNTREND" and (body_shrinking or last_body_small or recent[-1].get("lower_wick", 0) > recent[-1]["body_size"] * 0.5):
            # Появление нижней тени при нисходящем
            if recent[-1]["is_bullish"] is True:
                trend = "REVERSAL_BULL"
                strength = "MODERATE"

        # Чередование → FLAT
        if trend == "FLAT":
            alternating = sum(
                1 for i in range(1, len(recent))
                if recent[i]["is_bullish"] != recent[i-1]["is_bullish"]
            )
            if alternating > len(recent) * 0.5:
                trend = "FLAT"
                strength = "WEAK"

        # Подтверждение объёмом
        vol_signal = vol_data.get("vol_signal", "NORMAL")
        volume_confirms = (
            (trend in ("UPTREND", "REVERSAL_BULL") and vol_signal == "HIGH") or
            (trend in ("DOWNTREND", "REVERSAL_BEAR") and vol_signal == "HIGH")
        )

        return {
            "trend": trend,
            "strength": strength,
            "consecutive_candles": consecutive,
            "volume_confirms": volume_confirms,
        }

    # ── MTF Signal ─────────────────────────────────────────────────────────────

    def mtf_signal(self, trend_1h: str, trend_4h: str) -> str:
        """
        Межтаймфреймовый анализ.
        Возвращает: CONFIRMED_UP | CONFIRMED_DOWN | PULLBACK_END_UP |
                    PULLBACK_END_DOWN | CONFLICT | NO_SIGNAL
        """
        matrix = {
            ("UPTREND",      "UPTREND"):      "CONFIRMED_UP",
            ("DOWNTREND",    "DOWNTREND"):    "CONFIRMED_DOWN",
            ("REVERSAL_BULL","UPTREND"):      "PULLBACK_END_UP",
            ("REVERSAL_BEAR","DOWNTREND"):    "PULLBACK_END_DOWN",
            ("UPTREND",      "DOWNTREND"):    "CONFLICT",
            ("DOWNTREND",    "UPTREND"):      "CONFLICT",
        }
        key = (trend_1h, trend_4h)
        if key in matrix:
            return matrix[key]
        if "FLAT" in (trend_1h, trend_4h):
            return "NO_SIGNAL"
        # Остальные комбинации
        if trend_1h == trend_4h:
            return "CONFIRMED_UP" if "UP" in trend_1h else "CONFIRMED_DOWN"
        return "CONFLICT"

    # ── Signal Builder ─────────────────────────────────────────────────────────

    def _build_signal(self, figi, ticker, mtf, trend_1h, trend_4h,
                      ha_1h, ha_4h, vol_1h, vol_4h) -> dict:
        """Сформировать финальный объект сигнала."""
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        last_ha_close_1h = ha_1h[-1]["close"] if ha_1h else 0
        last_ha_close_4h = ha_4h[-1]["close"] if ha_4h else 0

        # Текст алерта
        alert_trigger = mtf in ("CONFIRMED_UP", "CONFIRMED_DOWN", "PULLBACK_END_UP", "PULLBACK_END_DOWN")
        reason = self._build_reason(mtf, trend_1h, trend_4h, vol_1h, vol_4h)

        return {
            "symbol":       ticker,
            "figi":         figi,
            "updated_at":   now_iso,
            "updated_ts":   int(time.time()),
            "mtf_signal":   mtf,
            "timeframes": {
                "1h": {
                    "trend":               trend_1h["trend"],
                    "strength":            trend_1h["strength"],
                    "consecutive_candles": trend_1h["consecutive_candles"],
                    "volume_confirms":     trend_1h["volume_confirms"],
                    "vol_ratio":           vol_1h["vol_ratio"],
                    "vol_signal":          vol_1h["vol_signal"],
                    "last_ha_close":       round(last_ha_close_1h, 6),
                },
                "4h": {
                    "trend":               trend_4h["trend"],
                    "strength":            trend_4h["strength"],
                    "consecutive_candles": trend_4h["consecutive_candles"],
                    "volume_confirms":     trend_4h["volume_confirms"],
                    "vol_ratio":           vol_4h["vol_ratio"],
                    "vol_signal":          vol_4h["vol_signal"],
                    "last_ha_close":       round(last_ha_close_4h, 6),
                },
            },
            "alert": {
                "trigger": alert_trigger,
                "reason":  reason,
            },
        }

    def _build_reason(self, mtf, trend_1h, trend_4h, vol_1h, vol_4h) -> str:
        """Сформировать человекочитаемое описание сигнала."""
        reasons = {
            "CONFIRMED_UP":      "Оба таймфрейма подтверждают восходящий тренд.",
            "CONFIRMED_DOWN":    "Оба таймфрейма подтверждают нисходящий тренд.",
            "PULLBACK_END_UP":   "1H разворачивается вверх на фоне бычьего 4H — коррекция завершается.",
            "PULLBACK_END_DOWN": "1H разворачивается вниз на фоне медвежьего 4H — коррекция завершается.",
            "CONFLICT":          "Таймфреймы противоречат друг другу — ждём определённости.",
            "NO_SIGNAL":         "Нет чёткого тренда на одном или обоих таймфреймах.",
        }
        base = reasons.get(mtf, "")
        # Добавляем инфо об объёме
        vol_1h_ratio = vol_1h.get("vol_ratio", 1.0)
        vol_4h_ratio = vol_4h.get("vol_ratio", 1.0)
        vol_notes = []
        if vol_1h.get("vol_signal") == "HIGH":
            vol_notes.append(f"Объём 1H выше нормы на {int((vol_1h_ratio - 1) * 100)}%")
        if vol_4h.get("vol_signal") == "HIGH":
            vol_notes.append(f"Объём 4H выше нормы на {int((vol_4h_ratio - 1) * 100)}%")
        if vol_notes:
            base += " " + ". ".join(vol_notes) + "."
    async def check_user_ha_alerts(self, figi: str, ticker: str, signal: dict, ha_1h: list, ha_4h: list):
        # Find all user directories
        users_dir = BASE_DIR.parent.parent / "data" / "users"
        users = ["Admin"]
        if users_dir.exists():
            for item in users_dir.iterdir():
                if item.is_dir() and not item.name.startswith("_"):
                    users.append(item.name)
        
        # Deduplicate
        users = list(set(users))
        
        for nick in users:
            db_path = get_user_db(nick)
            if not db_path.exists():
                continue
                
            try:
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                alerts = conn.execute("SELECT * FROM ha_alerts WHERE symbol=? AND active=1", (figi,)).fetchall()
                
                for row in alerts:
                    a = dict(row)
                    alert_id = a["id"]
                    triggered = False
                    trigger_type = ""
                    msg = ""
                    
                    # Last closed candle times (used for deduplication)
                    last_closed_time_1h = ha_1h[-2]["time"] if len(ha_1h) >= 2 else 0
                    last_closed_time_4h = ha_4h[-2]["time"] if len(ha_4h) >= 2 else 0
                    
                    # We will use the maximum of 1H or 4H closed candle times as our unique timestamp
                    current_candle_ts = max(last_closed_time_1h, last_closed_time_4h)
                    
                    if a.get("last_trigger_ts", 0) == current_candle_ts:
                        continue
                        
                    # 1. HA Reversal
                    if a["trigger_reversal"]:
                        tfs = [t.strip().lower() for t in a["reversal_tf"].split(",")]
                        min_c = a["reversal_min_candles"]
                        
                        rev_1h = signal["timeframes"]["1h"]["trend"] in ("REVERSAL_BULL", "REVERSAL_BEAR") and signal["timeframes"]["1h"]["consecutive_candles"] >= min_c
                        rev_4h = signal["timeframes"]["4h"]["trend"] in ("REVERSAL_BULL", "REVERSAL_BEAR") and signal["timeframes"]["4h"]["consecutive_candles"] >= min_c
                        
                        if "both" in tfs or "1h,4h" in tfs or ("1h" in tfs and "4h" in tfs):
                            if "both" in tfs:
                                triggered = rev_1h and rev_4h
                            else:
                                triggered = rev_1h or rev_4h
                        elif "1h" in tfs:
                            triggered = rev_1h
                        elif "4h" in tfs:
                            triggered = rev_4h
                            
                        if triggered:
                            trigger_type = "reversal"
                            dir_str = "вверх" if "BULL" in (signal["timeframes"]["1h"]["trend"] if rev_1h else signal["timeframes"]["4h"]["trend"]) else "вниз"
                            msg = f"HA Разворот {dir_str} по {ticker}"
                            
                    # 2. Price Spike
                    if not triggered and a["trigger_spike"]:
                        tf = a["spike_tf"].strip().lower()
                        pct_thresh = a["spike_pct"]
                        direction = a["spike_direction"].strip().lower()
                        
                        candles = ha_1h if tf == "1h" else ha_4h
                        if len(candles) >= 3:
                            last = candles[-2] # last closed
                            prev = candles[-3]
                            change_pct = abs(last['close'] - prev['close']) / prev['close'] * 100
                            
                            is_dir_match = True
                            if direction == "up":
                                is_dir_match = last['close'] > prev['close']
                            elif direction == "down":
                                is_dir_match = last['close'] < prev['close']
                                
                            if change_pct >= pct_thresh and is_dir_match:
                                triggered = True
                                trigger_type = "spike"
                                dir_str = "вверх" if last['close'] > prev['close'] else "вниз"
                                msg = f"Прострел цены {dir_str} на {change_pct:.2f}% по {ticker}"
                                
                    # 3. Volume Spike
                    if not triggered and a["trigger_volume"]:
                        mult = a["volume_multiplier"]
                        trend_only = a["volume_trend_only"]
                        
                        spike_1h = signal["timeframes"]["1h"]["vol_ratio"] >= mult and (not trend_only or signal["timeframes"]["1h"]["trend"] in ("UPTREND", "DOWNTREND"))
                        spike_4h = signal["timeframes"]["4h"]["vol_ratio"] >= mult and (not trend_only or signal["timeframes"]["4h"]["trend"] in ("UPTREND", "DOWNTREND"))
                        
                        if spike_1h or spike_4h:
                            triggered = True
                            trigger_type = "volume"
                            ratio = signal["timeframes"]["1h"]["vol_ratio"] if spike_1h else signal["timeframes"]["4h"]["vol_ratio"]
                            tf_str = "1H" if spike_1h else "4H"
                            msg = f"Аномальный объём на {tf_str} (в {ratio} раз выше SMA20) по {ticker}"
                            
                    # 4. Combo Trigger
                    if not triggered and a["trigger_combo"]:
                        mult = a["volume_multiplier"]
                        min_c = a["reversal_min_candles"]
                        
                        combo_1h = signal["timeframes"]["1h"]["trend"] in ("REVERSAL_BULL", "REVERSAL_BEAR") and signal["timeframes"]["1h"]["consecutive_candles"] >= min_c and signal["timeframes"]["1h"]["vol_ratio"] >= mult
                        combo_4h = signal["timeframes"]["4h"]["trend"] in ("REVERSAL_BULL", "REVERSAL_BEAR") and signal["timeframes"]["4h"]["consecutive_candles"] >= min_c and signal["timeframes"]["4h"]["vol_ratio"] >= mult
                        
                        if combo_1h or combo_4h:
                            triggered = True
                            trigger_type = "combo"
                            tf_str = "1H" if combo_1h else "4H"
                            dir_str = "вверх" if "BULL" in (signal["timeframes"]["1h"]["trend"] if combo_1h else signal["timeframes"]["4h"]["trend"]) else "вниз"
                            msg = f"Комбо-сигнал на {tf_str}: разворот HA {dir_str} + объём по {ticker}"
                            
                    if triggered:
                        now_ts = int(time.time())
                        # Save triggered status
                        conn.execute("UPDATE ha_alerts SET last_trigger_ts=? WHERE id=?", (current_candle_ts, alert_id))
                        # Log it
                        conn.execute("""
                            INSERT INTO ha_alert_log (alert_id, nick, symbol, trigger_type, message, triggered_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                        """, (alert_id, nick, figi, trigger_type, msg, now_ts))
                        conn.commit()
                        
                        # Send WS event to specific user
                        if self.ws_manager:
                            await self.ws_manager.send(nick, {
                                "type": "ha_alert_triggered",
                                "alert_id": alert_id,
                                "symbol": figi,
                                "ticker": ticker,
                                "trigger_type": trigger_type,
                                "message": msg,
                                "ts": now_ts
                            })
                            
                        # Send native notification
                        if self.notify_fn and a["notify_push"]:
                            price = signal["timeframes"]["1h"].get("last_ha_close", 0)
                            await self.notify_fn(nick, ticker, price, msg)
                            
                conn.close()
            except Exception as e:
                log.warning(f"Error checking HA alerts for user {nick}: {e}")

    # ── Alert Integration ──────────────────────────────────────────────────────
    async def _maybe_send_alert(self, figi: str, ticker: str, signal: dict, prev_mtf: Optional[str]):
        """Отправить нативное уведомление при смене сигнала."""
        if not self.notify_fn:
            return
        if not self.config.get("alerts_enabled"):
            return

        mtf = signal["mtf_signal"]

        # Только значимые сигналы
        if mtf in ("CONFLICT", "NO_SIGNAL"):
            return

        # Если нужны только развороты
        if self.config.get("alert_on_reversal_only") and mtf not in ("PULLBACK_END_UP", "PULLBACK_END_DOWN"):
            return

        reason = signal["alert"].get("reason", "")
        mtf_labels = {
            "CONFIRMED_UP":      "🟢 Бычий тренд подтверждён",
            "CONFIRMED_DOWN":    "🔴 Медвежий тренд подтверждён",
            "PULLBACK_END_UP":   "⚡ Коррекция завершается (вверх)",
            "PULLBACK_END_DOWN": "⚡ Коррекция завершается (вниз)",
        }
        title_prefix = mtf_labels.get(mtf, mtf)
        message = f"{title_prefix} [{ticker}]. {reason}"

        # Уведомляем всех пользователей (итерируем через watchlist)
        try:
            # notify_fn принимает (nick, ticker, price, message)
            price = signal["timeframes"]["1h"].get("last_ha_close", 0)
            # Получаем список пользователей из WS-менеджера
            if self.ws_manager and self.ws_manager.conns:
                for nick in list(self.ws_manager.conns.keys()):
                    await self.notify_fn(nick, ticker, price, message)
        except Exception as e:
            log.warning(f"HA: ошибка при отправке уведомления: {e}")

    # ── Volume Spike Alert ─────────────────────────────────────────────────────

    def _check_vol_spike(self, vol_1h: dict, vol_4h: dict, mtf: str) -> bool:
        """Проверить превышение объёма > 2.0 при активном тренде."""
        active_trend = mtf in ("CONFIRMED_UP", "CONFIRMED_DOWN")
        return (
            active_trend and (
                vol_1h.get("vol_ratio", 0) > 2.0 or
                vol_4h.get("vol_ratio", 0) > 2.0
            )
        )


# Глобальный экземпляр (singleton)
ha_analyzer = HeikinAshiAnalyzer()
