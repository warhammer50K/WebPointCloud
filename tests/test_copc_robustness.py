"""COPC reader pool and conversion ladder failure paths."""
import os
import shutil
import sys
import threading
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import copc_io

SAMPLE_COPC = os.path.join(ROOT, 'sample/copc/building_utm.copc.laz')
SAMPLE_LAS = os.path.join(ROOT, 'sample/building_utm.las')


def test_pool_waiter_survives_its_entry_going_stale():
    """A waiter at the pool cap used to block forever once the entry was
    evicted: borrowers of a stale entry close their handles, never return them."""
    entry = dict(copc_io.open_copc(SAMPLE_COPC), pool_max=1, pool_count=0)
    import queue
    entry['reader_pool'] = queue.Queue()
    entry['lock'] = threading.Lock()
    entry['thread_readers'] = []
    held, release, done = threading.Event(), threading.Event(), threading.Event()

    def holder():
        with copc_io._borrow_reader(entry):
            held.set()
            release.wait()

    def waiter():
        with copc_io._borrow_reader(entry):
            done.set()

    threading.Thread(target=holder, daemon=True).start()
    held.wait()
    threading.Thread(target=waiter, daemon=True).start()
    time.sleep(0.1)
    entry['stale'] = True
    release.set()
    assert done.wait(5)


@pytest.fixture
def src(tmp_path, monkeypatch):
    real_which = shutil.which
    monkeypatch.setattr(copc_io.shutil, 'which',
                        lambda n: '/fake/untwine' if n == 'untwine' else real_which(n))
    p = tmp_path / 'a.las'
    shutil.copy(SAMPLE_LAS, p)
    return p


def test_untwine_failure_falls_back_to_other_tools(src, monkeypatch):
    def fail(*_a, **_k):
        raise RuntimeError('untwine failed (exit 1)')
    monkeypatch.setattr(copc_io, '_run_untwine', fail)
    out = copc_io.ensure_copc(str(src))
    assert copc_io.is_copc(out)
    assert sorted(os.listdir(src.parent)) == ['a.copc.laz', 'a.las']


def test_untwine_killed_does_not_fall_back(src, monkeypatch):
    """OOM-killed: the in-memory tools would only fare worse."""
    def killed(*_a, **_k):
        raise copc_io._UntwineKilled('untwine failed (exit -9)')
    monkeypatch.setattr(copc_io, '_run_untwine', killed)
    with pytest.raises(copc_io._UntwineKilled):
        copc_io.ensure_copc(str(src))
    assert os.listdir(src.parent) == ['a.las']
