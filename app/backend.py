import os

from flask import Flask, jsonify
from flask_cors import CORS

from service import register as register_trading_journal

app = Flask(__name__)
CORS(app)
register_trading_journal(app)


@app.get("/health")
def health():
    return jsonify({"status": "ok", "app": "TDR"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5005"))
    app.run(host="0.0.0.0", port=port, debug=False)
