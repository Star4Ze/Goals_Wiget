from typing import Dict, Optional

from tinkoff.invest import InstrumentIdType

from engine import settings
from engine.logging_utils import get_logger, log
from engine.price_utils import percent_to_rub
from engine.storage import ensure_figi_dir, load_json
from engine.utils import normalize_instrument_type, quotation_to_float


logger = get_logger()


def bond_history_multiplier(price: Optional[float], nominal: Optional[float], currency_rate: float) -> float:
    if price is None:
        return 1.0
    if price >= 200:
        return 1.0
    if not nominal:
        return 1.0
    return (nominal / 100) * currency_rate


def get_last_price(client, figi: str) -> Optional[float]:
    try:
        from logic.alerts import watched
        if figi in watched and watched[figi] > 0:
            return watched[figi]
    except Exception:
        pass

    try:
        resp = client.market_data.get_last_prices(figi=[figi])
        if resp.last_prices:
            val = quotation_to_float(resp.last_prices[0].price)
            try:
                from logic.alerts import watched
                watched[figi] = val
            except Exception:
                pass
            return val
    except Exception as e:
        log(f"[PRICE] market_data error for {figi}: {e}")

    history = load_json(ensure_figi_dir(figi) / "trades_history.json", [])
    if history:
        return history[-1]["price"]
    return None



def get_currency_rate(client, currency_pair: str = "CNY_RUB") -> float:
    try:
        orderbook = client.market_data.get_order_book(figi="FUTCNYRUBF00", depth=1)
        if orderbook.last_price:
            rate = orderbook.last_price.units + orderbook.last_price.nano / 1e9
            logger.debug(f"Курс {currency_pair}: {rate:.2f} руб.")
            return rate
        logger.warning(f"Не удалось получить курс {currency_pair}, используется fallback 11.65")
        return 11.65
    except Exception as e:
        logger.error(f"Ошибка получения курса {currency_pair}: {str(e)}")
        return 11.65


def get_min_price_increment(client, figi: str) -> float:
    try:
        future = client.instruments.future_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(future.min_price_increment) or 0.01
    except Exception:
        pass

    try:
        bond = client.instruments.bond_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(bond.min_price_increment) or 0.01
    except Exception:
        pass

    try:
        share = client.instruments.share_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(share.min_price_increment) or 0.01
    except Exception:
        pass

    try:
        etf = client.instruments.etf_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(etf.min_price_increment) or 0.01
    except Exception:
        pass

    try:
        currency = client.instruments.currency_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(currency.min_price_increment) or 0.01
    except Exception:
        pass

    return 0.01


def get_price_limits(client, figi: str):
    try:
        orderbook = client.market_data.get_order_book(figi=figi, depth=1)
        limit_up = quotation_to_float(getattr(orderbook, "limit_up", None))
        limit_down = quotation_to_float(getattr(orderbook, "limit_down", None))
        # Treat 0 or invalid limits as no limit
        if limit_up is None or limit_up <= 0:
            limit_up = None
        if limit_down is None or limit_down <= 0:
            limit_down = None
        return limit_down, limit_up
    except Exception as e:
        log(f"[LIMITS] error for {figi}: {e}")
        return None, None


def get_bond_nominal(client, figi: str) -> Optional[float]:
    try:
        bond = client.instruments.bond_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(bond.nominal)
    except Exception:
        return None


def get_bond_nkd(client, figi: str) -> Optional[float]:
    try:
        bond = client.instruments.bond_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        return quotation_to_float(getattr(bond, "aci_value", None))
    except Exception:
        return None


def get_futures_go_per_lot(client, figi: str) -> Optional[float]:
    try:
        if getattr(settings, "IS_QUALIFIED_INVESTOR", False) and figi in settings.TICKERS_CONFIG:
            cfg = settings.TICKERS_CONFIG[figi]
            go_buy = cfg.get("GO_BUY_QUAL", None)
            go_sell = cfg.get("GO_SELL_QUAL", None)
            if go_buy is not None or go_sell is not None:
                candidates = [v for v in (go_buy, go_sell) if v is not None]
                return max(candidates) if candidates else None

        future = client.instruments.future_by(
            id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
            id=figi,
        ).instrument
        go_buy = quotation_to_float(getattr(future, "initial_margin_on_buy", None))
        go_sell = quotation_to_float(getattr(future, "initial_margin_on_sell", None))
        candidates = [v for v in (go_buy, go_sell) if v is not None]
        return max(candidates) if candidates else None
    except Exception:
        return None


