"""Live streaming API: publish/poll contract, validation, retention."""
import os
import struct
import sys
import zlib

import numpy as np
import pytest
from urllib.parse import quote
from flask import Flask

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import live
from live import live_bp, BYTES_PER_POINT, FLOATS_PER_POINT


@pytest.fixture
def client():
    app = Flask(__name__)
    app.register_blueprint(live_bp)
    # Every test starts from an empty relay — module state is global.
    live._streams.clear()
    live._pose = None
    return app.test_client()


def frame(n, seed=0):
    """A valid n-point frame: x,y,z,intensity,r,g,b as little-endian float32."""
    rng = np.random.default_rng(seed)
    return rng.random((n, FLOATS_PER_POINT), dtype=np.float32).astype('<f4').tobytes()


def publish(client, payload, stream='/lidar', points=None, layer='cur', compressed=False):
    if points is None:
        points = len(payload) // BYTES_PER_POINT
    return client.post(
        f'/api/live/publish?stream={quote(stream, safe="")}&layer={layer}'
        f'&points={points}&compressed={"1" if compressed else "0"}',
        data=payload, content_type='application/octet-stream')


# ═══════════════════════════════════════════════════
#  1. Round trip
# ═══════════════════════════════════════════════════

def test_published_frame_comes_back_byte_identical(client):
    payload = frame(100)
    assert publish(client, payload).status_code == 200

    resp = client.get('/api/live/frame?stream=/lidar&since=0')
    assert resp.status_code == 200
    assert resp.data == payload
    assert resp.headers['X-Live-Points'] == '100'
    assert resp.headers['X-Live-Layer'] == 'cur'
    assert resp.headers['X-Live-Compressed'] == '0'


def test_same_sequence_is_not_resent(client):
    publish(client, frame(10))
    seq = int(client.get('/api/live/frame?stream=/lidar&since=0').headers['X-Live-Seq'])
    assert client.get(f'/api/live/frame?stream=/lidar&since={seq}').status_code == 204


def test_only_the_newest_frame_is_kept(client):
    publish(client, frame(10, seed=1))
    newest = frame(20, seed=2)
    publish(client, newest)

    resp = client.get('/api/live/frame?stream=/lidar&since=0')
    assert resp.data == newest
    assert resp.headers['X-Live-Seq'] == '2'


def test_overwritten_frames_are_counted_as_dropped(client):
    publish(client, frame(10))
    publish(client, frame(10, seed=3))     # nobody fetched the first one
    state = client.get('/api/live/state').get_json()
    assert state['streams'][0]['dropped'] == 1
    assert state['streams'][0]['frames'] == 2


def test_compressed_frames_relay_untouched(client):
    payload = frame(50)
    body = struct.pack('<I', len(payload)) + zlib.compress(payload, 1)
    assert publish(client, body, points=50, compressed=True).status_code == 200

    resp = client.get('/api/live/frame?stream=/lidar&since=0')
    assert resp.headers['X-Live-Compressed'] == '1'
    # The client inflates it, so the server must not have re-encoded anything.
    size = struct.unpack('<I', resp.data[:4])[0]
    assert zlib.decompress(resp.data[4:]) == payload
    assert size == len(payload)


# ═══════════════════════════════════════════════════
#  2. Validation
# ═══════════════════════════════════════════════════

def test_body_length_must_match_the_declared_point_count(client):
    resp = publish(client, frame(10), points=11)
    assert resp.status_code == 400
    assert 'bytes' in resp.get_json()['error']


@pytest.mark.parametrize('name', ['', 'a' * 65, 'bad;name', '../etc', 'x\ny', 'a<b>'])
def test_bad_stream_names_are_rejected(client, name):
    assert publish(client, frame(4), stream=name).status_code == 400


def test_unknown_layer_is_rejected(client):
    # A layer the viewer cannot render would drop frames into nowhere.
    assert publish(client, frame(4), layer='nowhere').status_code == 400


def test_empty_body_is_rejected(client):
    assert publish(client, b'', points=0).status_code == 400


def test_oversized_frame_is_rejected(client, monkeypatch):
    monkeypatch.setattr(live.config, 'LIVE_MAX_FRAME_BYTES', 100)
    assert publish(client, frame(100)).status_code == 413


def test_stream_count_is_capped(client, monkeypatch):
    monkeypatch.setattr(live.config, 'LIVE_MAX_STREAMS', 2)
    assert publish(client, frame(4), stream='a').status_code == 200
    assert publish(client, frame(4), stream='b').status_code == 200
    assert publish(client, frame(4), stream='c').status_code == 429


def test_missing_stream_is_404_not_204(client):
    # 204 means "you already have the newest"; a client polling a stream that
    # never existed must be able to tell the difference.
    assert client.get('/api/live/frame?stream=/nope&since=0').status_code == 404


# ═══════════════════════════════════════════════════
#  3. Pose
# ═══════════════════════════════════════════════════

