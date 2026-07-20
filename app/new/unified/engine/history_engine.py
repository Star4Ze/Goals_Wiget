from datetime import datetime, timezone, timedelta
from dateutil.relativedelta import relativedelta
from typing import Dict, List, Optional, Callable, Tuple

from tinkoff.invest import Client, OperationType

from engine.figi_cache import get_figi_info
from engine.storage import update_figi_meta


def get_operation_side(op) -> Optional[str]:
    if op.type == OperationType.OPERATION_TYPE_BUY:
        return "buy"
    if op.type == OperationType.OPERATION_TYPE_SELL:
        return "sell"

    op_type = str(op.type).lower()
    if "покупка" in op_type or "buy" in op_type:
        return "buy"
    if "продажа" in op_type or "sell" in op_type:
        return "sell"
    return None


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _history_key(item: Dict) -> tuple:
    return (
        item.get("operation_id"),
        item.get("trade_id"),
        item.get("side"),
        item.get("price"),
        item.get("qty"),
        item.get("timestamp"),
    )


def load_trade_history_from_broker(
    client: Client,
    account_id: str,
    figi: str,
    history_years: int,
    history_from: Optional[datetime],
    ensure_figi_dir: Callable[[str], object],
    load_json: Callable,
    save_json: Callable,
    log: Optional[Callable[[str], None]] = None,
):
    if log is None:
        log_detail = lambda *_args, **_kwargs: None
    else:
        log_detail = log
    log_detail(f"[HISTORY] loading broker history for {figi}")

    try:
        info = get_figi_info(client, figi)
        update_figi_meta(figi, account_id, info)
    except Exception:
        pass

    figi_dir = ensure_figi_dir(figi)
    history_path = figi_dir / "trades_history.json"
    buy_history_path = figi_dir / "buy_history.json"

    history: List[Dict] = load_json(history_path, [])

    last_ts = None
    if history:
        parsed = [_parse_timestamp(h.get("timestamp")) for h in history]
        parsed = [p for p in parsed if p]
        if parsed:
            last_ts = max(parsed)

    from_time = None
    if last_ts:
        from_time = last_ts + timedelta(seconds=1)

    try:
        if from_time:
            log_detail(f"[HISTORY] incremental load from {from_time.isoformat()}")
            operations = client.operations.get_operations(
                account_id=account_id,
                from_=from_time,
                to=datetime.now(timezone.utc),
                figi=figi,
                state=1,
            ).operations
        else:
            start_from = None
            if history_from:
                start_from = history_from
            else:
                start_from = datetime.now(timezone.utc) - relativedelta(years=history_years)
            operations = client.operations.get_operations(
                account_id=account_id,
                from_=start_from,
                to=datetime.now(timezone.utc),
                figi=figi,
                state=1,
            ).operations
    except Exception as e:
        log_detail(f"[HISTORY] broker history load failed: {e}. Using local archive.")
        return {"new_trades": 0, "total_trades": len(history)}

    existing_keys = {_history_key(h) for h in history}
    new_items = []

    for op in operations:
        side = get_operation_side(op)
        if not side:
            continue

        if op.trades:
            for trade in op.trades:
                trade_time = (
                    getattr(trade, "date", None)
                    or getattr(trade, "datetime", None)
                    or op.date
                )
                item = {
                    "side": side,
                    "price": trade.price.units + trade.price.nano / 1e9,
                    "qty": trade.quantity,
                    "timestamp": trade_time.isoformat(),
                    "operation_id": op.id,
                    "trade_id": trade.trade_id,
                }
                key = _history_key(item)
                if key not in existing_keys:
                    new_items.append(item)
                    existing_keys.add(key)
        else:
            if not op.price or not op.quantity:
                continue

            item = {
                "side": side,
                "price": op.price.units + op.price.nano / 1e9,
                "qty": op.quantity,
                "timestamp": op.date.isoformat(),
                "operation_id": op.id,
                "trade_id": None,
            }
            key = _history_key(item)
            if key not in existing_keys:
                new_items.append(item)
                existing_keys.add(key)

    if new_items:
        history.extend(new_items)
        history.sort(key=lambda x: x["timestamp"])
        log_detail(f"[HISTORY] appended {len(new_items)} new trades")
    else:
        log_detail("[HISTORY] no new trades")

    save_json(history_path, history)
    save_json(buy_history_path, [h for h in history if h["side"] == "buy"])
    log_detail(f"[HISTORY] saved {len(history)} trades")

    total_buy = sum(t["qty"] for t in history if t["side"] == "buy")
    total_sell = sum(t["qty"] for t in history if t["side"] == "sell")
    avg_buy_price = (
        sum(t["price"] * t["qty"] for t in history if t["side"] == "buy") / total_buy
        if total_buy > 0 else 0
    )
    avg_sell_price = (
        sum(t["price"] * t["qty"] for t in history if t["side"] == "sell") / total_sell
        if total_sell > 0 else 0
    )

    log_detail(
        f"Summary for {figi}: Bought {total_buy} lots at avg price {avg_buy_price:.2f}, "
        f"Sold {total_sell} lots at avg price {avg_sell_price:.2f}"
    )
    return {"new_trades": len(new_items), "total_trades": len(history)}


def get_last_trade_timestamp(figi: str, ensure_figi_dir, load_json) -> Optional[str]:
    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    if not history:
        return None
    return history[-1].get("timestamp")


def get_last_buy_price(figi: str, ensure_figi_dir, load_json) -> Optional[float]:
    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    for trade in reversed(history):
        if trade.get("side") == "buy":
            return trade.get("price")
    return None


def get_last_trade_price(figi: str, ensure_figi_dir, load_json) -> Optional[float]:
    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    if not history:
        return None
    return history[-1].get("price")


