from typing import Optional
from uuid import uuid4

from tinkoff.invest import (
    OrderDirection,
    OrderType,
    StopOrderDirection,
    StopOrderExpirationType,
    StopOrderType,
)

from engine import settings
from engine.logging_utils import get_logger, log, log_detail
from engine.utils import to_quotation


logger = get_logger()
_NOT_TRADABLE = set()


def clear_not_tradable(figi: Optional[str] = None) -> None:
    if figi is None:
        _NOT_TRADABLE.clear()
        return
    _NOT_TRADABLE.discard(figi)


def flag_not_tradable(figi: str) -> None:
    _NOT_TRADABLE.add(figi)


def consume_not_tradable(figi: str) -> bool:
    if figi in _NOT_TRADABLE:
        _NOT_TRADABLE.discard(figi)
        return True
    return False


def estimate_order_value(
    price: float,
    qty: int,
    price_mode: str,
    nominal: Optional[float],
    instrument_type: str,
    lot_size: int,
    nkd_per_lot: float,
    futures_go_per_lot: Optional[float],
) -> float:
    if instrument_type == "futures":
        go = futures_go_per_lot or 0.0
        return go * qty
    if instrument_type == "share":
        lot = lot_size or 1
        return price * qty * lot
    if nominal and price_mode != "rub":
        return price * nominal * qty / 100
    return price * qty + (nkd_per_lot * qty if instrument_type == "bond" else 0.0)


def get_bot_open_orders(client, figi: str):
    orders = client.orders.get_orders(account_id=settings.ACCOUNT_ID).orders
    stop_orders = client.stop_orders.get_stop_orders(account_id=settings.ACCOUNT_ID).stop_orders
    orders = [o for o in orders if o.figi == figi]
    stop_orders = [o for o in stop_orders if o.figi == figi]
    return orders, stop_orders


def cancel_orders(client, orders, stop_orders):
    canceled_orders = 0
    canceled_stops = 0
    for order in orders:
        try:
            client.orders.cancel_order(
                account_id=settings.ACCOUNT_ID,
                order_id=order.order_id,
            )
            canceled_orders += 1
        except Exception as e:
            log(f"[ЗАЯВКА] не удалось отменить {order.order_id}: {e}")
    for order in stop_orders:
        try:
            client.stop_orders.cancel_stop_order(
                account_id=settings.ACCOUNT_ID,
                stop_order_id=order.stop_order_id,
            )
            canceled_stops += 1
        except Exception as e:
            log(f"[СТОП] не удалось отменить {order.stop_order_id}: {e}")
    return canceled_orders, canceled_stops


def cancel_order(client, account_id: str, order_id: str) -> bool:
    try:
        client.orders.cancel_order(account_id=account_id, order_id=order_id)
        return True
    except Exception as e:
        logger.error(f"Ошибка отмены {order_id}: {str(e)}")
        return False


def get_active_orders(client, account_id: str, figi: str):
    try:
        buy_orders = []
        sell_orders = []
        for order in client.orders.get_orders(account_id=account_id).orders:
            if order.figi == figi:
                price = order.initial_order_price.units + order.initial_order_price.nano / 1e9
                if order.direction == OrderDirection.ORDER_DIRECTION_BUY:
                    buy_orders.append({"order_id": order.order_id, "price": price})
                elif order.direction == OrderDirection.ORDER_DIRECTION_SELL:
                    sell_orders.append({"order_id": order.order_id, "price": price})
        return buy_orders, sell_orders
    except Exception as e:
        logger.error(f"Ошибка заявок для {figi}: {str(e)}")
        return [], []


