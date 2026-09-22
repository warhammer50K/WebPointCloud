#!/usr/bin/env python3
"""Bridge a ROS 2 PointCloud2 topic into a running WebPointCloud viewer.

Run this inside a sourced ROS 2 environment — it is the only piece that needs
rclpy, which is why it lives here and not in requirements.txt. The server never
imports it and never learns what ROS is:

    ros2_bridge.py  ──HTTP POST──▶  /api/live/publish  ──polled──▶  browser

    source /opt/ros/humble/setup.bash
    python3 tools/ros2_bridge.py --topic /velodyne_points

The viewer host and the robot need not be the same machine; point --url at
wherever app.py is listening.

── The two settings that decide whether this works ──
--qos best-effort (the default) is what almost every sensor driver publishes
  with. A RELIABLE subscriber receives nothing at all from a BEST_EFFORT
  publisher — no error, no warning, just silence — so the compatible default is
  the loose one. Use --qos reliable only for a latched map topic that needs it.
--max-points is a rendering budget, not a bandwidth one. A 128-beam lidar at
  10 Hz is ~2.4M points/s; the browser will not draw that and does not need to.

Everything else has a sane default.
"""

import argparse
import http.client
import json
import math
import struct
import sys
import threading
import time
import urllib.parse
import zlib

import numpy as np

# The decoding and downsampling below are plain numpy and are tested without a
# ROS install, so a missing rclpy is not fatal at import time — only running the
# bridge needs it (see main()).
try:
    import rclpy
    from rclpy.node import Node
    from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy, DurabilityPolicy
    from sensor_msgs.msg import PointCloud2
    ROS_IMPORT_ERROR = None
except ImportError as exc:                                   # pragma: no cover
    ROS_IMPORT_ERROR = exc
    Node = object


# ══════════════════════════════════════════════════════
#  PointCloud2 → numpy
# ══════════════════════════════════════════════════════
# sensor_msgs/PointField datatype constants → numpy types.
_PF_TYPES = {
    1: np.int8,    2: np.uint8,
    3: np.int16,   4: np.uint16,
    5: np.int32,   6: np.uint32,
    7: np.float32, 8: np.float64,
}


def cloud_to_arrays(msg):
    """Decode a PointCloud2 into (xyz, intensity, rgb) float arrays.

    Reads the layout out of `msg.fields` rather than assuming one, because
    every driver packs its own: XYZI from a lidar, XYZRGB from a depth camera,
    XYZ plus ring/time/label from anything doing perception. Building the numpy
    dtype from the declared offsets means the padding and the extra fields cost
    us nothing — the whole message is one `frombuffer`, no per-point Python.

    Returns (None, None, None) if the message has no usable xyz.
    """
    names = {f.name: f for f in msg.fields}
    if not {'x', 'y', 'z'} <= names.keys():
        return None, None, None

    # An itemsize of point_step keeps the unread bytes (padding, unwanted
    # fields) as dead space in the record, so offsets stay exactly as declared.
    order = '>' if msg.is_bigendian else '<'
    fields, formats, offsets = [], [], []
    for f in msg.fields:
        np_type = _PF_TYPES.get(f.datatype)
        if np_type is None or f.name in fields:
            continue          # unknown type, or a duplicate name numpy would reject
        fields.append(f.name)
        formats.append(np.dtype(np_type).newbyteorder(order))
        offsets.append(f.offset)
    dtype = np.dtype({'names': fields, 'formats': formats,
                      'offsets': offsets, 'itemsize': msg.point_step})

    n = msg.width * msg.height
    try:
        # rclpy hands over an array.array, which supports the buffer protocol —
        # so read it in place. bytes(msg.data) would copy the whole message
        # (64 MB for a dense 128-beam frame) before a single point is decoded.
        raw = np.frombuffer(msg.data, dtype=dtype, count=n)
    except (TypeError, AttributeError, BufferError):
        raw = np.frombuffer(bytes(msg.data), dtype=dtype, count=n)

    xyz = np.stack([raw['x'], raw['y'], raw['z']], axis=1).astype(np.float32)

    # Organized clouds (depth cameras, and lidars with unreturned beams) mark
    # missing measurements as NaN. Rendering those puts the whole cloud's
    # bounding box at NaN and the camera fit with it.
    finite = np.isfinite(xyz).all(axis=1)
    if not finite.all():
        xyz = xyz[finite]
        raw = raw[finite]

    intensity = None
    for key in ('intensity', 'i', 'reflectivity'):
        if key in fields:
            intensity = raw[key].astype(np.float32)
            break

    rgb = _extract_rgb(raw, fields)
    return xyz, intensity, rgb