def get_avg_buy_price(figi: str, ensure_figi_dir, load_json) -> Optional[float]:
    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    buys = [t for t in history if t.get("side") == "buy"]
    if not buys:
        return None
    total_qty = sum(t.get("qty", 0) for t in buys)
    if total_qty <= 0:
        return None
    total_value = sum(t.get("price", 0) * t.get("qty", 0) for t in buys)
    return total_value / total_qty


def rebuild_positions_from_history(
    figi: str,
    mode: str,
    ensure_figi_dir,
    load_json,
    log: Optional[Callable[[str], None]] = None,
) -> Tuple[List[Dict], List[Dict]]:
    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    long_positions: List[Dict] = []
    short_positions: List[Dict] = []
    total_close_long = 0
    total_cover_short = 0
    last_closed_long = None
    last_closed_short = None

    def pop_position(items: List[Dict]):
        if not items:
            return None
        if mode == "FIFO":
            return items.pop(0)
        return items.pop()

    for trade in history:
        qty = int(trade.get("qty", 0) or 0)
        if qty <= 0:
            continue

        if trade["side"] == "buy":
            # Покупка сперва закрывает шорты (LIFO/FIFO), остаток идёт в лонг
            while qty > 0 and short_positions:
                closed = pop_position(short_positions)
                if closed:
                    total_cover_short += 1
                    last_closed_short = closed
                qty -= 1
            for _ in range(qty):
                long_positions.append({
                    "price": trade["price"],
                    "qty": 1,
                    "time": trade["timestamp"],
                    "side": "long",
                })
        elif trade["side"] == "sell":
            # Продажа сперва закрывает лонги (LIFO/FIFO), остаток открывает шорт
            while qty > 0 and long_positions:
                closed = pop_position(long_positions)
                if closed:
                    total_close_long += 1
                    last_closed_long = closed
                qty -= 1
            for _ in range(qty):
                short_positions.append({
                    "price": trade["price"],
                    "qty": 1,
                    "time": trade["timestamp"],
                    "side": "short",
                })

    if log:
        if total_close_long:
            log(
                f"[LIFO] close long: {total_close_long} lots "
                f"(last price={last_closed_long.get('price')} "
                f"last time={last_closed_long.get('time')} mode={mode})"
            )
        if total_cover_short:
            log(
                f"[LIFO] cover short: {total_cover_short} lots "
                f"(last price={last_closed_short.get('price')} "
                f"last time={last_closed_short.get('time')} mode={mode})"
            )

    return long_positions, short_positions


def initialize_state(
    client: Client,
    account_id: str,
    figi: str,
    mode: str,
    ensure_figi_dir,
    load_json,
    save_json,
    log: Callable[[str], None],
    get_portfolio_position: Callable,
    get_last_price: Callable,
) -> Dict:
    log(f"[INIT] rebuilding state for {figi}")

    portfolio_pos = get_portfolio_position(client, figi)
    positions, short_positions = rebuild_positions_from_history(
        figi, mode, ensure_figi_dir, load_json, log
    )
    last_price = get_last_price(client, figi)

    if portfolio_pos:
        portfolio_qty = int(portfolio_pos["quantity"] or 0)
        log(f"[PORTFOLIO] qty={portfolio_qty} avg_price={portfolio_pos['avg_price']}")

        if portfolio_qty >= 0:
            positions_qty = sum(p.get("qty", 0) for p in positions)

            if positions_qty < portfolio_qty:
                log("[BOOTSTRAP] history меньше портфеля → добавляем синтетические позиции")
                missing = portfolio_qty - positions_qty
                for _ in range(missing):
                    price = last_price or portfolio_pos["avg_price"]
                    price_source = "last_price" if last_price else "portfolio_avg_price"
                    positions.append({
                        "price": price,
                        "qty": 1,
                        "time": datetime.now(timezone.utc).isoformat(),
                        "synthetic": True,
                        "price_source": price_source,
                        "side": "long",
                    })

            elif positions_qty > portfolio_qty and portfolio_qty >= 0:
                log("[BOOTSTRAP] history больше портфеля → обрезаем лишние позиции")
                extra = positions_qty - portfolio_qty
                for _ in range(extra):
                    if not positions:
                        break
                    if mode == "FIFO":
                        positions.pop(0)
                    else:
                        positions.pop()
        else:
            short_qty = abs(portfolio_qty)
            short_positions_qty = sum(p.get("qty", 0) for p in short_positions)

            if short_positions_qty < short_qty:
                log("[BOOTSTRAP] history меньше портфеля (short) → добавляем синтетические short-позиции")
                missing = short_qty - short_positions_qty
                for _ in range(missing):
                    price = last_price or portfolio_pos["avg_price"]
                    price_source = "last_price" if last_price else "portfolio_avg_price"
                    short_positions.append({
                        "price": price,
                        "qty": 1,
                        "time": datetime.now(timezone.utc).isoformat(),
                        "synthetic": True,
                        "price_source": price_source,
                        "side": "short",
                    })
            elif short_positions_qty > short_qty:
                log("[BOOTSTRAP] history больше портфеля (short) → обрезаем лишние short-позиции")
                extra = short_positions_qty - short_qty
                for _ in range(extra):
                    if not short_positions:
                        break
                    if mode == "FIFO":
                        short_positions.pop(0)
                    else:
                        short_positions.pop()

    state = {
        "positions": positions,
        "short_positions": short_positions,
        "open_orders": {"buy": [], "sell": []},
        "last_sync": datetime.now(timezone.utc).isoformat(),
    }

    save_json(ensure_figi_dir(figi) / "state.json", state)
    return state
