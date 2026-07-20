from datetime import datetime, time
import pytz
from tinkoff.invest import OrderDirection, OrderType

from engine import settings
from engine.logging_utils import get_logger, log, log_detail
from engine.portfolio import get_blocked_funds_detailed
from engine.portfolio_snapshot import save_portfolio_snapshot
from engine.utils import money_value_to_float


logger = get_logger()
_LAST_SCHEDULE_LOG = {"trading": None, "limit": None}


def _parse_time(value: str, fallback: str = "00:00") -> time:
    val = (value or fallback).strip()
    try:
        return datetime.strptime(val, "%H:%M").time()
    except ValueError:
        return datetime.strptime(val.zfill(5), "%H:%M").time()


def _get_day_times(now: datetime):
    weekday = now.weekday()
    is_weekend = weekday >= 5  # Saturday/Sunday
    if is_weekend:
        start_time_str = getattr(settings, "WEEKEND_TRADING_START_TIME", "02:00")
        end_time_str = getattr(settings, "WEEKEND_TRADING_END_TIME", "23:59")
        limit_start_str = getattr(settings, "WEEKEND_LIMIT_ORDERS_START_TIME", start_time_str)
    else:
        start_time_str = settings.TRADING_START_TIME
        end_time_str = settings.TRADING_END_TIME
        limit_start_str = start_time_str
    return is_weekend, start_time_str, end_time_str, limit_start_str


def _is_time_in_window(current_time: time, start_time: time, end_time: time) -> bool:
    if start_time <= end_time:
        return start_time <= current_time <= end_time
    return current_time >= start_time or current_time <= end_time


def is_trading_time() -> bool:
    """Check if current Moscow time is within configured trading hours."""
    now = datetime.now(pytz.timezone("Europe/Moscow"))
    current_time = now.time()
    is_weekend, start_time_str, end_time_str, _ = _get_day_times(now)
    start_time = _parse_time(start_time_str)
    end_time = _parse_time(end_time_str)
    is_trading = _is_time_in_window(current_time, start_time, end_time)
    day_type = "weekend" if is_weekend else "weekday"
    minute_key = now.strftime("%Y-%m-%d %H:%M")
    if _LAST_SCHEDULE_LOG.get("trading") != minute_key:
        _LAST_SCHEDULE_LOG["trading"] = minute_key
        log_detail(
            f"[SCHEDULE] {day_type}, now {current_time.strftime('%H:%M')}, "
            f"window {start_time_str}-{end_time_str}, trading={is_trading}"
        )
    return is_trading


def is_limit_orders_time() -> bool:
    """Check if current Moscow time is within the limit-order window."""
    now = datetime.now(pytz.timezone("Europe/Moscow"))
    current_time = now.time()
    is_weekend, start_time_str, end_time_str, limit_start_str = _get_day_times(now)
    start_time = _parse_time(start_time_str)
    end_time = _parse_time(end_time_str)
    limit_start = _parse_time(limit_start_str)
    in_trading_window = _is_time_in_window(current_time, start_time, end_time)
    in_limit_window = _is_time_in_window(current_time, limit_start, end_time)
    day_type = "weekend" if is_weekend else "weekday"
    minute_key = now.strftime("%Y-%m-%d %H:%M")
    if _LAST_SCHEDULE_LOG.get("limit") != minute_key:
        _LAST_SCHEDULE_LOG["limit"] = minute_key
        log_detail(
            f"[SCHEDULE] {day_type}, now {current_time.strftime('%H:%M')}, "
            f"limits {limit_start_str}-{end_time_str}, orders={in_trading_window and in_limit_window}"
        )
    return in_trading_window and in_limit_window


def is_rebalance_cutoff_time() -> bool:
    """True when REBALANCE_TIME matches the configured trading end time for today."""
    if not settings.REBALANCE_TIME:
        return False
    now = datetime.now(pytz.timezone("Europe/Moscow"))
    _, _, end_time_str, _ = _get_day_times(now)
    try:
        reb_time = _parse_time(settings.REBALANCE_TIME)
        end_time = _parse_time(end_time_str)
        return reb_time == end_time
    except Exception:
        return False