def _extract_rgb(raw, fields):
    """Pull per-point colour out of whichever encoding the publisher used.

    PCL packs RGB as three bytes inside a float32 — a float whose bit pattern
    is an integer, which is why this reinterprets rather than converts.
    """
    if 'rgb' in fields or 'rgba' in fields:
        key = 'rgb' if 'rgb' in fields else 'rgba'
        col = raw[key]
        if col.dtype.kind == 'f':
            # Reinterpret the bits, keeping the message's byte order — viewing
            # a big-endian float as native uint32 would shuffle the channels.
            packed = col.view(np.dtype('u4').newbyteorder(col.dtype.byteorder))
        else:
            packed = col.astype(np.uint32)
        r = (packed >> 16) & 0xFF
        g = (packed >> 8) & 0xFF
        b = packed & 0xFF
        return np.stack([r, g, b], axis=1).astype(np.float32) / 255.0
    if {'r', 'g', 'b'} <= set(fields):
        rgb = np.stack([raw['r'], raw['g'], raw['b']], axis=1).astype(np.float32)
        # uint8 channels are 0..255; float channels are already 0..1.
        return rgb / 255.0 if rgb.max(initial=0) > 1.5 else rgb
    return None


# ══════════════════════════════════════════════════════
#  Downsampling
# ══════════════════════════════════════════════════════
def voxel_downsample(xyz, intensity, rgb, size):
    """Keep one point per voxel — the honest way to thin a dense map cloud.

    Hashes the integer voxel coordinates into one int64 key so the dedup is a
    1-D `np.unique`; `np.unique(xyz, axis=0)` on the raw floats is an order of
    magnitude slower and would not survive a 10 Hz budget.
    """
    keys = np.floor(xyz / size).astype(np.int64)
    # Large primes: a linear combination collides far less than bit-packing
    # would once coordinates exceed the bits allotted per axis.
    flat = keys[:, 0] * 73856093 ^ keys[:, 1] * 19349663 ^ keys[:, 2] * 83492791
    _, idx = np.unique(flat, return_index=True)
    return (xyz[idx],
            intensity[idx] if intensity is not None else None,
            rgb[idx] if rgb is not None else None)


def stride_downsample(xyz, intensity, rgb, max_points):
    """Take every k-th point. Cheap, and keeps a scan's sweep structure."""
    n = len(xyz)
    if n <= max_points:
        return xyz, intensity, rgb
    step = math.ceil(n / max_points)
    return (xyz[::step],
            intensity[::step] if intensity is not None else None,
            rgb[::step] if rgb is not None else None)


