import threading
import time
from collections import deque
from typing import Dict, Tuple


class RateLimiter:
    def __init__(self, requests_per_minute: int):
        self.requests_per_minute = max(1, int(requests_per_minute or 1))
        self._lock = threading.Lock()
        self._events = deque()

    def wait(self):
        window = 60.0
        while True:
            with self._lock:
                now = time.monotonic()
                while self._events and now - self._events[0] >= window:
                    self._events.popleft()
                if len(self._events) < self.requests_per_minute:
                    self._events.append(now)
                    return
                sleep_for = window - (now - self._events[0])
            time.sleep(min(max(sleep_for, 0.01), 1.0))


_LIMITERS: Dict[Tuple[str, str], RateLimiter] = {}


def _get_limiter(token: str, key: str, rpm: int) -> RateLimiter:
    token_key = token or ""
    cache_key = (token_key, key)
    limiter = _LIMITERS.get(cache_key)
    if limiter is None:
        limiter = RateLimiter(rpm)
        _LIMITERS[cache_key] = limiter
    return limiter


def get_limiters_for_token(token: str) -> dict:
    return {
        "operations": _get_limiter(token, "operations", 100),
        "orders_get": _get_limiter(token, "orders_get", 100),
        "orders_cancel": _get_limiter(token, "orders_cancel", 50),
        "stop_orders": _get_limiter(token, "stop_orders", 25),
    }

