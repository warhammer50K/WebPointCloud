"""Live point cloud streaming — an in-memory relay between a publisher and the viewer.

The viewer can already render streamed frames: `Viewer.updateRealtimePoints()`
drops a frame into one of the `raw`/`cur`/`kfrm`/`map` layers, and the parse
worker understands the wire format (see below). What was missing was a way to
get frames from a live source — a ROS 2 node, say — into the browser. That is
all this module is: publishers POST frames here, the browser polls for them.

Nothing here knows about ROS. The publisher does the decoding and downsampling
(`tools/ros2_bridge.py` does it for `sensor_msgs/PointCloud2`) and hands us
bytes; we hold the newest frame per stream and hand it to whoever asks. Keeping
the server free of ROS means the viewer host needs no ROS install, and the
bridge can just as well run on the robot and publish across the network.

── Wire format (what a publisher must send) ──
Body is `points × 7` little-endian float32: x, y, z, intensity, r, g, b.
Intensity and RGB are 0..1 — the viewer's shaders read them as normalized
values, so a raw 0..255 or 0..4095 intensity has to be scaled by the publisher.
Coordinates are float32 metres in whatever frame the publisher chose; a live
ROS frame is local and small enough that float32 loses nothing (unlike the
UTM-scale file path, which needs the float64 offset in `arrays_to_binary`).

With `compressed=1` the body is instead a 4-byte little-endian original length
followed by a zlib stream of the above — the worker's `zlibDecompress` expects
exactly that prefix.

── Retention ──
A replace layer keeps only its newest frame: a live view wants the current
world, not a backlog, so if the browser cannot keep up the right answer is to
skip frames rather than queue them until memory runs out. An accumulate layer
('kfrm') queues instead, within a byte budget — those frames merge into a
growing map, so a skipped one is a permanent hole in it rather than a moment of
staleness. `dropped` counts frames discarded before any client fetched them, so
a viewer falling behind shows up as a number instead of as vague lag.
"""

import re
import threading
import time
import uuid
from collections import deque

from flask import Blueprint, jsonify, request, current_app, Response

import config

live_bp = Blueprint('live', __name__)

# Floats per point in the wire format (x, y, z, intensity, r, g, b).
FLOATS_PER_POINT = 7
BYTES_PER_POINT = FLOATS_PER_POINT * 4

# Layers the viewer knows how to render. 'cur'/'raw'/'map' replace their cloud
# on every frame (a live scan); 'kfrm' accumulates into one merged geometry
# (a map being built up). Anything else would silently render nowhere.
LAYERS = ('cur', 'raw', 'map', 'kfrm')

# Stream names double as identifiers in URLs and in the UI. ROS topic names are
# the obvious thing to pass, so '/' is allowed.
_STREAM_RE = re.compile(r'^[\w./\- ]{1,64}$')

# An epoch changes whenever the server loses its stream state (restart, or an
# explicit reset). The viewer watches it to know that accumulated layers now
# belong to a different session and must be cleared instead of merged into.
EPOCH = uuid.uuid4().hex[:8]


class _Stream:
    """One publisher's undelivered frames, plus enough history to report rate.

    How much is held depends on what the layer means, which is the one place
    the relay has to care about the difference:

    • A replace layer ('cur'/'raw'/'map') redraws from scratch every frame, so
      an undelivered frame has no value once a newer one exists — keep one.
    • An accumulate layer ('kfrm') merges each frame into a growing map, so a
      dropped frame is a permanent hole in it. Those queue up, bounded by
      bytes rather than by count so one enormous chunk cannot outweigh the cap.
    """

    __slots__ = ('name', 'layer', 'queue', 'points', 'seq', 'updated',
                 'frames', 'dropped', 'taken_seq', 'interval')

    def __init__(self, name):
        self.name = name
        self.layer = 'cur'
        self.queue = deque()   # oldest first: [{seq, payload, points, compressed}]
        self.points = 0        # points in the newest frame
        self.seq = 0
        self.updated = 0.0
        self.frames = 0
        self.dropped = 0
        self.taken_seq = 0     # newest seq any client has fetched
        self.interval = 0.0    # EWMA of seconds between frames

    @property
    def accumulates(self):
        return self.layer == 'kfrm'

    def store(self, payload, points, layer, compressed, now):
        if self.updated:
            gap = now - self.updated
            # EWMA: a single slow frame shouldn't make the reported rate jump.
            self.interval = gap if not self.interval else self.interval * 0.7 + gap * 0.3
        self.layer = layer
        self.seq += 1
        self.frames += 1
        self.points = points
        self.updated = now
        self.queue.append({'seq': self.seq, 'payload': payload,
                           'points': points, 'compressed': compressed})
        self._trim()

    def _drop(self):
        """Discard the oldest frame, counting it only if nobody ever got it.

        Superseding a frame a client already fetched is the system working as
        intended, not a loss — counting those would report a steady stream of
        'drops' on every healthy replace layer.
        """
        frame = self.queue.popleft()
        if frame['seq'] > self.taken_seq:
            self.dropped += 1

    def _trim(self):
        if not self.accumulates:
            while len(self.queue) > 1:
                self._drop()
            return
        budget = config.LIVE_QUEUE_BYTES
        total = sum(len(f['payload']) for f in self.queue)
        # Always leave the newest frame, even if it alone exceeds the budget:
        # dropping it would mean the stream delivers nothing at all.
        while len(self.queue) > 1 and total > budget:
            total -= len(self.queue[0]['payload'])
            self._drop()

    def take_after(self, since):
        """The oldest frame newer than `since`, or None."""
        for f in self.queue:
            if f['seq'] > since:
                return f
        return None

    def queued_after(self, seq):
        return sum(1 for f in self.queue if f['seq'] > seq)

    def rate(self):
        return round(1.0 / self.interval, 1) if self.interval > 0 else 0.0

    def describe(self, now):
        return {
            'name': self.name,
            'layer': self.layer,
            'seq': self.seq,
            'points': self.points,
            'bytes': sum(len(f['payload']) for f in self.queue),
            'queued': len(self.queue),
            'rate': self.rate(),
            'age_ms': int((now - self.updated) * 1000),
            'frames': self.frames,
            'dropped': self.dropped,
        }