# ══════════════════════════════════════════════════════
#  Publisher (HTTP side)
# ══════════════════════════════════════════════════════
class Publisher:
    """Posts frames to the viewer from its own thread, newest-frame-only.

    The ROS callback must never block on HTTP: a slow POST would back up the
    subscriber queue and every frame after it would arrive late, so latency
    grows without bound while the picture stays behind. Instead the callback
    drops the frame into a single-slot mailbox, and this thread sends whatever
    is in the slot when it gets there. Overwriting an unsent frame is the
    correct behaviour for a live view — the newer frame is strictly better.

    Poses go through a second slot rather than being posted inline. They arrive
    on a different callback than the clouds, and http.client connections are not
    thread-safe: two threads sharing one connection interleave a request with
    the other's response and every send after that fails with ResponseNotReady.
    Keeping every send on this one thread is what makes the shared keep-alive
    connection safe.
    """

    def __init__(self, url, token, timeout=5.0):
        parts = urllib.parse.urlsplit(url if '://' in url else 'http://' + url)
        self._host = parts.hostname or 'localhost'
        self._port = parts.port or (443 if parts.scheme == 'https' else 80)
        self._https = parts.scheme == 'https'
        self._token = token
        self._timeout = timeout
        self._conn = None

        self._slot = None
        self._pose_slot = None
        self._cv = threading.Condition()
        self._stop = False
        self.sent = 0
        self.dropped = 0
        self.failed = 0
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    # ── connection ──
    def _connect(self):
        if self._conn is None:
            cls = (http.client.HTTPSConnection if self._https
                   else http.client.HTTPConnection)
            self._conn = cls(self._host, self._port, timeout=self._timeout)
        return self._conn

    def _drop_connection(self):
        try:
            if self._conn:
                self._conn.close()
        except Exception:
            pass
        self._conn = None

    def _request(self, path, body, headers):
        """One POST, with a single retry on a dead keep-alive connection.

        The connection is kept open across frames — at 10 Hz a fresh TCP
        handshake per frame is pure latency — but the server may have closed an
        idle one, and that shows up as an error on the *next* send rather than
        at close time. Retrying once turns that into a hiccup instead of a
        reported failure.
        """
        if self._token:
            headers = dict(headers, **{'X-Live-Token': self._token})
        for attempt in (0, 1):
            try:
                conn = self._connect()
                conn.request('POST', path, body=body, headers=headers)
                resp = conn.getresponse()
                data = resp.read()
                if resp.status >= 400:
                    return False, f"HTTP {resp.status}: {data[:200].decode('utf-8', 'replace')}"
                return True, None
            except (http.client.HTTPException, OSError) as exc:
                self._drop_connection()
                if attempt:
                    return False, str(exc)
        return False, 'unreachable'

    # ── frame queue ──
    def offer(self, payload, points, stream, layer, compressed):
        with self._cv:
            if self._slot is not None:
                self.dropped += 1
            self._slot = (payload, points, stream, layer, compressed)
            self._cv.notify()

    def offer_pose(self, matrix, stream):
        with self._cv:
            self._pose_slot = (list(matrix), stream)
            self._cv.notify()

    def _run(self):
        while True:
            with self._cv:
                while self._slot is None and self._pose_slot is None and not self._stop:
                    self._cv.wait(0.5)
                if self._stop and self._slot is None:
                    return
                frame, self._slot = self._slot, None
                pose, self._pose_slot = self._pose_slot, None

            if pose is not None:
                matrix, stream = pose
                # Pose first: it is a few hundred bytes, and sending it ahead of
                # a megabyte of points keeps the marker in step with the cloud.
                self._request('/api/live/pose?stream=' + urllib.parse.quote(stream, safe=''),
                              json.dumps({'matrix': matrix}).encode(),
                              {'Content-Type': 'application/json'})
            if frame is None:
                continue

            payload, points, stream, layer, compressed = frame
            query = urllib.parse.urlencode({
                'stream': stream, 'layer': layer,
                'points': points, 'compressed': '1' if compressed else '0'})
            ok, err = self._request('/api/live/publish?' + query, payload,
                                    {'Content-Type': 'application/octet-stream',
                                     'Content-Length': str(len(payload))})
            if ok:
                self.sent += 1
            else:
                self.failed += 1
                # Log every failure while nothing is getting through, then back
                # off: a viewer that is simply down should not fill the console
                # at 10 lines a second.
                if self.failed <= 3 or self.failed % 50 == 0:
                    print(f"[bridge] publish failed ({self.failed}): {err}", file=sys.stderr)

    def stop(self):
        with self._cv:
            self._stop = True
            self._cv.notify()
        self._thread.join(timeout=2.0)
        self._drop_connection()


