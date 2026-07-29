import math
from typing import Dict, Optional


def round_price_to_step(price: float, step: float, side: str) -> float:
    if not step or step <= 0:
        return price
    if side == "buy":
        return math.floor(price / step) * step
    return math.ceil(price / step) * step


def normalize_price(price: float, min_increment: float) -> float:
    if not min_increment or min_increment <= 0:
        return price
    steps = round(price / min_increment)
    return round(steps * min_increment, 6)


def pct_to_ratio(pct: float) -> float:
    if pct is None:
        return 0.0
    return pct / 100.0 if pct > 1 else pct


def choose_price_scale(
    base_price: float,
    last_price: Optional[float],
    grid_min: Optional[float],
    grid_max: Optional[float],
) -> float:
    if base_price <= 0:
        return 1.0

    candidate_scales = [1.0, 0.1, 0.01, 10.0]
    candidates = []

    for scale in candidate_scales:
        scaled = base_price * scale
        if grid_min is not None and scaled < grid_min:
            continue
        if grid_max is not None and scaled > grid_max:
            continue
        score = abs(scaled - last_price) if last_price is not None else 0
        candidates.append((score, scale))

    if candidates:
        return min(candidates, key=lambda x: x[0])[1]

    if last_price and last_price > 0:
        ratio = last_price / base_price
        return min(candidate_scales, key=lambda s: abs(s - ratio))

    return 1.0


def normalize_prices(figi_cfg: Dict, base_price: float, last_price: Optional[float]):
    grid_min = figi_cfg.get("grid_min")
    grid_max = figi_cfg.get("grid_max")
    price_step = figi_cfg.get("price_step", figi_cfg.get("step", 0))

    scale = figi_cfg.get("price_scale")
    if not scale:
        scale = choose_price_scale(base_price, last_price, grid_min, grid_max)

    if scale != 1.0:
        base_price = base_price * scale

    normalized_cfg = dict(figi_cfg)
    normalized_cfg["grid_min"] = grid_min
    normalized_cfg["grid_max"] = grid_max
    normalized_cfg["price_step"] = price_step

    return normalized_cfg, base_price, scale


def percent_to_rub(value_percent: float, nominal: float) -> float:
    return value_percent * nominal / 100


__all__ = [
    "round_price_to_step",
    "normalize_price",
    "pct_to_ratio",
    "choose_price_scale",
    "normalize_prices",
    "percent_to_rub",
]