def should_rebalance_now(last_rebalance_date) -> bool:
    if not settings.REBALANCE_TIME:
        return False
    now = datetime.now(pytz.timezone("Europe/Moscow"))
    try:
        target_time = datetime.strptime(settings.REBALANCE_TIME, "%H:%M").time()
    except ValueError:
        target_time = datetime.strptime(settings.REBALANCE_TIME.zfill(5), "%H:%M").time()
    if now.time() < target_time:
        return False
    if last_rebalance_date == now.date():
        return False
    return True


def rebalance_portfolio(client):
    if not settings.TMON_FIGI:
        logger.info("TMON_FIGI is not set — skipping rebalance")
        return
    if not getattr(settings, "TMON_REBALANCE_ENABLED", True):
        logger.info("TMON rebalance disabled for this portfolio — skipping")
        return

    portfolio_value = None
    try:
        market_data = client.market_data
        orders = client.orders
        operations = client.operations

        portfolio = operations.get_portfolio(account_id=settings.ACCOUNT_ID)
        portfolio_value = money_value_to_float(getattr(portfolio, "total_amount_portfolio", None))
        total_balance = 0
        for money in portfolio.positions:
            if money.instrument_type == "currency" and money.figi == "RUB000UTSTOM":
                total_balance = money.quantity.units + money.quantity.nano / 1e9
                break

        blocked_info = get_blocked_funds_detailed(client, settings.ACCOUNT_ID)
        total_blocked = blocked_info["total_blocked"]
        total_go_futures = blocked_info["total_go_futures"]
        blocked_guarantee = blocked_info["blocked_guarantee"]
        other_blocked = blocked_info["other_blocked"]

        logger.info("=" * 70)
        logger.info("PORTFOLIO INFO")
        logger.info(f"Total cash balance: {total_balance:.2f} RUB")
        logger.info(
            "Blocked funds (positions + withdraw): "
            f"{blocked_info['total_blocked_from_positions'] + blocked_info['total_blocked_from_withdraw']:.2f} RUB"
        )
        if blocked_guarantee > 0:
            logger.info(f"Blocked guarantee (withdraw): {blocked_guarantee:.2f} RUB")

        if blocked_info["futures_details"]:
            logger.info("-" * 70)
            logger.info("ФЬЮЧЕРСЫ — ГАРАНТИЙНОЕ ОБЕСПЕЧЕНИЕ (ГО)")
            config_go_total = 0.0
            for fut in blocked_info["futures_details"]:
                config_go = None
                cfg = settings.TICKERS_CONFIG.get(fut["figi"], {})
                go_buy = cfg.get("GO_BUY_QUAL")
                go_sell = cfg.get("GO_SELL_QUAL")
                if go_buy is not None or go_sell is not None:
                    config_go = max([v for v in (go_buy, go_sell) if v is not None])
                    config_go_total += abs(fut["balance"]) * config_go
                per_lot_text = f"{config_go:>9,.2f} руб." if config_go is not None else "нет"
                total_text = "нет"
                if config_go is not None:
                    total_text = f"{abs(fut['balance']) * config_go:,.2f}"
                logger.info(
                    f"  {fut['figi']:>20} | {abs(fut['balance']):>6} шт | {fut['direction']:<5} | "
                    f"ГО_КОНФ/лот: {per_lot_text} | Суммарно: {total_text}"
                )
            logger.info("-" * 70)
            logger.info(f"ИТОГО: ГО по фьючерсам (по конфигу): {config_go_total:,.2f} руб.")
        else:
            logger.info("-" * 70)
            logger.info("ФЬЮЧЕРСЫ — ГАРАНТИЙНОЕ ОБЕСПЕЧЕНИЕ (ГО)")
            logger.info("→ Открытых фьючерсных позиций нет")
            logger.info("-" * 70)

        logger.info(f"Остальные блокировки (заявки/валюты/прочее): {other_blocked:,.2f} руб.")
        logger.info(f"ИТОГО заблокировано: {total_blocked:,.2f} руб.")
        logger.info("=" * 70)

        free_cash = total_balance - total_blocked
        logger.info(f"Свободные средства (баланс - блокировки): {free_cash:.2f} руб.")

        target_purchase_amount = 0.0
        action_label = "none"
        if free_cash < settings.MAX_MARGIN:
            target_purchase_amount = free_cash - settings.MAX_MARGIN
            action_label = "sell"
        elif free_cash > settings.MIN_CASH_RESERVE:
            target_purchase_amount = free_cash - settings.MIN_CASH_RESERVE
            action_label = "buy"
        logger.info(
            f"Целевой остаток: MAX_MARGIN={settings.MAX_MARGIN:.2f}, "
            f"MIN_CASH_RESERVE={settings.MIN_CASH_RESERVE:.2f}, "
            f"действие={action_label}"
        )

        last_prices = market_data.get_last_prices(figi=[settings.TMON_FIGI])
        last_price = None
        for price in last_prices.last_prices:
            if price.figi == settings.TMON_FIGI:
                last_price = price.price.units + price.price.nano / 1e9
                break
        if last_price is None:
            logger.error("Не удалось получить последнюю цену TMON")
            return

        logger.info(f"Текущая рыночная цена TMON: {last_price:.2f} руб.")

        orderbook = market_data.get_order_book(figi=settings.TMON_FIGI, depth=1)
        if len(orderbook.asks) == 0 or len(orderbook.bids) == 0:
            logger.error("Стакан пуст, цены недоступны")
            return

        best_ask = orderbook.asks[0].price.units + orderbook.asks[0].price.nano / 1e9
        best_bid = orderbook.bids[0].price.units + orderbook.bids[0].price.nano / 1e9
        logger.info(f"Лучшая цена покупки (ask): {best_ask:.2f} руб.")
        logger.info(f"Лучшая цена продажи (bid): {best_bid:.2f} руб.")

        if action_label == "buy" and target_purchase_amount > 0:
            lots_to_buy = int(target_purchase_amount / best_ask)
            if lots_to_buy < 1:
                logger.info(f"Сумма мала для покупки (<{best_ask:.2f} руб.), пропускаем")
                return

            logger.info(
                f"Свободных средств больше MIN_CASH_RESERVE, покупаем {lots_to_buy} лотов TMON, "
                f"чтобы cash ~ {settings.MIN_CASH_RESERVE:.2f} руб. (после блокировок)"
            )
            response = orders.post_order(
                figi=settings.TMON_FIGI,
                quantity=lots_to_buy,
                direction=OrderDirection.ORDER_DIRECTION_BUY,
                account_id=settings.ACCOUNT_ID,
                order_type=OrderType.ORDER_TYPE_MARKET,
            )
            logger.info(f"✓ Рыночная заявка на покупку {lots_to_buy} лотов размещена! ID: {response.order_id}")

        elif action_label == "sell" and target_purchase_amount < 0:
            amount_to_sell = abs(target_purchase_amount)
            lots_to_sell = int(amount_to_sell / best_bid + 0.99999)
            if lots_to_sell < 1:
                logger.info(f"Сумма мала для продажи (<{best_bid:.2f} руб.), пропускаем")
                return

            current_lots = 0
            for position in portfolio.positions:
                if position.figi == settings.TMON_FIGI:
                    current_lots = position.quantity.units
                    break
            if current_lots < lots_to_sell:
                logger.error(f"Недостаточно лотов TMON для продажи: нужно {lots_to_sell}, есть {current_lots}")
                return

            logger.info(
                f"Свободных средств меньше MAX_MARGIN, продаём {lots_to_sell} лотов TMON, "
                f"чтобы cash ~ {settings.MAX_MARGIN:.2f} руб. (после блокировок)"
            )
            response = orders.post_order(
                figi=settings.TMON_FIGI,
                quantity=lots_to_sell,
                direction=OrderDirection.ORDER_DIRECTION_SELL,
                account_id=settings.ACCOUNT_ID,
                order_type=OrderType.ORDER_TYPE_MARKET,
            )
            logger.info(f"✓ Рыночная заявка на продажу {lots_to_sell} лотов размещена! ID: {response.order_id}")

        else:
            logger.info("Баланс в допустимом диапазоне, действий не требуется")

    except Exception as e:
        logger.error(f"Ошибка при ребалансировке: {e}", exc_info=True)
    finally:
        if portfolio_value is not None:
            save_portfolio_snapshot(settings.ACCOUNT_ID, portfolio_value)


__all__ = [
    "is_trading_time",
    "is_limit_orders_time",
    "is_rebalance_cutoff_time",
    "should_rebalance_now",
    "rebalance_portfolio",
]
