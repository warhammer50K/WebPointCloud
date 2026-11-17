"""Drag&drop uploads must not pile up under DATA_DIR/uploads.

Only uploads still needed on disk (streamed COPC, a running conversion)
outlive the request; the rest go at once, and old ones age out.
"""
import io
import os
import struct
import sys
import time

import pytest
from flask import Flask

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import api
import config


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(config, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(api, '_last_upload_prune', 0.0)
    return tmp_path / 'uploads'


@pytest.fixture
def client(tmp_path, uploads):
    app = Flask(__name__)
    app.config['MAPS_DIR'] = str(tmp_path / 'maps')
    app.register_blueprint(api.api_bp)
    return app.test_client()


def upload(client, data, name):
    return client.post('/api/load_pointcloud', data={'file': (io.BytesIO(data), name)})


def test_rejected_upload_is_removed(client, uploads):
    assert upload(client, b'abc', 'x.unknown').status_code == 400
    assert os.listdir(uploads) == []


def test_failed_upload_is_removed(client, uploads):
    assert upload(client, b'garbage', 'x.las').status_code == 500
    assert os.listdir(uploads) == []


def test_small_upload_is_removed_after_reading(client, uploads):
    assert upload(client, b'1 2 3\n4 5 6\n', 'p.xyz').status_code == 200
    assert os.listdir(uploads) == []


def test_streamed_copc_upload_is_kept_then_aged_out(client, uploads):
    with open(os.path.join(ROOT, 'sample/copc/building_utm.copc.laz'), 'rb') as f:
        assert upload(client, f.read(), 'b.copc.laz').status_code == 200
    (kept,) = os.listdir(uploads)
    old = time.time() - 2 * config.UPLOAD_TTL_HOURS * 3600
    os.utime(uploads / kept, (old, old))
    api._last_upload_prune = 0.0
    api._upload_tmp_dir()
    assert os.listdir(uploads) == []


def test_non_finite_points_are_dropped(client, uploads):
    """One NaN used to turn the centering offset and bounds into NaN."""
    r = upload(client, b'1 2 3\nnan nan nan\n4 5 6\ninf 0 0\n', 'p.xyz')
    n, _fpp = struct.unpack('<II', r.data[:8])
    assert n == 2
    assert struct.unpack('<ddd', r.data[8:32]) == (2.5, 3.5, 4.5)
