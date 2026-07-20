from __future__ import annotations

import subprocess
from pathlib import Path

from engine import settings
from engine.logging_utils import get_logger


def _build_dashboard_command(base_cmd: str, host: str, port: int) -> str:
    cmd = (base_cmd or "").strip()
    if not cmd:
        cmd = "npm run dev"
    if "--host" in cmd or "--port" in cmd:
        return cmd
    return f"{cmd} -- --host {host} --port {port}"


def start_dashboard():
    logger = get_logger()
    if not getattr(settings, "DASHBOARD_ENABLED", False):
        logger.info("Dashboard disabled — skipping web UI startup")
        return None

    dashboard_path = Path(getattr(settings, "DASHBOARD_PATH", "trading-desk-dashboard-main"))
    if not dashboard_path.exists():
        logger.error(f"Dashboard path not found: {dashboard_path}")
        return None

    host = getattr(settings, "DASHBOARD_HOST", "127.0.0.1")
    port = int(getattr(settings, "DASHBOARD_PORT", 5173))
    base_cmd = getattr(settings, "DASHBOARD_CMD", "npm run dev")
    cmd = _build_dashboard_command(base_cmd, host, port)

    logger.info(f"Starting dashboard: {cmd} (cwd={dashboard_path})")
    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(dashboard_path),
            shell=True,
        )
        logger.info(f"Dashboard process started (pid={process.pid})")
        return process
    except Exception as exc:
        logger.error(f"Failed to start dashboard: {exc}")
        return None


def stop_dashboard(process):
    if process is None:
        return
    try:
        if process.poll() is None:
            process.terminate()
    except Exception:
        pass
