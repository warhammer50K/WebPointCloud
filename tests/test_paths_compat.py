"""Path defaults must not relocate an existing install.

The maps directory and the session secret both moved under DATA_DIR for new
installs. Doing that to a machine that already had them would empty the map
list and log every session out, so these pin the compatibility behaviour.
"""
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config
import security


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A throwaway $HOME with config/security reloaded against it."""
    h = tmp_path / 'home'
    h.mkdir()
    monkeypatch.setenv('HOME', str(h))
    monkeypatch.setenv('USERPROFILE', str(h))       # expanduser on Windows
    monkeypatch.delenv('WPC_DATA_DIR', raising=False)
    monkeypatch.delenv('WPC_MAPS_DIR', raising=False)
    monkeypatch.delenv('FLASK_SECRET_KEY', raising=False)
    yield h
    # Other tests import these modules; hand them back their real values.
    importlib.reload(config)
    importlib.reload(security)


def reload_all():
    importlib.reload(config)
    importlib.reload(security)


# ═══════════════════════════════════════════════════
#  Maps directory
# ═══════════════════════════════════════════════════

def test_existing_home_maps_stays_the_default(home):
    """The old unconditional default. An install that has one keeps it —
    switching to a new empty directory is indistinguishable from data loss."""
    (home / 'maps').mkdir()
    reload_all()
    assert config.MAPS_DIR == str(home / 'maps')


def test_fresh_install_uses_the_data_dir(home):
    reload_all()
    assert config.MAPS_DIR == os.path.join(str(home / 'webpointcloud'), 'maps')


def test_env_override_wins_over_both(home, tmp_path, monkeypatch):
    (home / 'maps').mkdir()
    monkeypatch.setenv('WPC_MAPS_DIR', str(tmp_path / 'elsewhere'))
    reload_all()
    assert config.MAPS_DIR == str(tmp_path / 'elsewhere')


def test_fresh_install_adds_one_entry_to_home(home):
    reload_all()
    os.makedirs(config.MAPS_DIR, exist_ok=True)
    os.makedirs(config.LOG_DIR, exist_ok=True)
    security.load_or_create_secret_key()
    assert os.listdir(home) == ['webpointcloud']


# ═══════════════════════════════════════════════════
#  Session secret
# ═══════════════════════════════════════════════════

def test_legacy_key_is_read_in_place_and_left_alone(home):
    legacy = home / '.mapper_secret_key'
    legacy.write_text('legacykey123')
    reload_all()
    assert security.load_or_create_secret_key() == 'legacykey123'
    # Not moved, not copied, not deleted: a rollback must still find it.
    assert legacy.exists()
    assert not os.path.exists(config.SECRET_KEY_PATH)


def test_fresh_install_writes_under_data_dir_with_0600(home):
    reload_all()
    key = security.load_or_create_secret_key()
    assert len(key) == 48
    assert oct(os.stat(config.SECRET_KEY_PATH).st_mode)[-3:] == '600'
    assert not (home / '.mapper_secret_key').exists()


def test_key_is_stable_across_calls(home):
    reload_all()
    assert security.load_or_create_secret_key() == security.load_or_create_secret_key()


def test_env_key_beats_every_file(home):
    (home / '.mapper_secret_key').write_text('legacykey123')
    os.environ['FLASK_SECRET_KEY'] = 'from-the-environment'
    try:
        reload_all()
        assert security.load_or_create_secret_key() == 'from-the-environment'
    finally:
        del os.environ['FLASK_SECRET_KEY']