def test_pose_round_trip(client):
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
    assert client.post('/api/live/pose', json={'matrix': identity}).status_code == 200
    pose = client.get('/api/live/state').get_json()['pose']
    assert pose['matrix'] == identity
    assert pose['seq'] == 1


@pytest.mark.parametrize('bad', [
    [1, 2, 3],                                   # wrong length
    'not a matrix',
    [float('nan')] * 16,                         # would poison the camera
    [float('inf')] * 16,
])
def test_bad_pose_is_rejected(client, bad):
    assert client.post('/api/live/pose', json={'matrix': bad}).status_code == 400


# ═══════════════════════════════════════════════════
#  4. Staleness, reset, epoch
# ═══════════════════════════════════════════════════

def test_stale_stream_disappears(client, monkeypatch):
    publish(client, frame(4))
    assert len(client.get('/api/live/state').get_json()['streams']) == 1
    monkeypatch.setattr(live.config, 'LIVE_STALE_SECONDS', -1)
    assert client.get('/api/live/state').get_json()['streams'] == []


def test_reset_clears_streams_and_changes_epoch(client):
    publish(client, frame(4))
    before = client.get('/api/live/state').get_json()['epoch']
    assert client.post('/api/live/reset').status_code == 200
    state = client.get('/api/live/state').get_json()
    assert state['streams'] == []
    assert state['pose'] is None
    # The epoch is how a connected viewer learns to drop accumulated layers.
    assert state['epoch'] != before


# ═══════════════════════════════════════════════════
#  5. Publish token
# ═══════════════════════════════════════════════════

def test_token_is_enforced_when_set(client, monkeypatch):
    monkeypatch.setattr(live.config, 'LIVE_TOKEN', 'secret')
    assert publish(client, frame(4)).status_code == 403
    resp = client.post('/api/live/publish?stream=/lidar&points=4&layer=cur',
                       data=frame(4), content_type='application/octet-stream',
                       headers={'X-Live-Token': 'secret'})
    assert resp.status_code == 200


def test_public_mode_without_a_token_refuses_publishing(client, monkeypatch):
    # WPC_PUBLIC=1 removes the private-IP whitelist, so an unauthenticated
    # publish endpoint would let anyone draw into the viewer.
    monkeypatch.setattr(live.config, 'PUBLIC_MODE', True)
    monkeypatch.setattr(live.config, 'LIVE_TOKEN', '')
    assert publish(client, frame(4)).status_code == 403


def test_reading_never_needs_a_token(client, monkeypatch):
    publish(client, frame(4))
    monkeypatch.setattr(live.config, 'LIVE_TOKEN', 'secret')
    assert client.get('/api/live/state').status_code == 200
    assert client.get('/api/live/frame?stream=/lidar&since=0').status_code == 200


# ═══════════════════════════════════════════════════
#  6. Per-layer retention
# ═══════════════════════════════════════════════════

def test_accumulate_layer_queues_frames_instead_of_replacing(client):
    # A 'kfrm' frame merges into a growing map, so one lost between polls is a
    # permanent hole — unlike a replaced scan, which the next frame repaints.
    for _ in range(5):
        publish(client, frame(10), stream='/kf', layer='kfrm')

    seen = []
    since = 0
    while True:
        resp = client.get(f'/api/live/frame?stream=/kf&since={since}')
        if resp.status_code == 204:
            break
        since = int(resp.headers['X-Live-Seq'])
        seen.append(since)
    assert seen == [1, 2, 3, 4, 5]


def test_replace_layer_still_keeps_only_the_newest(client):
    for _ in range(5):
        publish(client, frame(10), stream='/scan', layer='cur')
    resp = client.get('/api/live/frame?stream=/scan&since=0')
    assert resp.headers['X-Live-Seq'] == '5'
    assert resp.headers['X-Live-Queued'] == '0'


def test_queued_header_counts_the_backlog(client):
    for _ in range(3):
        publish(client, frame(10), stream='/kf', layer='kfrm')
    resp = client.get('/api/live/frame?stream=/kf&since=0')
    assert resp.headers['X-Live-Seq'] == '1'
    assert resp.headers['X-Live-Queued'] == '2'


def test_accumulate_queue_is_bounded_by_bytes(client, monkeypatch):
    payload = frame(10)
    monkeypatch.setattr(live.config, 'LIVE_QUEUE_BYTES', len(payload) * 2)
    for _ in range(6):
        publish(client, payload, stream='/kf', layer='kfrm')
    state = client.get('/api/live/state').get_json()['streams'][0]
    assert state['queued'] == 2
    assert state['dropped'] == 4


def test_replacing_a_delivered_frame_is_not_counted_as_dropped(client):
    # Superseding a frame the viewer already has is the design working, not a
    # loss — counting it would show constant 'drops' on a healthy stream.
    publish(client, frame(10), stream='/scan')
    client.get('/api/live/frame?stream=/scan&since=0')
    publish(client, frame(10, seed=9), stream='/scan')
    assert client.get('/api/live/state').get_json()['streams'][0]['dropped'] == 0