def compute_price_context(client, figi: str, figi_cfg: Dict):
    instrument_type = figi_cfg.get("INSTRUMENT_TYPE", "bond")
    # Normalize numeric instrument types from config and dashboard
    instrument_type = normalize_instrument_type(instrument_type)
    currency = figi_cfg.get("CURRENCY", "rub")
    lot_size = figi_cfg.get("LOT_SIZE", 1)

    last_price = get_last_price(client, figi)
    if last_price is None:
        return None

    currency_rate = get_currency_rate(client, f"{currency.upper()}_RUB") if currency != "rub" else 1.0
    nominal = figi_cfg.get("nominal")

    bond_nkd = 0.0
    if instrument_type == "bond":
        if not nominal:
            nominal = get_bond_nominal(client, figi) or 1000
        bond_nkd = get_bond_nkd(client, figi) or 0.0
        last_price_value = last_price * nominal / 100 * currency_rate
        price_mode = "rub"
        min_inc = get_min_price_increment(client, figi) or 0.01
    elif instrument_type == "share":
        last_price_value = last_price * currency_rate
        price_mode = "rub"
        min_inc = get_min_price_increment(client, figi) or 0.01
    elif instrument_type == "futures":
        last_price_value = last_price
        price_mode = "rub"
        min_inc = get_min_price_increment(client, figi) or 0.01
    else:
        last_price_value = last_price
        price_mode = "rub"
        min_inc = get_min_price_increment(client, figi) or 0.01

    limit_down, limit_up = get_price_limits(client, figi)

    # Clean up limits from orderbook (0 is not a real limit)
    if limit_up is not None and limit_up <= 0:
        limit_up = None
    if limit_down is not None and limit_down <= 0:
        limit_down = None

    if instrument_type == "bond":
        if not nominal:
            nominal = get_bond_nominal(client, figi) or 1000
        if nominal <= 0:
            nominal = 1000
        # If last_price returns percent (e.g. 99.96), convert to RUB using nominal
        if last_price is not None:
            last_price_value = last_price * nominal / 100 * currency_rate
        else:
            last_price_value = None
        # Convert price limits from percent to RUB
        if limit_down is not None:
            limit_down = percent_to_rub(limit_down, nominal) * currency_rate
        if limit_up is not None:
            limit_up = percent_to_rub(limit_up, nominal) * currency_rate
    elif instrument_type == "share":
        last_price_value = last_price * currency_rate if last_price is not None else None
        if limit_down is not None:
            limit_down = limit_down * currency_rate
        if limit_up is not None:
            limit_up = limit_up * currency_rate
    elif instrument_type == "futures":
        last_price_value = last_price
        if limit_down is not None:
            limit_down = limit_down
        if limit_up is not None:
            limit_up = limit_up
    else:
        last_price_value = last_price

    # Log debug conversion for bond pricing sanity
    if instrument_type == "bond":
        logger.debug(
            f"[PRICE] bond conversion {figi}: last_percent={last_price} nominal={nominal} -> last_rub={last_price_value} "
            f"limit_down={limit_down} limit_up={limit_up}"
        )

    return {
        "instrument_type": instrument_type,
        "price_mode": price_mode,
        "currency_rate": currency_rate,
        "nominal": nominal,
        "lot_size": lot_size,
        "last_price": last_price_value,
        "bond_nkd": bond_nkd * currency_rate,
        "min_inc": min_inc,
        "limit_down": limit_down,
        "limit_up": limit_up,
    }


__all__ = [
    "bond_history_multiplier",
    "get_last_price",
    "get_currency_rate",
    "get_min_price_increment",
    "get_price_limits",
    "get_bond_nominal",
    "get_bond_nkd",
    "get_futures_go_per_lot",
    "compute_price_context",
]
