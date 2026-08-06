#!/usr/bin/env python3
"""WebPointCloud — Web-based 3D Point Cloud Viewer & Analysis Tool"""

import os
import logging
from logging.handlers import RotatingFileHandler

from flask import Flask, render_template, request

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


@app.after_request
def _revalidate_app_code(resp):
    """Never let the browser serve JS/CSS blind from cache.

    index.html is rendered fresh on every request, but static/* is cached for
    STATIC_MAX_AGE_PROD. That mix serves new markup with old code — a control
    added to the template shows up with nothing wired to it, and the page looks
    broken in a way no amount of reloading explains. Versioned filenames would
    be the usual answer, but the viewer's ES modules import each other by
    relative path, so a query string on the entry point does not reach the
    graph. 'no-cache' lets the browser keep the file and revalidate it (304, no
    re-download); it only forbids using it without asking. Images/fonts keep
    the full max-age.
    """
    if request.endpoint == 'static' and request.path.endswith(('.js', '.css')):
        resp.headers['Cache-Control'] = 'no-cache'
        resp.headers.pop('Expires', None)
    return resp

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
    # Debug mode ships Werkzeug's interactive debugger — remote code execution
    # for anyone who can reach the port — so never expose it beyond loopback
    # unless explicitly opted in via WPC_ALLOW_REMOTE_DEBUG=1.
    _host = '0.0.0.0'
    if _is_debug:
        if os.environ.get('WPC_ALLOW_REMOTE_DEBUG', '0') == '1':
            logger.warning("FLASK_DEBUG=1 on 0.0.0.0 (WPC_ALLOW_REMOTE_DEBUG=1): "
                           "Werkzeug debugger is RCE for anyone who can reach the port")
        else:
            _host = '127.0.0.1'
            logger.warning("FLASK_DEBUG=1: forcing host to 127.0.0.1 "
                           "(set WPC_ALLOW_REMOTE_DEBUG=1 to bind 0.0.0.0)")
    # threaded=True so COPC node fetches (many small concurrent requests while
    # streaming) are served in parallel instead of one-at-a-time.
    app.run(host=_host, port=config.WEB_PORT, debug=_is_debug, threaded=True)
