"""Maps listing/rename/delete: both directory maps and loose files.

A bare Flask app with only api_bp registered — no security middleware, no
sample data, no server. MAPS_DIR is a tmp_path, so nothing touches $HOME.
"""
import os
import sys

import pytest
from flask import Flask

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from api import api_bp


@pytest.fixture
def maps_dir(tmp_path):
    d = tmp_path / 'maps'
    d.mkdir()
    return d


@pytest.fixture
def client(maps_dir):
    app = Flask(__name__)
    app.config['MAPS_DIR'] = str(maps_dir)
    app.register_blueprint(api_bp)
    return app.test_client()


def touch(path, size=64):
    """A file that is not a valid LAS — the listing reads headers best-effort
    and must report it as 0 points rather than dropping it or raising."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'\0' * size)


def by_name(entries):
    return {e['name']: e for e in entries}


# ═══════════════════════════════════════════════════
#  Listing
# ═══════════════════════════════════════════════════

def test_loose_file_is_listed(client, maps_dir):
    """The obvious first move — copy a cloud into the maps directory — used to
    produce an empty list, because only subdirectories were scanned."""
    touch(maps_dir / 'loose.las')
    entries = client.get('/api/maps').get_json()
    assert [e['name'] for e in entries] == ['loose.las']
    e = entries[0]
    assert e['is_file'] is True
    assert e['las_files'] == ['loose.las']
    # The client joins path + las_files[0]; that has to land on the file.
    assert os.path.join(e['path'], e['las_files'][0]) == str(maps_dir / 'loose.las')


def test_directory_map_still_listed_with_its_files(client, maps_dir):
    touch(maps_dir / 'run01' / 'map.las')
    touch(maps_dir / 'run01' / 'map.copc.laz')
    entries = client.get('/api/maps').get_json()
    assert [e['name'] for e in entries] == ['run01']
    e = entries[0]
    assert e['is_file'] is False
    assert e['las_files'] == ['map.copc.laz', 'map.las']
    assert e['path'] == str(maps_dir / 'run01')


def test_directories_sort_before_loose_files(client, maps_dir):
    touch(maps_dir / 'aaa.las')
    touch(maps_dir / 'zzz' / 'map.las')
    assert [e['name'] for e in client.get('/api/maps').get_json()] == ['zzz', 'aaa.las']


@pytest.mark.parametrize('name', ['notes.txt', 'cloud.ply', 'archive.zip', 'README'])
def test_non_map_files_are_ignored(client, maps_dir, name):
    touch(maps_dir / name)
    assert client.get('/api/maps').get_json() == []


def test_laz_and_copc_count_as_maps(client, maps_dir):
    touch(maps_dir / 'a.laz')
    touch(maps_dir / 'b.copc.laz')
    touch(maps_dir / 'c.LAS')                       # extension match is case-insensitive
    assert set(by_name(client.get('/api/maps').get_json())) == {'a.laz', 'b.copc.laz', 'c.LAS'}


def test_unreadable_header_reports_zero_points(client, maps_dir):
    touch(maps_dir / 'truncated.las', size=8)
    info = client.get('/api/maps').get_json()[0]['las_info'][0]
    assert info['num_points'] == 0 and info['size'] == 8


def test_missing_maps_dir_lists_empty(tmp_path):
    app = Flask(__name__)
    app.config['MAPS_DIR'] = str(tmp_path / 'does-not-exist')
    app.register_blueprint(api_bp)
    assert app.test_client().get('/api/maps').get_json() == []


# ═══════════════════════════════════════════════════
#  Delete / rename on a loose file
# ═══════════════════════════════════════════════════

def test_delete_loose_file(client, maps_dir):
    touch(maps_dir / 'loose.las')
    assert client.delete('/api/maps/loose.las').status_code == 200
    assert not (maps_dir / 'loose.las').exists()


def test_delete_leaves_the_copc_sidecar(client, maps_dir):
    """The conversion is a complete map with its own row in the list, so
    deleting the source must not take it along unasked."""
    touch(maps_dir / 'map.las')
    touch(maps_dir / 'map.copc.laz')
    assert client.delete('/api/maps/map.las').status_code == 200
    assert (maps_dir / 'map.copc.laz').exists()


def test_delete_directory_map_still_recurses(client, maps_dir):
    touch(maps_dir / 'run01' / 'map.las')
    assert client.delete('/api/maps/run01').status_code == 200
    assert not (maps_dir / 'run01').exists()


def test_delete_missing_is_404(client):
    assert client.delete('/api/maps/nope.las').status_code == 404


def test_rename_loose_file_carries_the_sidecar(client, maps_dir):
    """Renaming only the source would strand map.copc.laz: a stale row in the
    list, and a full re-conversion the next time the file is opened."""
    touch(maps_dir / 'map.las')
    touch(maps_dir / 'map.copc.laz')
    r = client.post('/api/maps/map.las/rename', json={'new_name': 'scan.las'})
    assert r.status_code == 200
    assert sorted(os.listdir(maps_dir)) == ['scan.copc.laz', 'scan.las']


def test_renaming_the_copc_itself_creates_no_second_sidecar(client, maps_dir):
    touch(maps_dir / 'map.copc.laz')
    assert client.post('/api/maps/map.copc.laz/rename',
                       json={'new_name': 'kept.copc.laz'}).status_code == 200
    assert os.listdir(maps_dir) == ['kept.copc.laz']


def test_rename_onto_existing_name_is_409(client, maps_dir):
    touch(maps_dir / 'a.las')
    touch(maps_dir / 'b.las')
    assert client.post('/api/maps/a.las/rename',
                       json={'new_name': 'b.las'}).status_code == 409


@pytest.mark.parametrize('bad', ['..', '.', 'a\\b'])
def test_traversal_names_are_still_rejected(client, maps_dir, bad):
    """Loose-file support widened what delete accepts from 'directory' to
    'anything'; the name check is what still holds the line."""
    assert client.delete(f'/api/maps/{bad}').status_code in (400, 404)
    assert client.post(f'/api/maps/{bad}/rename',
                       json={'new_name': 'x'}).status_code in (400, 404)


def test_symlink_out_of_maps_dir_cannot_be_deleted(client, maps_dir, tmp_path):
    outside = tmp_path / 'secret.las'
    outside.write_bytes(b'\0' * 8)
    (maps_dir / 'link.las').symlink_to(outside)
    assert client.delete('/api/maps/link.las').status_code == 400
    assert outside.exists()
