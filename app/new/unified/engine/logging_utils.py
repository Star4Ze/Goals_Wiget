import logging
import os
import sys
from pathlib import Path
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from typing import Optional

import pytz

from engine import settings
from engine.figi_cache import FIGI_CACHE

_LOGGER = None
_DETAIL_LOGGER = None


def _msk_time_converter(*args):
    return datetime.now(pytz.timezone("Europe/Moscow")).timetuple()


def _figi_label(figi: str) -> str:
    cfg = settings.TICKERS_CONFIG.get(figi, {})
    name = cfg.get("NAME")
    if not name and figi in FIGI_CACHE:
        name = FIGI_CACHE[figi].get("name")
    if name:
        return f"{name}"
    return figi


def _replace_figi_in_message(msg: str) -> str:
    import re

    def repl(match):
        token = match.group(0)
        return _figi_label(token)

    return re.sub(r"\b[A-Z0-9]{8,12}\b", repl, msg)


def _translate_log_message(msg: str) -> str:
    replacements = {
        "[HISTORY]": "[ИСТОРИЯ]",
        "[INIT]": "[ИНИЦИАЛИЗАЦИЯ]",
        "[PORTFOLIO]": "[ПОРТФЕЛЬ]",
        "[PLAN]": "[ПЛАН]",
        "[STATE]": "[СОСТОЯНИЕ]",
        "[PRICE]": "[ЦЕНА]",
        "[CAPITAL]": "[КАПИТАЛ]",
        "[SCHEDULE]": "[РАСПИСАНИЕ]",
        "[ORDER]": "[ЗАЯВКА]",
        "[STOP]": "[СТОП]",
        "[ERROR]": "[ОШИБКА]",
        "[BOOTSTRAP]": "[ВОССТАНОВЛЕНИЕ]",
        "[LIMITS]": "[ЛИМИТЫ]",
    }
    for src, dst in replacements.items():
        msg = msg.replace(src, dst)
    msg = msg.replace("loading broker history for", "загрузка истории брокера для")
    msg = msg.replace("incremental load from", "инкрементальная загрузка с")
    msg = msg.replace("no new trades", "нет новых сделок")
    msg = msg.replace("saved", "сохранено")
    msg = msg.replace("Summary for", "Сводка для")
    msg = msg.replace("Bought", "Куплено")
    msg = msg.replace("Sold", "Продано")
    msg = msg.replace("rebuilding state for", "пересборка состояния для")
    msg = msg.replace("detected trade/position change for", "обнаружено изменение сделки/позиции для")
    msg = msg.replace("refreshing state", "обновление состояния")
    msg = msg.replace("trading time started", "торговое время началось")
    msg = msg.replace("completed. Results:", "завершено. Результаты:")
    msg = msg.replace("bot paused; waiting for /start", "бот на паузе; ожидание /start")
    msg = msg.replace("canceled", "отменена")
    msg = msg.replace("cancel failed", "не удалось отменить")
    msg = msg.replace("skipped", "пропущена")
    return _replace_figi_in_message(msg)


def _parse_iso_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def setup_logging():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    logging.Formatter.converter = _msk_time_converter

    log_path = Path(settings.LOG_FILE)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_log = Path(log_path.name)
    if not log_path.exists() and legacy_log.exists():
        try:
            os.replace(str(legacy_log), str(log_path))
        except Exception:
            pass

    if settings.DETAILED_LOG_FILE:
        detail_path = Path(settings.DETAILED_LOG_FILE)
        detail_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_detail = Path(detail_path.name)
        if not detail_path.exists() and legacy_detail.exists():
            try:
                os.replace(str(legacy_detail), str(detail_path))
            except Exception:
                pass

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            RotatingFileHandler(
                settings.LOG_FILE, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8"
            ),
            logging.StreamHandler(),
        ],
    )

    logger = logging.getLogger("bot")
    logging.getLogger("tinkoff.invest").setLevel(logging.CRITICAL)
    logging.getLogger("httpx").setLevel(logging.CRITICAL)
    logging.getLogger("urllib3").setLevel(logging.CRITICAL)

    detail_logger = logging.getLogger("detail")
    detail_logger.propagate = False
    if settings.DETAILED_LOG_FILE:
        detail_handler = RotatingFileHandler(
            settings.DETAILED_LOG_FILE, maxBytes=20 * 1024 * 1024, backupCount=5, encoding="utf-8"
        )
        detail_level = getattr(logging, str(settings.DETAILED_LOG_LEVEL).upper(), logging.DEBUG)
        detail_handler.setLevel(detail_level)
        detail_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
        detail_logger.addHandler(detail_handler)
        detail_logger.setLevel(detail_level)

    global _LOGGER, _DETAIL_LOGGER
    _LOGGER = logger
    _DETAIL_LOGGER = detail_logger
    return logger, detail_logger


def log(msg: str):
    account_name = getattr(settings, "LOG_ACCOUNT_NAME", "") or ""
    if account_name:
        msg = f"[ACC:{account_name}] {msg}"
    if _LOGGER is None:
        logging.getLogger("bot").info(_translate_log_message(msg))
        return
    _LOGGER.info(_translate_log_message(msg))


def log_detail(msg: str):
    if _DETAIL_LOGGER is None:
        return
    account_name = getattr(settings, "LOG_ACCOUNT_NAME", "") or ""
    if account_name:
        msg = f"[ACC:{account_name}] {msg}"
    if _DETAIL_LOGGER.handlers:
        _DETAIL_LOGGER.debug(_translate_log_message(msg))


def get_logger():
    return _LOGGER or logging.getLogger("bot")


__all__ = [
    "setup_logging",
    "log",
    "log_detail",
    "get_logger",
    "_parse_iso_dt",
]
