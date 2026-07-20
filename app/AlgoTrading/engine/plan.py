from typing import Dict, List, Optional

from engine import settings
from engine.price_utils import normalize_price, pct_to_ratio, round_price_to_step


def get_min_position_price(positions: List[Dict]) -> Optional[float]:
    prices = [p.get("price") for p in positions if p.get("price")]
    return min(prices) if prices else None


def build_order_plan(
    figi_cfg: Dict,
    base_price_buy: float,
    base_price_sell: float,
    position_qty: int,
    open_sell_qty: int,
    limit_down: Optional[float],
    limit_up: Optional[float],
    debug: Optional[List[str]] = None,
):
    grid_min = figi_cfg.get("grid_min")
    grid_max = figi_cfg.get("grid_max")
    price_step = figi_cfg.get("price_step", figi_cfg.get("step", 0))

    buy_orders = figi_cfg.get("buy_orders", 0)
    sell_orders = figi_cfg.get("sell_orders", 0)
    order_qty = figi_cfg.get("order_qty", figi_cfg.get("qty", 1))

    buy_offset_pct = figi_cfg.get("buy_offset_pct", 0)
    sell_offset_pct = figi_cfg.get("sell_offset_pct", 0)

    max_margin = figi_cfg.get("max_margin")
    nominal = figi_cfg.get("nominal")
    price_mode = figi_cfg.get("price_mode", "percent")

    prices_buy = []
    prices_sell = []

    position_value = position_qty * base_price_sell
    used_margin = position_value
    if debug is not None:
        debug.append(
            f"base_buy={base_price_buy:.6f} base_sell={base_price_sell:.6f} "
            f"position_qty={position_qty} open_sell_qty={open_sell_qty} "
            f"grid_min={grid_min} grid_max={grid_max} step={price_step} "
            f"buy_orders={buy_orders} sell_orders={sell_orders} order_qty={order_qty}"
        )

    for i in range(buy_orders):
        offset = buy_offset_pct * (i + 1) / 100
        raw_price = base_price_buy * (1 - offset)
        price = round_price_to_step(raw_price, price_step, "buy")

        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below limit_down={limit_down}")
            continue
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above limit_up={limit_up}")
            continue
        if grid_min is not None and price < grid_min:
            if debug is not None:
                debug.append(f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below grid_min={grid_min}")
            continue
        if grid_max is not None and price > grid_max:
            if debug is not None:
                debug.append(f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above grid_max={grid_max}")
            continue

        if nominal and price_mode != "rub":
            order_value = price * nominal * order_qty / 100
        else:
            order_value = price * order_qty
        if max_margin is not None and used_margin + order_value > max_margin:
            if debug is not None:
                debug.append(
                    f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} "
                    f"skip: max_margin {max_margin} used {used_margin:.2f} + order {order_value:.2f}"
                )
            break

        used_margin += order_value
        prices_buy.append(price)
        if debug is not None:
            debug.append(f"buy#{i+1} raw={raw_price:.6f} price={price:.6f} add")

    available_sell_qty = max(position_qty - open_sell_qty, 0)
    max_sell_orders = min(sell_orders, available_sell_qty // order_qty)

    for i in range(max_sell_orders):
        offset = sell_offset_pct * (i + 1) / 100
        raw_price = base_price_sell * (1 + offset)
        price = round_price_to_step(raw_price, price_step, "sell")

        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below limit_down={limit_down}")
            continue
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above limit_up={limit_up}")
            continue
        if grid_min is not None and price < grid_min:
            if debug is not None:
                debug.append(f"sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below grid_min={grid_min}")
            continue
        if grid_max is not None and price > grid_max:
            if debug is not None:
                debug.append(f"sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above grid_max={grid_max}")
            continue

        prices_sell.append(price)
        if debug is not None:
            debug.append(f"sell#{i+1} raw={raw_price:.6f} price={price:.6f} add")

    return prices_buy, prices_sell, order_qty


def build_order_plan_legacy(
    figi_cfg: Dict,
    last_price: float,
    avg_price: Optional[float],
    last_trade_price: Optional[float],
    last_buy_price: Optional[float],
    positions: List[Dict],
    position_qty: int,
    limit_down: Optional[float],
    limit_up: Optional[float],
    min_increment: float,
    debug: Optional[List[str]] = None,
):
    buy_pct = figi_cfg.get("BUY_LIMIT_PRICE_PERCENT", 0.0)
    sell_pct = figi_cfg.get("SELL_LIMIT_PRICE_PERCENT", 0.0)
    buy_lots_per_order = figi_cfg.get("BUY_LOTS_PER_ORDER", 1)
    sell_lots_per_order = figi_cfg.get("SELL_LOTS_PER_ORDER", 1)
    max_lots = figi_cfg.get("MAX_LOTS", 0)
    min_lots_to_hold = figi_cfg.get("MIN_LOTS_TO_HOLD", 0)
    max_buy_price = figi_cfg.get("MAX_BUY_PRICE", float("inf"))
    max_buy_orders = figi_cfg.get("MAX_BUY_ORDERS", 0)
    max_sell_orders = figi_cfg.get("MAX_SELL_ORDERS", 0)
    buy_base_mode = figi_cfg.get("buy_base_mode", "min_buy")
    sell_base_mode = figi_cfg.get("sell_base_mode", "per_position")
    trailing_mode = figi_cfg.get("TRAILING_GRID_MODE", figi_cfg.get("trailing_grid_mode", settings.TRAILING_GRID_MODE))
    min_profit_pct = figi_cfg.get("MIN_PROFIT_STEP_PCT", settings.MIN_PROFIT_STEP_PCT)

    buy_pct = pct_to_ratio(buy_pct)
    sell_pct = pct_to_ratio(sell_pct)
    min_profit_ratio = pct_to_ratio(min_profit_pct)

    base_buy = last_price
    if buy_base_mode == "avg" and avg_price:
        base_buy = avg_price
    elif buy_base_mode == "last_buy" and last_buy_price:
        base_buy = last_buy_price
    elif buy_base_mode == "last_trade" and last_trade_price:
        base_buy = last_trade_price
    elif buy_base_mode == "last":
        base_buy = last_price
    elif buy_base_mode == "min_buy":
        min_pos = get_min_position_price(positions)
        if min_pos:
            base_buy = min_pos

    base_sell = last_price
    if sell_base_mode == "avg" and avg_price:
        base_sell = avg_price
    elif sell_base_mode == "max_last_avg" and avg_price:
        base_sell = max(last_price, avg_price)
    elif sell_base_mode == "last_trade" and last_trade_price:
        base_sell = last_trade_price
    elif sell_base_mode == "last":
        base_sell = last_price
    elif sell_base_mode == "per_position":
        positions_sorted = sorted(positions, key=lambda p: p.get("time") or "")
        if settings.MODE == "LIFO":
            positions_sorted = list(reversed(positions_sorted))
        for pos in positions_sorted:
            if pos.get("price"):
                base_sell = pos["price"]
                break

    prices_buy = []
    prices_sell = []

    remaining_lots = max(max_lots - position_qty, 0) if max_lots else 0
    if debug is not None:
        debug.append(
            f"base_buy={base_buy:.6f} base_sell={base_sell:.6f} last={last_price:.6f} "
            f"avg={avg_price} last_buy={last_buy_price} last_trade={last_trade_price} "
            f"buy_mode={buy_base_mode} sell_mode={sell_base_mode} "
            f"buy_pct={buy_pct} sell_pct={sell_pct} min_inc={min_increment} "
            f"max_lots={max_lots} pos_qty={position_qty} remaining_lots={remaining_lots}"
        )

    def can_place_buy(price: float) -> bool:
        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"buy skip: {price:.6f} < limit_down {limit_down}")
            return False
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"buy skip: {price:.6f} > limit_up {limit_up}")
            return False
        if price > max_buy_price:
            if debug is not None:
                debug.append(f"buy skip: {price:.6f} > max_buy_price {max_buy_price}")
            return False
        return True

    def can_place_sell(price: float, base_ref: Optional[float]) -> bool:
        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"sell skip: {price:.6f} < limit_down {limit_down}")
            return False
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"sell skip: {price:.6f} > limit_up {limit_up}")
            return False
        if min_profit_ratio and base_ref:
            if price < base_ref * (1 + min_profit_ratio):
                if debug is not None:
                    debug.append(
                        f"sell skip: {price:.6f} < base_ref {base_ref:.6f} + min_profit {min_profit_ratio}"
                    )
                return False
        return True

    def add_buy_order(price: float) -> bool:
        nonlocal remaining_lots
        if remaining_lots < buy_lots_per_order:
            return False
        price = normalize_price(price, min_increment)
        if not can_place_buy(price):
            return False
        prices_buy.append(price)
        remaining_lots -= buy_lots_per_order
        if debug is not None:
            debug.append(f"buy add: {price:.6f} remaining_lots={remaining_lots}")
        return True

    def add_sell_order(price: float, base_ref: Optional[float]) -> bool:
        nonlocal lots_available_for_sale
        if lots_available_for_sale < sell_lots_per_order:
            return False
        price = normalize_price(price, min_increment)
        if not can_place_sell(price, base_ref):
            return False
        prices_sell.append(price)
        lots_available_for_sale -= sell_lots_per_order
        if debug is not None:
            debug.append(f"sell add: {price:.6f} remaining_sell_lots={lots_available_for_sale}")
        return True

    if max_buy_orders > 0:
        first_buy_price = base_buy * (1 - buy_pct) if buy_pct else base_buy
        if trailing_mode and last_price and first_buy_price and last_price < first_buy_price:
            add_buy_order(first_buy_price)
            remaining_orders = max_buy_orders - len(prices_buy)
            market_base = last_price
            for i in range(1, remaining_orders + 1):
                if remaining_lots < buy_lots_per_order:
                    break
                price = market_base * ((1 - buy_pct) ** i) if buy_pct else market_base
                add_buy_order(price)
        else:
            for i in range(1, max_buy_orders + 1):
                if remaining_lots < buy_lots_per_order:
                    break
                price = base_buy * ((1 - buy_pct) ** i) if buy_pct else base_buy
                add_buy_order(price)

    lots_available_for_sale = max(position_qty - min_lots_to_hold, 0)
    max_sell_orders_limited = min(
        max_sell_orders,
        (lots_available_for_sale // sell_lots_per_order) if sell_lots_per_order else 0,
    )
    if max_sell_orders_limited > 0:
        if sell_base_mode == "per_position":
            positions_sorted = sorted(positions, key=lambda p: p.get("time") or "")
            if settings.MODE == "LIFO":
                positions_sorted = list(reversed(positions_sorted))
            for i in range(max_sell_orders_limited):
                if lots_available_for_sale < sell_lots_per_order:
                    break
                base_index = i * sell_lots_per_order
                if base_index >= len(positions_sorted):
                    break
                base_ref = positions_sorted[base_index].get("price") or base_sell
                price = base_ref * (1 + sell_pct) if sell_pct else base_ref
                add_sell_order(price, base_ref)
        else:
            first_sell_price = base_sell * (1 + sell_pct) if sell_pct else base_sell
            if trailing_mode and last_price and first_sell_price and last_price > first_sell_price:
                add_sell_order(first_sell_price, base_sell)
                remaining_orders = max_sell_orders_limited - len(prices_sell)
                for i in range(1, remaining_orders + 1):
                    if lots_available_for_sale < sell_lots_per_order:
                        break
                    price = last_price * ((1 + sell_pct) ** i) if sell_pct else last_price
                    add_sell_order(price, base_sell)
            else:
                for i in range(1, max_sell_orders_limited + 1):
                    if lots_available_for_sale < sell_lots_per_order:
                        break
                    price = base_sell * ((1 + sell_pct) ** i) if sell_pct else base_sell
                    add_sell_order(price, base_sell)

    return prices_buy, prices_sell, buy_lots_per_order, sell_lots_per_order, base_buy, base_sell


def build_short_plan(
    figi_cfg: Dict,
    base_price_buy: float,
    base_price_sell: float,
    short_qty: int,
    limit_down: Optional[float],
    limit_up: Optional[float],
    debug: Optional[List[str]] = None,
):
    grid_min = figi_cfg.get("grid_min")
    grid_max = figi_cfg.get("grid_max")
    price_step = figi_cfg.get("price_step", figi_cfg.get("step", 0))

    buy_orders = figi_cfg.get("buy_orders", 0)
    sell_orders = figi_cfg.get("sell_orders", 0)
    order_qty = figi_cfg.get("order_qty", figi_cfg.get("qty", 1))

    buy_offset_pct = figi_cfg.get("buy_offset_pct", 0)
    sell_offset_pct = figi_cfg.get("sell_offset_pct", 0)

    prices_buy = []
    prices_sell = []

    if debug is not None:
        debug.append(
            f"[SHORT] base_buy={base_price_buy:.6f} base_sell={base_price_sell:.6f} "
            f"short_qty={short_qty} buy_orders={buy_orders} sell_orders={sell_orders} "
            f"grid_min={grid_min} grid_max={grid_max} step={price_step}"
        )

    for i in range(sell_orders):
        offset = sell_offset_pct * (i + 1) / 100
        raw_price = base_price_sell * (1 + offset)
        price = round_price_to_step(raw_price, price_step, "sell")

        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"short sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below limit_down={limit_down}")
            continue
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"short sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above limit_up={limit_up}")
            continue
        if grid_min is not None and price < grid_min:
            if debug is not None:
                debug.append(f"short sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below grid_min={grid_min}")
            continue
        if grid_max is not None and price > grid_max:
            if debug is not None:
                debug.append(f"short sell#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above grid_max={grid_max}")
            continue

        prices_sell.append(price)
        if debug is not None:
            debug.append(f"short sell#{i+1} raw={raw_price:.6f} price={price:.6f} add")

    max_cover_orders = min(buy_orders, short_qty // order_qty) if order_qty else 0
    for i in range(max_cover_orders):
        offset = buy_offset_pct * (i + 1) / 100
        raw_price = base_price_buy * (1 - offset)
        price = round_price_to_step(raw_price, price_step, "buy")

        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"short buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below limit_down={limit_down}")
            continue
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"short buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above limit_up={limit_up}")
            continue
        if grid_min is not None and price < grid_min:
            if debug is not None:
                debug.append(f"short buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: below grid_min={grid_min}")
            continue
        if grid_max is not None and price > grid_max:
            if debug is not None:
                debug.append(f"short buy#{i+1} raw={raw_price:.6f} price={price:.6f} skip: above grid_max={grid_max}")
            continue

        prices_buy.append(price)
        if debug is not None:
            debug.append(f"short buy#{i+1} raw={raw_price:.6f} price={price:.6f} add")

    return prices_buy, prices_sell, order_qty


