from typing import Optional

from tinkoff.invest import Quotation


def to_quotation(value: float) -> Quotation:
    units = int(value)
    nano = int(round((value - units) * 1e9))
    return Quotation(units=units, nano=nano)


def quotation_to_float(q: Optional[Quotation]) -> Optional[float]:
    if not q:
        return None
    return q.units + q.nano / 1e9


def money_value_to_float(money_obj) -> float:
    if money_obj is None:
        return 0.0
    units = getattr(money_obj, "units", None) or 0
    nano = getattr(money_obj, "nano", None) or 0
    return float(units) + float(nano) / 1e9


def normalize_instrument_type(value):
    if isinstance(value, str):
        v = value.strip().lower()
        if v in {"1", "bond", "b", "ofz"}:
            return "bond"
        if v in {"2", "share", "s"}:
            return "share"
        if v in {"3", "futures", "future", "f"}:
            return "futures"
        return v
    if isinstance(value, (int, float)):
        if int(value) == 1:
            return "bond"
        if int(value) == 2:
            return "share"
        if int(value) == 3:
            return "futures"
    return value


__all__ = ["to_quotation", "quotation_to_float", "money_value_to_float", "normalize_instrument_type"]
