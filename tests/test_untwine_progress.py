"""untwine --progress_fd stream parsing and phase mapping (no untwine binary needed)."""
import io
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from copc_io import _read_untwine_messages


def _progress(pct, msg):
    b = msg.encode()
    return struct.pack('=iII', 1000, pct, len(b)) + b


def _error(msg):
    b = msg.encode()
    return struct.pack('=iI', 1001, len(b)) + b


def _parse(data):
    prog, errs = [], []
    _read_untwine_messages(io.BytesIO(data), lambda p, t: prog.append((p, t)), errs.append)
    return prog, errs


def test_parses_progress_and_error_messages():
    data = _progress(1, 'Processed 100 points') + _progress(40, 'x') + _error('boom')
    prog, errs = _parse(data)
    assert prog == [(1, 'Processed 100 points'), (40, 'x')]
    assert errs == ['boom']


def test_truncated_stream_stops_cleanly():
    data = _progress(5, 'ok') + _progress(6, 'cut off')[:-3]
    prog, errs = _parse(data)
    assert prog == [(5, 'ok')]
    assert errs == []


def test_unknown_message_id_stops_parsing():
    data = _progress(5, 'ok') + struct.pack('=i', 42) + _progress(6, 'after')
    prog, _ = _parse(data)
    assert prog == [(5, 'ok')]