def cancel_all_orders(client, account_id: str, figis):
    try:
        for figi in figis:
            buy_orders, sell_orders = get_active_orders(client, account_id, figi)
            for order in buy_orders:
                cancel_order(client, account_id, order["order_id"])
            for order in sell_orders:
                cancel_order(client, account_id, order["order_id"])
            stop_orders = client.stop_orders.get_stop_orders(account_id=account_id).stop_orders
            stop_orders = [o for o in stop_orders if o.figi == figi]
            for order in stop_orders:
                try:
                    client.stop_orders.cancel_stop_order(
                        account_id=account_id,
                        stop_order_id=order.stop_order_id,
                    )
                except Exception as e:
                    logger.error(f"Ошибка отмены стоп-заявки {order.stop_order_id}: {str(e)}")
            if buy_orders or sell_orders:
                logger.info(f"Все заявки для {figi} отменены")
            else:
                logger.info(f"Нет активных заявок для {figi}")
    except Exception as e:
        logger.error(f"Ошибка при отмене всех заявок: {str(e)}")


def get_order_lots(order) -> int:
    for attr in ("lots_requested", "quantity", "lots"):
        if hasattr(order, attr):
            return getattr(order, attr) or 0
    return 0


def get_order_price_for_api(
    price: float,
    instrument_type: str,
    lot_size: int,
    price_mode: str,
) -> float:
    return price


def place_limit_order(
    client,
    figi: str,
    side: str,
    qty: int,
    price: float,
    instrument_type: str,
    lot_size: int,
    price_mode: str,
):
    direction = (
        OrderDirection.ORDER_DIRECTION_BUY
        if side == "buy"
        else OrderDirection.ORDER_DIRECTION_SELL
    )

    order_price = get_order_price_for_api(price, instrument_type, lot_size, price_mode)

    try:
        return client.orders.post_order(
            figi=figi,
            quantity=qty,
            price=to_quotation(order_price),
            direction=direction,
            account_id=settings.ACCOUNT_ID,
            order_type=OrderType.ORDER_TYPE_LIMIT,
            order_id=str(uuid4()),
        )
    except Exception as e:
        msg = str(e)
        if "30079" in msg or "Instrument is not available for trading" in msg:
            flag_not_tradable(figi)
            log_detail(f"[ORDER-DETAIL] {figi} {side} price={order_price}: {msg}")
            return None
        log(f"[ЗАЯВКА] ошибка постановки {side} {figi}")
        log_detail(f"[ORDER-DETAIL] {figi} {side} price={order_price}: {msg}")
        return None


def place_stop_order(
    client,
    figi: str,
    side: str,
    qty: int,
    price: float,
    instrument_type: str,
    lot_size: int,
    price_mode: str,
    stop_order_type: StopOrderType,
):
    direction = (
        StopOrderDirection.STOP_ORDER_DIRECTION_BUY
        if side == "buy"
        else StopOrderDirection.STOP_ORDER_DIRECTION_SELL
    )

    order_price = get_order_price_for_api(price, instrument_type, lot_size, price_mode)

    try:
        return client.stop_orders.post_stop_order(
            figi=figi,
            quantity=qty,
            price=to_quotation(order_price),
            stop_price=to_quotation(order_price),
            direction=direction,
            account_id=settings.ACCOUNT_ID,
            expiration_type=StopOrderExpirationType.STOP_ORDER_EXPIRATION_TYPE_GOOD_TILL_CANCEL,
            stop_order_type=stop_order_type,
        )
    except Exception as e:
        msg = str(e)
        if "30079" in msg or "Instrument is not available for trading" in msg:
            flag_not_tradable(figi)
            log_detail(f"[STOP-DETAIL] {figi} {side} price={order_price}: {msg}")
            return None
        log(f"[СТОП] ошибка постановки {side} {figi}")
        log_detail(f"[STOP-DETAIL] {figi} {side} price={order_price}: {msg}")
        return None


__all__ = [
    "estimate_order_value",
    "get_bot_open_orders",
    "cancel_orders",
    "cancel_order",
    "get_active_orders",
    "cancel_all_orders",
    "get_order_lots",
    "get_order_price_for_api",
    "place_limit_order",
    "place_stop_order",
    "clear_not_tradable",
    "consume_not_tradable",
]
