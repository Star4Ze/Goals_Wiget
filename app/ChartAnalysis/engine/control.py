import os
import sys

from engine import settings
from engine.client_factory import get_client
from engine.logging_utils import get_logger, log
from engine.orders import cancel_all_orders
from engine.scheduler import rebalance_portfolio


logger = get_logger()


def make_handlers(state):
    def handle_cancel_orders() -> bool:
        try:
            with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
            return True
        except Exception as e:
            logger.error(f"Ошибка при снятии заявок: {e}")
            return False

    def handle_stop():
        try:
            with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                cancel_all_orders(client, settings.ACCOUNT_ID, settings.TICKERS_CONFIG.keys())
        except Exception as e:
            logger.error(f"Ошибка при снятии заявок: {e}")

        try:
            with get_client(settings.TOKEN_TRADE or settings.TOKEN) as client:
                rebalance_portfolio(client)
        except Exception as e:
            logger.error(f"Ошибка ребаланса: {e}")

        state.bot_paused = True
        log("[СТОП] бот на паузе; ожидание /start")

    def handle_start():
        state.bot_paused = False
        state.needs_init = True
        log("[START] bot resumed")

    def handle_restart():
        try:
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            logger.error(f"Ошибка при перезапуске: {str(e)}")

    def request_rebalance():
        state.rebalance_requested = True

    return handle_cancel_orders, handle_stop, handle_start, handle_restart, request_rebalance


__all__ = ["make_handlers"]
