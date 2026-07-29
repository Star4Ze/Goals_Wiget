from contextlib import contextmanager
from typing import Callable, Optional

from tinkoff.invest import Client as TinkoffClient

from engine.rate_limit import get_limiters_for_token


class _ThrottledService:
    def __init__(self, service, limiter=None, per_method=None):
        self._service = service
        self._limiter = limiter
        self._per_method = per_method or {}

    def __getattr__(self, name):
        attr = getattr(self._service, name)
        if not callable(attr):
            return attr

        limiter = self._per_method.get(name) or self._limiter
        if limiter is None:
            return attr

        def _wrapped(*args, **kwargs):
            limiter.wait()
            return attr(*args, **kwargs)

        return _wrapped


class ThrottledClient:
    def __init__(self, client: TinkoffClient, token: str):
        self._client = client
        limiters = get_limiters_for_token(token)
        self.operations = _ThrottledService(client.operations, limiter=limiters["operations"])
        self.orders = _ThrottledService(
            client.orders,
            per_method={
                "get_orders": limiters["orders_get"],
                "cancel_order": limiters["orders_cancel"],
            },
        )
        self.stop_orders = _ThrottledService(client.stop_orders, limiter=limiters["stop_orders"])
        self.market_data = client.market_data
        self.instruments = client.instruments
        self.users = getattr(client, "users", None)

    def __getattr__(self, name):
        return getattr(self._client, name)


@contextmanager
def get_client(token: str):
    with TinkoffClient(token) as client:
        yield ThrottledClient(client, token)


__all__ = ["get_client", "ThrottledClient"]

