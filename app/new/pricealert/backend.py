import os
import logging
from pathlib import Path
import uvicorn
from logic.api import app
from logic.db import CONFIG

PORT = int(os.environ.get("PORT", CONFIG["server"]["port"]))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("pricealert")

def setup_file_logging():
    try:
        log_dir = Path(__file__).parent / "data"
        log_dir.mkdir(exist_ok=True)
        log_file = log_dir / "pricealert.log"
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(file_handler)
        log.info(f"File logging configured at {log_file}")
    except Exception as e:
        log.warning(f"Failed to configure file logging: {e}")

setup_file_logging()

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
