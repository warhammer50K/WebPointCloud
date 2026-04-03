#!/usr/bin/env python3
"""WebPointCloud — Web-based 3D Point Cloud Viewer & Analysis Tool"""

import os
import logging
from logging.handlers import RotatingFileHandler

from flask import Flask, render_template

import config
from security import load_or_create_secret_key, RateLimiter, init_security

_rate_limiter = RateLimiter(config.RATE_LIMIT_MAX, config.RATE_LIMIT_WINDOW)


# ── Flask app ─────────────────────────────────────────
_here = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__,
            static_folder=os.path.join(_here, 'static'),
            template_folder=os.path.join(_here, 'templates'))
app.config['SECRET_KEY'] = load_or_create_secret_key()
_is_debug = os.environ.get('FLASK_DEBUG', '0') == '1'
app.config['SEND_FILE_MAX_AGE_DEFAULT'] = (
    config.STATIC_MAX_AGE_DEBUG if _is_debug else config.STATIC_MAX_AGE_PROD)
app.config['MAX_CONTENT_LENGTH'] = config.MAX_CONTENT_LENGTH

app.config['MAPS_DIR'] = config.MAPS_DIR
os.makedirs(config.MAPS_DIR, exist_ok=True)

# ── Logging ───────────────────────────────────────────
os.makedirs(config.LOG_DIR, exist_ok=True)

logger = logging.getLogger('webpointcloud')
logger.setLevel(logging.DEBUG)

_fh = RotatingFileHandler(
    os.path.join(config.LOG_DIR, 'webpointcloud.log'),
    maxBytes=config.LOG_MAX_BYTES, backupCount=config.LOG_BACKUP_COUNT, encoding='utf-8')
_fh.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s',
                                    datefmt='%Y-%m-%d %H:%M:%S'))
_fh.setLevel(logging.DEBUG)

_ch = logging.StreamHandler()
_ch.setFormatter(logging.Formatter('[%(asctime)s] [%(levelname)s] %(message)s',
                                    datefmt='%H:%M:%S'))
_ch.setLevel(logging.DEBUG)

logger.addHandler(_fh)
logger.addHandler(_ch)

app.config['LOGGER'] = logger

# ── Register Blueprint ────────────────────────────────
from api import api_bp  # noqa: E402
app.register_blueprint(api_bp)

# ── Security middleware (IP whitelist + rate limiting) ─
init_security(app, logger, _rate_limiter)


# ── Pages ─────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


if __name__ == '__main__':
    logger.info("═══════════════════════════════════════")
    logger.info("  WebPointCloud")
    logger.info(f"  Data dir : {config.DATA_DIR}")
    logger.info(f"  Maps dir : {config.MAPS_DIR}")
    logger.info(f"  Log dir  : {config.LOG_DIR}")
    logger.info(f"  URL      : http://localhost:{config.WEB_PORT}")
    logger.info("═══════════════════════════════════════")
    app.run(host='0.0.0.0', port=config.WEB_PORT, debug=_is_debug)