_lock = threading.Lock()
_streams: dict[str, _Stream] = {}
# The viewer draws a single pose marker, so one latest pose is all it can use.
_pose: dict | None = None


def _clean_stream_name(raw):
    """Validate a stream name, or return None.

    Names are only ever dict keys here, never paths — but they are echoed into
    the UI and into URLs, and '..' in an identifier invites someone downstream
    to treat it as one. Rejecting it costs nothing.
    """
    name = (raw or '').strip()
    if '..' in name or not _STREAM_RE.fullmatch(name):
        return None
    return name


def _token_ok():
    """Publishing writes into what every viewer sees, so it can need a token.

    On a private network the IP whitelist in security.py is the gate and a token
    is optional. With WPC_PUBLIC=1 that gate is gone, and an open publish
    endpoint would let anyone who can reach the port draw into the viewer — so
    there a token is required rather than merely honoured.
    """
    expected = config.LIVE_TOKEN
    if not expected:
        return not config.PUBLIC_MODE
    return request.headers.get('X-Live-Token', '') == expected


def _prune_locked(now):
    """Forget streams whose publisher has gone quiet.

    Without this a stopped bridge leaves its last frame on screen forever, and
    the stream list fills up with dead entries across a day of experiments.
    """
    for name in [n for n, s in _streams.items()
                 if now - s.updated > config.LIVE_STALE_SECONDS]:
        del _streams[name]


@live_bp.route('/api/live/publish', methods=['POST'])
def live_publish():
    """Accept one frame. Query: stream, layer, points, compressed."""
    if not _token_ok():
        return jsonify({'error': 'live publishing requires X-Live-Token'}), 403

    name = _clean_stream_name(request.args.get('stream'))
    if name is None:
        return jsonify({'error': 'invalid stream name'}), 400

    layer = request.args.get('layer', 'cur')
    if layer not in LAYERS:
        return jsonify({'error': f'layer must be one of {", ".join(LAYERS)}'}), 400

    compressed = request.args.get('compressed', '0') == '1'
    payload = request.get_data(cache=False)
    if not payload:
        return jsonify({'error': 'empty frame'}), 400
    if len(payload) > config.LIVE_MAX_FRAME_BYTES:
        return jsonify({'error': f'frame exceeds {config.LIVE_MAX_FRAME_BYTES} bytes'}), 413

    try:
        points = int(request.args.get('points', '0'))
    except ValueError:
        return jsonify({'error': 'points must be an integer'}), 400

    if not compressed:
        # An uncompressed body has to be exactly points × 28 bytes. Catching a
        # mismatch here names the bug; letting it through would show up as a
        # scrambled cloud in the browser with nothing to point at.
        if points <= 0 or len(payload) != points * BYTES_PER_POINT:
            return jsonify({'error': f'expected {points * BYTES_PER_POINT} bytes for '
                                     f'{points} points, got {len(payload)}'}), 400
    elif points <= 0:
        return jsonify({'error': 'points must be > 0'}), 400

    now = time.monotonic()
    with _lock:
        _prune_locked(now)
        stream = _streams.get(name)
        if stream is None:
            if len(_streams) >= config.LIVE_MAX_STREAMS:
                return jsonify({'error': f'at most {config.LIVE_MAX_STREAMS} '
                                         f'concurrent streams'}), 429
            stream = _Stream(name)
            _streams[name] = stream
            logger = current_app.config.get('LOGGER')
            if logger:
                logger.info(f"[Live] stream '{name}' opened (layer={layer})")
        stream.store(payload, points, layer, compressed, now)
        seq = stream.seq

    return jsonify({'ok': True, 'seq': seq, 'epoch': EPOCH})


