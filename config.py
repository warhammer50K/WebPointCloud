"""Application configuration constants."""

import os

# ── Server ports ──────────────────────────────────────
WEB_PORT = int(os.environ.get('WEB_PORT', '6001'))

# ── Upload / buffer limits ────────────────────────────
MAX_CONTENT_LENGTH = int(os.environ.get('WPC_MAX_UPLOAD_MB', '5120')) * 1024 * 1024

# ── Rate limiter ──────────────────────────────────────
RATE_LIMIT_MAX = 60
RATE_LIMIT_WINDOW = 60   # seconds

# ── Logging ───────────────────────────────────────────
LOG_MAX_BYTES = 10 * 1024 * 1024                 # 10 MB per file
LOG_BACKUP_COUNT = 5

# ── Static file cache ────────────────────────────────
STATIC_MAX_AGE_DEBUG = 0
STATIC_MAX_AGE_PROD = 3600

# ── COPC octree LOD streaming ─────────────────────────
# Uploads with at least this many points are auto-converted to COPC and
# streamed via the octree LOD path instead of being loaded whole.
COPC_STREAM_MIN_POINTS = int(os.environ.get('WPC_COPC_MIN_POINTS', '2000000'))
# Soft cap on points kept resident on the GPU while streaming (Stage 4 LRU).
# ~28 B/point on the GPU → 25M ≈ 700 MB. Raise via WPC_COPC_BUDGET if the GPU
# has headroom and you want a denser zoomed-in view; lower it if VRAM is tight.
COPC_POINT_BUDGET = int(os.environ.get('WPC_COPC_BUDGET', '25000000'))

# ── Paths ─────────────────────────────────────────────
DATA_DIR = os.environ.get('WPC_DATA_DIR', os.path.expanduser('~/webpointcloud'))
# Maps load directly from ~/maps by default (decoupled from DATA_DIR, which only
# holds logs/cache). Override with WPC_MAPS_DIR.
MAPS_DIR = os.environ.get('WPC_MAPS_DIR', os.path.expanduser('~/maps'))
LOG_DIR = os.path.join(DATA_DIR, 'logs')
