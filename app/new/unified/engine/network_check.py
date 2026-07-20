import socket
from typing import Callable


def check_invest_api_connectivity(log: Callable[[str], None], label: str = "startup") -> None:
    host = "invest-public-api.tinkoff.ru"
    port = 443
    timeout = 3.0
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except Exception as exc:
        log(f"[NET] {label} resolve failed: {host}:{port} err={exc}")
        return

    results = []
    for info in infos:
        addr = info[4][0]
        try:
            with socket.create_connection((addr, port), timeout=timeout):
                results.append((addr, "ok"))
        except Exception as exc:
            results.append((addr, f"fail:{exc}"))

    if results:
        summary = ", ".join(f"{addr}={status}" for addr, status in results)
        log(f"[NET] {label} tcp check {host}:{port} -> {summary}")
    else:
        log(f"[NET] {label} no addresses for {host}:{port}")


__all__ = ["check_invest_api_connectivity"]