# ══════════════════════════════════════════════════════
#  ROS node
# ══════════════════════════════════════════════════════
class BridgeNode(Node):

    def __init__(self, args):
        super().__init__('webpointcloud_bridge')
        self.args = args
        self.pub = Publisher(args.url, args.token)
        self.stream = args.stream or args.topic.lstrip('/')
        self._last_sent = 0.0
        self._min_period = 1.0 / args.rate if args.rate > 0 else 0.0
        self._intensity_scale = 1.0
        self._frames = 0
        self._warned_no_intensity = False

        qos = QoSProfile(
            depth=1,          # a live view wants the newest frame, never a backlog
            history=HistoryPolicy.KEEP_LAST,
            reliability=(ReliabilityPolicy.RELIABLE if args.qos == 'reliable'
                         else ReliabilityPolicy.BEST_EFFORT),
            durability=(DurabilityPolicy.TRANSIENT_LOCAL if args.transient_local
                        else DurabilityPolicy.VOLATILE),
        )
        self.create_subscription(PointCloud2, args.topic, self._on_cloud, qos)
        self.get_logger().info(
            f"subscribed to {args.topic} (qos={args.qos}) → {args.url} "
            f"stream='{self.stream}' layer={args.layer}")

        if args.odom:
            from nav_msgs.msg import Odometry
            self.create_subscription(Odometry, args.odom, self._on_odom, 10)
            self.get_logger().info(f"pose from {args.odom} (nav_msgs/Odometry)")
        elif args.pose:
            from geometry_msgs.msg import PoseStamped
            self.create_subscription(PoseStamped, args.pose, self._on_pose_stamped, 10)
            self.get_logger().info(f"pose from {args.pose} (geometry_msgs/PoseStamped)")

        self.create_timer(5.0, self._report)

    # ── cloud ──
    def _on_cloud(self, msg):
        now = time.monotonic()
        if self._min_period and now - self._last_sent < self._min_period:
            return                          # rate limit: skip, don't queue
        self._last_sent = now

        xyz, intensity, rgb = cloud_to_arrays(msg)
        if xyz is None:
            self.get_logger().warn(
                f"{self.args.topic} has no x/y/z fields — got "
                f"{[f.name for f in msg.fields]}", once=True)
            return
        if len(xyz) == 0:
            return

        if self.args.voxel > 0:
            xyz, intensity, rgb = voxel_downsample(xyz, intensity, rgb, self.args.voxel)
        xyz, intensity, rgb = stride_downsample(xyz, intensity, rgb, self.args.max_points)

        n = len(xyz)
        intensity = self._normalize_intensity(intensity, n)
        if rgb is None:
            # RGB mode would render an all-black cloud otherwise; grey by
            # intensity at least keeps the mode usable on a lidar stream.
            rgb = np.repeat(intensity[:, None], 3, axis=1)

        out = np.empty((n, 7), dtype='<f4')
        out[:, 0:3] = xyz
        out[:, 3] = intensity
        out[:, 4:7] = np.clip(rgb, 0.0, 1.0)
        payload = out.tobytes()

        compressed = self.args.compress > 0
        if compressed:
            payload = struct.pack('<I', len(payload)) + zlib.compress(payload, self.args.compress)

        self.pub.offer(payload, n, self.stream, self.args.layer, compressed)
        self._frames += 1

    def _normalize_intensity(self, intensity, n):
        """Scale intensity to the 0..1 the viewer's shaders expect.

        Auto mode tracks a decaying running maximum instead of normalizing each
        frame by its own max. Per-frame normalization makes the whole cloud
        change brightness whenever one bright return appears or leaves — the
        picture flickers even though the scene is static. Decay still lets the
        scale come back down after driving out of a bright area.
        """
        if intensity is None:
            if not self._warned_no_intensity:
                self._warned_no_intensity = True
                self.get_logger().info(
                    "no intensity field — use the Height or RGB colour mode")
            return np.zeros(n, dtype=np.float32)

        if self.args.intensity_max > 0:
            scale = self.args.intensity_max
        else:
            frame_max = float(intensity.max(initial=1.0))
            self._intensity_scale = max(frame_max, self._intensity_scale * 0.98, 1e-3)
            scale = self._intensity_scale
        return np.clip(intensity / scale, 0.0, 1.0)

    # ── pose ──
    def _on_odom(self, msg):
        self._send_pose(msg.pose.pose)

    def _on_pose_stamped(self, msg):
        self._send_pose(msg.pose)

    def _send_pose(self, pose):
        p, q = pose.position, pose.orientation
        self.pub.offer_pose(quat_to_matrix(q.x, q.y, q.z, q.w, p.x, p.y, p.z),
                            self.stream)

    # ── stats ──
    def _report(self):
        if self._frames == 0 and self.pub.sent == 0:
            self.get_logger().warn(
                f"nothing received on {self.args.topic} yet — check the topic name and "
                f"try --qos {'best-effort' if self.args.qos == 'reliable' else 'reliable'}")
            return
        self.get_logger().info(
            f"frames={self._frames} sent={self.pub.sent} "
            f"skipped={self.pub.dropped} failed={self.pub.failed}")

    def destroy_node(self):
        self.pub.stop()
        super().destroy_node()


