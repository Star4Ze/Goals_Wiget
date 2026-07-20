from typing import Optional

from engine import settings


def _normalize_token(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _get_token_from_dict(data: dict, keys: list[str]) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    for key in keys:
        if key in data:
            token = _normalize_token(data.get(key))
            if token:
                return token
    return None


def get_account_token(account: dict, purpose: str, base_settings: Optional[dict] = None) -> Optional[str]:
    purpose_key = purpose.upper()
    tokens = account.get("TOKENS") if isinstance(account, dict) else None
    token = _get_token_from_dict(tokens or {}, [purpose_key, purpose])
    if token:
        return token

    token = _get_token_from_dict(
        account if isinstance(account, dict) else {},
        [f"TOKEN_{purpose_key}", f"{purpose_key}_TOKEN"],
    )
    if token:
        return token

    settings_block = account.get("SETTINGS") if isinstance(account, dict) else None
    token = _get_token_from_dict(
        settings_block or {},
        [f"TOKEN_{purpose_key}", f"{purpose_key}_TOKEN"],
    )
    if token:
        return token

    base = base_settings or {}
    token = _get_token_from_dict(
        base,
        [f"TOKEN_{purpose_key}", f"{purpose_key}_TOKEN", "TOKEN"],
    )
    if token:
        return token

    token = _get_token_from_dict(
        {
            "TOKEN_TRADE": getattr(settings, "TOKEN_TRADE", None),
            "TOKEN_HISTORY": getattr(settings, "TOKEN_HISTORY", None),
            "TOKEN": getattr(settings, "TOKEN", None),
        },
        [f"TOKEN_{purpose_key}", "TOKEN"],
    )
    return token


def get_trade_token(account: dict, base_settings: Optional[dict] = None) -> Optional[str]:
    return get_account_token(account, "TRADE", base_settings)


def get_history_token(account: dict, base_settings: Optional[dict] = None) -> Optional[str]:
    return get_account_token(account, "HISTORY", base_settings)


def get_trade_token_for_account_id(account_id: str) -> Optional[str]:
    accounts = getattr(settings, "ACCOUNTS", []) or []
    for acc in accounts:
        if str(acc.get("ACCOUNT_ID")) == str(account_id):
            return get_trade_token(acc, None)
    return _normalize_token(getattr(settings, "TOKEN_TRADE", None) or getattr(settings, "TOKEN", None))


__all__ = [
    "get_account_token",
    "get_trade_token",
    "get_history_token",
    "get_trade_token_for_account_id",
]