@live_bp.route('/api/live/pose', methods=['POST'])
def live_pose():
    """Accept the publisher's current pose as a 16-float column-major matrix."""
    global _pose
    if not _token_ok():
        return jsonify({'error': 'live publishing requires X-Live-Token'}), 403

    body = request.get_json(silent=True) or {}
    matrix = body.get('matrix')
    if not isinstance(matrix, list) or len(matrix) != 16:
        return jsonify({'error': 'matrix must be 16 numbers (column-major)'}), 400
    try:
        matrix = [float(v) for v in matrix]
    except (TypeError, ValueError):
        return jsonify({'error': 'matrix must be 16 numbers (column-major)'}), 400
    if not all(v == v and abs(v) != float('inf') for v in matrix):
        return jsonify({'error': 'matrix contains NaN/Inf'}), 400

    with _lock:
        prev = _pose
        _pose = {
            'matrix': matrix,
            'stream': (request.args.get('stream') or '').strip()[:64],
            'seq': (prev['seq'] + 1) if prev else 1,
            'updated': time.monotonic(),
        }
        seq = _pose['seq']
    return jsonify({'ok': True, 'seq': seq})


@live_bp.route('/api/live/state')
def live_state():
    """Everything the viewer needs to decide what to fetch next.

    Deliberately one small JSON: the client polls this at frame rate, and
    folding pose and per-stream sequence numbers into it keeps the steady state
    at one request plus one request per stream that actually advanced.
    """
    now = time.monotonic()
    with _lock:
        _prune_locked(now)
        streams = [s.describe(now) for s in _streams.values()]
        pose = None
        if _pose and now - _pose['updated'] <= config.LIVE_STALE_SECONDS:
            pose = {'matrix': _pose['matrix'], 'seq': _pose['seq'],
                    'stream': _pose['stream'],
                    'age_ms': int((now - _pose['updated']) * 1000)}
    streams.sort(key=lambda s: s['name'])
    return jsonify({'epoch': EPOCH, 'streams': streams, 'pose': pose,
                    'layers': list(LAYERS)})


@live_bp.route('/api/live/frame')
def live_frame():
    """Return the newest frame of one stream, or 204 if the client has it.

    `since` is the sequence number the client already holds; polling with it is
    what keeps this cheap enough to call at frame rate.
    """
    name = _clean_stream_name(request.args.get('stream'))
    if name is None:
        return jsonify({'error': 'invalid stream name'}), 400
    try:
        since = int(request.args.get('since', '0'))
    except ValueError:
        since = 0

    with _lock:
        stream = _streams.get(name)
        if stream is None or stream.seq == 0:
            return jsonify({'error': 'no such stream'}), 404
        frame = stream.take_after(since)
        if frame is None:
            return Response(status=204)
        layer = stream.layer
        # How many more are waiting after this one, so a client draining an
        # accumulate backlog knows to come straight back instead of idling a
        # poll interval per frame.
        queued = stream.queued_after(frame['seq'])
        stream.taken_seq = max(stream.taken_seq, frame['seq'])

    resp = Response(frame['payload'], mimetype='application/octet-stream')
    resp.headers['X-Live-Seq'] = str(frame['seq'])
    resp.headers['X-Live-Points'] = str(frame['points'])
    resp.headers['X-Live-Layer'] = layer
    resp.headers['X-Live-Compressed'] = '1' if frame['compressed'] else '0'
    resp.headers['X-Live-Queued'] = str(queued)
    resp.headers['X-Live-Epoch'] = EPOCH
    resp.headers['Cache-Control'] = 'no-store'
    return resp


@live_bp.route('/api/live/reset', methods=['POST'])
def live_reset():
    """Drop every stream and the pose. Used by the viewer's Disconnect."""
    global EPOCH, _pose
    if not _token_ok():
        return jsonify({'error': 'live publishing requires X-Live-Token'}), 403
    with _lock:
        _streams.clear()
        _pose = None
        # A new epoch tells any other viewer that accumulated layers are stale.
        EPOCH = uuid.uuid4().hex[:8]
    return jsonify({'ok': True, 'epoch': EPOCH})