def quat_to_matrix(x, y, z, w, tx, ty, tz):
    """Quaternion + translation → a 16-float column-major matrix.

    Column-major because the browser hands it straight to THREE.Matrix4's
    fromArray(), which reads columns.
    """
    n = math.sqrt(x*x + y*y + z*z + w*w) or 1.0
    x, y, z, w = x/n, y/n, z/n, w/n
    return [
        1 - 2*(y*y + z*z), 2*(x*y + z*w),     2*(x*z - y*w),     0.0,
        2*(x*y - z*w),     1 - 2*(x*x + z*z), 2*(y*z + x*w),     0.0,
        2*(x*z + y*w),     2*(y*z - x*w),     1 - 2*(x*x + y*y), 0.0,
        tx,                ty,                tz,                1.0,
    ]


def main():
    ap = argparse.ArgumentParser(
        description='Stream a ROS 2 PointCloud2 topic into WebPointCloud.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  # a lidar driver's raw scan
  ros2_bridge.py --topic /velodyne_points

  # a SLAM map cloud, thinned to 5 cm, with the robot pose
  ros2_bridge.py --topic /map_cloud --layer map --voxel 0.05 --odom /odom

  # accumulate keyframe clouds into one growing map instead of replacing
  ros2_bridge.py --topic /keyframe_cloud --layer kfrm --rate 2

  # viewer on another machine
  ros2_bridge.py --topic /points --url http://192.168.1.20:6001""")
    ap.add_argument('--topic', required=True, help='PointCloud2 topic to subscribe to')
    ap.add_argument('--url', default='http://localhost:6001',
                    help='WebPointCloud server (default: %(default)s)')
    ap.add_argument('--stream', default='',
                    help='name shown in the viewer (default: the topic name)')
    ap.add_argument('--layer', default='cur', choices=('cur', 'raw', 'map', 'kfrm'),
                    help="cur/raw/map replace the cloud each frame; kfrm accumulates "
                         "(default: %(default)s)")
    ap.add_argument('--rate', type=float, default=10.0,
                    help='max frames published per second, 0 = every frame '
                         '(default: %(default)s)')
    ap.add_argument('--max-points', type=int, default=400000,
                    help='thin to at most this many points per frame (default: %(default)s)')
    ap.add_argument('--voxel', type=float, default=0.0,
                    help='voxel size in metres to thin by before --max-points, '
                         '0 = off (default: %(default)s)')
    ap.add_argument('--intensity-max', type=float, default=0.0,
                    help='intensity value that maps to full brightness; '
                         '0 = track it automatically (default: %(default)s)')
    ap.add_argument('--compress', type=int, default=1, choices=range(0, 10),
                    metavar='0-9', help='zlib level, 0 = off (default: %(default)s)')
    ap.add_argument('--qos', default='best-effort', choices=('best-effort', 'reliable'),
                    help='must match the publisher, or nothing arrives '
                         '(default: %(default)s)')
    ap.add_argument('--transient-local', action='store_true',
                    help='for latched topics that publish a map once')
    ap.add_argument('--odom', default='', help='nav_msgs/Odometry topic for the pose marker')
    ap.add_argument('--pose', default='', help='geometry_msgs/PoseStamped topic for the pose marker')
    ap.add_argument('--token', default='',
                    help='X-Live-Token, if the server sets WPC_LIVE_TOKEN')
    args = ap.parse_args()

    if ROS_IMPORT_ERROR is not None:
        sys.exit(f"{ROS_IMPORT_ERROR}\n\nThis script runs inside a ROS 2 environment:\n"
                 "    source /opt/ros/humble/setup.bash   # or your distro\n"
                 "    python3 tools/ros2_bridge.py --topic /your_cloud")

    rclpy.init()
    node = BridgeNode(args)
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
