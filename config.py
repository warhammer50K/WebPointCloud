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

# ── Live streaming (ROS 2 bridge → viewer) ────────────
# Only the newest frame per stream is held, so this caps one frame, not a
# queue. 32 MB is ~1.2M points at 28 B/point — far more than a sensor frame
# needs, and a downsampled map cloud should stay well under it.
LIVE_MAX_FRAME_BYTES = int(os.environ.get('WPC_LIVE_MAX_FRAME_MB', '32')) * 1024 * 1024
# Undelivered frames held for an accumulating ('kfrm') stream, in bytes.
# Those frames merge into a growing map, so dropping one leaves a permanent
# hole — they queue instead of being replaced. 64 MB is a few seconds of
# backlog at any sane keyframe rate, and the cap is what stops a viewer that
# has wandered off from turning the queue into a memory leak.
LIVE_QUEUE_BYTES = int(os.environ.get('WPC_LIVE_QUEUE_MB', '64')) * 1024 * 1024
# A handful of concurrent publishers (scan + map + a second robot) is plenty;
# the cap is there so a misconfigured bridge can't open streams forever.
LIVE_MAX_STREAMS = int(os.environ.get('WPC_LIVE_MAX_STREAMS', '8'))
# A publisher that has said nothing for this long is treated as gone, and its
# last frame stops being served — a stale cloud frozen on screen reads as live
# data that simply is not moving, which is worse than showing nothing.
LIVE_STALE_SECONDS = float(os.environ.get('WPC_LIVE_STALE_SEC', '15'))
# Shared secret for publishing. Optional behind the private-IP whitelist,
# required when WPC_PUBLIC=1 removes it (see live.py:_token_ok).
LIVE_TOKEN = os.environ.get('WPC_LIVE_TOKEN', '')

# ── Public mode ───────────────────────────────────────
# Set by WPC_PUBLIC=1: drops the private-IP whitelist in security.py. Read here
# too so the live API can tighten its own gate when the network gate is gone.
PUBLIC_MODE = os.environ.get('WPC_PUBLIC', '0') == '1'

# ── Paths ─────────────────────────────────────────────
# Everything the app owns lives under one directory, so a fresh install adds a
# single entry to $HOME instead of scattering maps, logs, caches and a secret
# file across it.
DATA_DIR = os.environ.get('WPC_DATA_DIR', os.path.expanduser('~/webpointcloud'))


def _default_maps_dir():
    """Where maps live when WPC_MAPS_DIR is unset.

    A fresh install gets $DATA_DIR/maps, so everything the app owns sits in one
    tree. Installs that predate that layout have their clouds in ~/maps, which
    was the unconditional default — moving them to a new, empty directory would
    look exactly like the maps had been deleted, and a fork carrying local
    changes would hit it on the next merge. So an existing ~/maps keeps
    winning, and only a machine that has never had one sees the new default.
    Either way the startup banner prints the path that was chosen.
    """
    legacy = os.path.expanduser('~/maps')
    if os.path.isdir(legacy):
        return legacy
    return os.path.join(DATA_DIR, 'maps')

# Point WPC_MAPS_DIR at an existing collection (a NAS mount, a dataset
# directory) to read from there instead — nothing is copied or moved, and the
# app only writes into it when you save an analysis result.
MAPS_DIR = os.environ.get('WPC_MAPS_DIR') or _default_maps_dir()
LOG_DIR = os.path.join(DATA_DIR, 'logs')
# Flask session secret for new installs, when FLASK_SECRET_KEY is not set.
# Earlier versions used ~/.mapper_secret_key — a name inherited from a
# predecessor project. security.py still reads that file where it is, so an
# existing install is not relocated behind its owner's back.
SECRET_KEY_PATH = os.path.join(DATA_DIR, 'secret_key')
