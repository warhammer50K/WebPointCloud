"""Security middleware — secret key, rate limiting, IP whitelist."""

import os
import time
import ipaddress
import threading
from collections import defaultdict
from pathlib import Path

from flask import request, abort


def load_or_create_secret_key() -> str:
    """Read SECRET_KEY from env, or persist in ~/.mapper_secret_key."""
    env_key = os.environ.get('FLASK_SECRET_KEY')
    if env_key:
        return env_key
    key_path = Path.home() / '.mapper_secret_key'
    if key_path.exists():
        return key_path.read_text().strip()
    new_key = os.urandom(24).hex()
    key_path.write_text(new_key)
    key_path.chmod(0o600)
    return new_key


class RateLimiter:
    """Per-IP sliding-window rate limiter (no external deps)."""

    def __init__(self, max_requests: int = 60, window_seconds: int = 60):
        self._max = max_requests
        self._window = window_seconds
        self._hits: dict[str, list[float]] = defaultdict(list)
        self._lock = threading.Lock()

    def is_allowed(self, ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            timestamps = self._hits[ip]
            cutoff = now - self._window
            self._hits[ip] = [t for t in timestamps if t > cutoff]
            if len(self._hits[ip]) >= self._max:
                return False
            self._hits[ip].append(now)
            return True


_PRIVATE_NETWORKS = (
    ipaddress.ip_network('127.0.0.0/8'),
    ipaddress.ip_network('10.0.0.0/8'),
    ipaddress.ip_network('172.16.0.0/12'),
    ipaddress.ip_network('192.168.0.0/16'),
    ipaddress.ip_network('100.64.0.0/10'),   # Tailscale / CGNAT
    ipaddress.ip_network('::1/128'),
    ipaddress.ip_network('fe80::/10'),        # link-local IPv6
)


def is_private(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
        return any(addr in net for net in _PRIVATE_NETWORKS)
    except ValueError:
        return False


def init_security(app, logger, rate_limiter=None):
    """Register before_request handler for IP whitelist + rate limiting."""
    if rate_limiter is None:
        rate_limiter = RateLimiter()

    @app.before_request
    def _check_ip_and_rate_limit():
        if request.path.startswith('/static/'):
            return None
        client_ip = request.remote_addr
        if not is_private(client_ip):
            logger.warning(f"[Security] Blocked request from {client_ip}")
            abort(403)
        if not rate_limiter.is_allowed(client_ip):
            logger.warning(f"[Security] Rate limit exceeded for {client_ip}")
            abort(429)
        return None
