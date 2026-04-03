"""Application configuration constants."""

import os

# ── Server ports ──────────────────────────────────────
WEB_PORT = int(os.environ.get('WEB_PORT', '5000'))

# ── Upload / buffer limits ────────────────────────────
MAX_CONTENT_LENGTH = 5 * 1024 * 1024 * 1024      # 5 GB

# ── Rate limiter ──────────────────────────────────────
RATE_LIMIT_MAX = 60
RATE_LIMIT_WINDOW = 60   # seconds

# ── Logging ───────────────────────────────────────────
LOG_MAX_BYTES = 10 * 1024 * 1024                 # 10 MB per file
LOG_BACKUP_COUNT = 5

# ── Static file cache ────────────────────────────────
STATIC_MAX_AGE_DEBUG = 0
STATIC_MAX_AGE_PROD = 3600

# ── Paths ─────────────────────────────────────────────
DATA_DIR = os.environ.get('WPC_DATA_DIR', os.path.expanduser('~/webpointcloud'))
MAPS_DIR = os.environ.get('WPC_MAPS_DIR', os.path.join(DATA_DIR, 'maps'))
LOG_DIR = os.path.join(DATA_DIR, 'logs')