def build_short_plan_legacy(
    figi_cfg: Dict,
    last_price: float,
    avg_price: Optional[float],
    last_trade_price: Optional[float],
    last_buy_price: Optional[float],
    positions: List[Dict],
    short_qty: int,
    limit_down: Optional[float],
    limit_up: Optional[float],
    min_increment: float,
    debug: Optional[List[str]] = None,
):
    buy_pct = figi_cfg.get("BUY_LIMIT_PRICE_PERCENT", 0.0)
    sell_pct = figi_cfg.get("SELL_LIMIT_PRICE_PERCENT", 0.0)
    buy_lots_per_order = figi_cfg.get("BUY_LOTS_PER_ORDER", 1)
    sell_lots_per_order = figi_cfg.get("SELL_LOTS_PER_ORDER", 1)
    max_lots = figi_cfg.get("MAX_LOTS", 0)
    min_lots_to_hold = figi_cfg.get("MIN_LOTS_TO_HOLD", 0)
    max_buy_price = figi_cfg.get("MAX_BUY_PRICE", float("inf"))
    max_buy_orders = figi_cfg.get("MAX_BUY_ORDERS", 0)
    max_sell_orders = figi_cfg.get("MAX_SELL_ORDERS", 0)
    buy_base_mode = figi_cfg.get("buy_base_mode", "min_buy")
    sell_base_mode = figi_cfg.get("sell_base_mode", "per_position")
    trailing_mode = figi_cfg.get("TRAILING_GRID_MODE", figi_cfg.get("trailing_grid_mode", settings.TRAILING_GRID_MODE))
    min_profit_pct = figi_cfg.get("MIN_PROFIT_STEP_PCT", settings.MIN_PROFIT_STEP_PCT)

    buy_pct = pct_to_ratio(buy_pct)
    sell_pct = pct_to_ratio(sell_pct)
    min_profit_ratio = pct_to_ratio(min_profit_pct)

    base_buy = last_price
    if buy_base_mode == "avg" and avg_price:
        base_buy = avg_price
    elif buy_base_mode == "last_buy" and last_buy_price:
        base_buy = last_buy_price
    elif buy_base_mode == "last_trade" and last_trade_price:
        base_buy = last_trade_price
    elif buy_base_mode == "last":
        base_buy = last_price
    elif buy_base_mode == "min_buy":
        min_pos = get_min_position_price(positions)
        if min_pos:
            base_buy = min_pos

    base_sell = last_price
    if sell_base_mode == "avg" and avg_price:
        base_sell = avg_price
    elif sell_base_mode == "max_last_avg" and avg_price:
        base_sell = max(last_price, avg_price)
    elif sell_base_mode == "last_trade" and last_trade_price:
        base_sell = last_trade_price
    elif sell_base_mode == "last":
        base_sell = last_price
    elif sell_base_mode == "per_position":
        positions_sorted = sorted(positions, key=lambda p: p.get("time") or "")
        if settings.MODE == "LIFO":
            positions_sorted = list(reversed(positions_sorted))
        for pos in positions_sorted:
            if pos.get("price"):
                base_sell = pos["price"]
                break

    prices_buy = []
    prices_sell = []

    remaining_lots = max(max_lots - short_qty, 0) if max_lots else 0
    if debug is not None:
        debug.append(
            f"[SHORT] base_buy={base_buy:.6f} base_sell={base_sell:.6f} last={last_price:.6f} "
            f"avg={avg_price} last_buy={last_buy_price} last_trade={last_trade_price} "
            f"buy_mode={buy_base_mode} sell_mode={sell_base_mode} "
            f"buy_pct={buy_pct} sell_pct={sell_pct} min_inc={min_increment} "
            f"max_lots={max_lots} short_qty={short_qty} remaining_lots={remaining_lots}"
        )

    def can_place_sell(price: float) -> bool:
        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"short sell skip: {price:.6f} < limit_down {limit_down}")
            return False
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"short sell skip: {price:.6f} > limit_up {limit_up}")
            return False
        if price > max_buy_price:
            if debug is not None:
                debug.append(f"short sell skip: {price:.6f} > max_buy_price {max_buy_price}")
            return False
        return True

    def can_place_cover_buy(price: float, base_ref: Optional[float]) -> bool:
        if limit_down is not None and price < limit_down:
            if debug is not None:
                debug.append(f"short buy skip: {price:.6f} < limit_down {limit_down}")
            return False
        if limit_up is not None and price > limit_up:
            if debug is not None:
                debug.append(f"short buy skip: {price:.6f} > limit_up {limit_up}")
            return False
        if price > max_buy_price:
            if debug is not None:
                debug.append(f"short buy skip: {price:.6f} > max_buy_price {max_buy_price}")
            return False
        if min_profit_ratio and base_ref:
            if price > base_ref * (1 - min_profit_ratio):
                if debug is not None:
                    debug.append(
                        f"short buy skip: {price:.6f} > base_ref {base_ref:.6f} - min_profit {min_profit_ratio}"
                    )
                return False
        return True

    def add_sell_order(price: float) -> bool:
        nonlocal remaining_lots
        if remaining_lots < sell_lots_per_order:
            return False
        price = normalize_price(price, min_increment)
        if not can_place_sell(price):
            return False
        prices_sell.append(price)
        remaining_lots -= sell_lots_per_order
        if debug is not None:
            debug.append(f"short sell add: {price:.6f} remaining_lots={remaining_lots}")
        return True

    def add_cover_buy_order(price: float, base_ref: Optional[float]) -> bool:
        nonlocal lots_available_for_cover
        if lots_available_for_cover < buy_lots_per_order:
            return False
        price = normalize_price(price, min_increment)
        if not can_place_cover_buy(price, base_ref):
            return False
        prices_buy.append(price)
        lots_available_for_cover -= buy_lots_per_order
        if debug is not None:
            debug.append(f"short buy add: {price:.6f} remaining_cover_lots={lots_available_for_cover}")
        return True

    if max_sell_orders > 0:
        first_sell_price = base_sell * (1 + sell_pct) if sell_pct else base_sell
        if trailing_mode and last_price and first_sell_price and last_price > first_sell_price:
            add_sell_order(first_sell_price)
            remaining_orders = max_sell_orders - len(prices_sell)
            for i in range(1, remaining_orders + 1):
                if remaining_lots < sell_lots_per_order:
                    break
                price = last_price * ((1 + sell_pct) ** i) if sell_pct else last_price
                add_sell_order(price)
        else:
            for i in range(1, max_sell_orders + 1):
                if remaining_lots < sell_lots_per_order:
                    break
                price = base_sell * ((1 + sell_pct) ** i) if sell_pct else base_sell
                add_sell_order(price)

    lots_available_for_cover = max(short_qty - min_lots_to_hold, 0)
    max_cover_orders_limited = min(
        max_buy_orders,
        (lots_available_for_cover // buy_lots_per_order) if buy_lots_per_order else 0,
    )
    if max_cover_orders_limited > 0:
        if sell_base_mode == "per_position":
            positions_sorted = sorted(positions, key=lambda p: p.get("time") or "")
            if settings.MODE == "LIFO":
                positions_sorted = list(reversed(positions_sorted))
            for i in range(max_cover_orders_limited):
                if lots_available_for_cover < buy_lots_per_order:
                    break
                base_index = i * buy_lots_per_order
                if base_index >= len(positions_sorted):
                    break
                base_ref = positions_sorted[base_index].get("price") or base_buy
                price = base_ref * (1 - buy_pct) if buy_pct else base_ref
                add_cover_buy_order(price, base_ref)
        else:
            first_buy_price = base_buy * (1 - buy_pct) if buy_pct else base_buy
            if trailing_mode and last_price and first_buy_price and last_price < first_buy_price:
                add_cover_buy_order(first_buy_price, base_sell)
                remaining_orders = max_cover_orders_limited - len(prices_buy)
                market_base = last_price
                for i in range(1, remaining_orders + 1):
                    if lots_available_for_cover < buy_lots_per_order:
                        break
                    price = market_base * ((1 - buy_pct) ** i) if buy_pct else market_base
                    add_cover_buy_order(price, base_sell)
            else:
                for i in range(1, max_cover_orders_limited + 1):
                    if lots_available_for_cover < buy_lots_per_order:
                        break
                    price = base_buy * ((1 - buy_pct) ** i) if buy_pct else base_buy
                    add_cover_buy_order(price, base_sell)

    return prices_buy, prices_sell, buy_lots_per_order, sell_lots_per_order, base_buy, base_sell


__all__ = [
    "get_min_position_price",
    "build_order_plan",
    "build_order_plan_legacy",
    "build_short_plan",
    "build_short_plan_legacy",
]
