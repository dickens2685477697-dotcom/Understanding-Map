"""Portable-package checks. Never enter a native UI navigation path."""
import contextlib
import hashlib
import importlib.util
from io import BytesIO
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent))
ARCHIVE = ROOT.parent / 'releases/Understanding-Map-0.2.0-test.1.zip'


class DistributionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='map-recipient-')
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.home = self.folder.resolve() / 'recipient home 测试'
        with zipfile.ZipFile(ARCHIVE) as archive:
            archive.extractall(self.folder / 'unpacked folder')
        self.package = next((self.folder / 'unpacked folder').iterdir())
        self.skill = self.home / '.agents/skills/understanding-map'

    def installer(self, action='install', *extra):
        return subprocess.run([sys.executable, str(self.package / 'install.py'), action,
                               '--home', str(self.home), *extra], capture_output=True, text=True)

    def test_install_is_relocatable_and_repeatable_without_personal_data(self):
        first = self.installer()
        self.assertEqual(first.returncode, 0, first.stderr)
        marker = (self.skill / 'release.json').read_bytes()
        self.assertEqual(self.installer().returncode, 0)
        self.assertEqual((self.skill / 'release.json').read_bytes(), marker)
        env = dict(os.environ, CODEX_THREAD_ID='11111111-1111-4111-8111-111111111111',
                   UNDERSTANDING_MAP_HOME=str(self.home / 'private maps'))
        result = subprocess.run([sys.executable, str(self.skill / 'scripts/portable.py'), 'init'],
                                capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        config = Path(json.loads(result.stdout)['config_path'])
        self.assertTrue(config.is_relative_to(self.home / 'private maps'))
        self.assertFalse(any(self.package.rglob('tracking.json')))
        self.assertFalse(any(self.skill.rglob('tracking.json')))

    def test_existing_skill_requires_explicit_update_and_backup_is_outside_discovery(self):
        self.assertEqual(self.installer().returncode, 0)
        (self.skill / 'custom.txt').write_text('keep my local customization')
        (self.skill / 'release.json').write_text('{"version":"old"}')
        self.assertNotEqual(self.installer().returncode, 0)
        self.assertTrue((self.skill / 'custom.txt').exists())
        updated = self.installer('install', '--update')
        self.assertEqual(updated.returncode, 0, updated.stderr)
        backups = list((self.home / '.understanding-map/backups').iterdir())
        self.assertEqual((backups[0] / 'custom.txt').read_text(), 'keep my local customization')
        self.assertEqual(len(list((self.home / '.agents/skills').glob('*/SKILL.md'))), 1)

    def test_legacy_skill_is_preserved(self):
        legacy = self.home / '.codex/skills/understanding-map'
        legacy.mkdir(parents=True)
        (legacy / 'SKILL.md').write_text('existing user skill')
        self.assertNotEqual(self.installer().returncode, 0)
        self.assertEqual((legacy / 'SKILL.md').read_text(), 'existing user skill')

    def test_archive_contains_only_program_assets_and_no_host_identifiers(self):
        forbidden_names = {'tracking.json', 'state.json', 'map-view.json', '.DS_Store'}
        with zipfile.ZipFile(ARCHIVE) as archive:
            for name in archive.namelist():
                self.assertNotIn(Path(name).name, forbidden_names)
                self.assertNotIn('__pycache__', name)
                self.assertNotIn(str(Path.home()), archive.read(name).decode('utf-8', errors='ignore'))
                if name.endswith('.command'):
                    self.assertTrue((archive.getinfo(name).external_attr >> 16) & 0o111)
        for required in ('01-Install.command', '01-Install.cmd', '02-Start.command', '02-Start.cmd', 'START-HERE.txt'):
            self.assertTrue((self.package / required).is_file())

    def test_service_identity_distinguishes_another_installation_and_a_port_collision(self):
        spec = importlib.util.spec_from_file_location('portable_test', ROOT / 'portable.py')
        portable = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(portable)
        directory = self.home / 'data'
        value = {'service':'understanding-map', 'native_enabled':True,
                 'adapter_revision':7,
                 'refresh_enabled':True, 'refresh_revision':1,
                 'data_id':hashlib.sha256(str(directory.resolve()).encode()).hexdigest()[:16]}
        with patch.object(portable, 'urlopen', return_value=BytesIO(json.dumps(value).encode())):
            self.assertTrue(portable.service_status(directory)['ready'])
        value['data_id'] = 'different installation'
        with patch.object(portable, 'urlopen', return_value=BytesIO(json.dumps(value).encode())):
            self.assertFalse(portable.service_status(directory)['ready'])
        with patch.object(portable, 'urlopen', side_effect=HTTPError('local',404,'not found',{},None)):
            self.assertEqual(portable.service_status(directory), {'ready':False,'port_in_use':True})

    def test_windows_request_validation_without_loading_windows_ui(self):
        executable = self.package / 'payload/understanding-map/assets/windows/MapNavigator.exe'
        request = {'version':1, 'thread_id':'11111111-1111-4111-8111-111111111111',
                   'scope':'current_window', 'role':'user', 'user_position':1,
                   'captured_user_count':2, 'anchors':['这是可以检索的原文片段'],
                   'excluded_origins':['http://127.0.0.1:18766']}
        result = subprocess.run(['mono', str(executable), '--validate-request'],
                                input=json.dumps(request).encode(), capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'valid_request')
        request['scope'] = 'other_window'
        result = subprocess.run(['mono', str(executable), '--validate-request'],
                                input=json.dumps(request).encode(), capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_health_reports_identity_without_exposing_a_data_path(self):
        sys.path.insert(0, str(ROOT.parent))
        import preview_server
        directory = self.home / 'private data'
        handler_type = preview_server.make_handler(directory)
        handler = handler_type.__new__(handler_type)
        handler.path = '/health'
        value = {}
        handler.send_json = lambda result, status=200: value.update(result)
        handler.do_GET()
        self.assertEqual(value['service'], 'understanding-map')
        self.assertFalse(value['native_enabled'])
        self.assertEqual(value['data_id'], hashlib.sha256(str(directory.resolve()).encode()).hexdigest()[:16])
        self.assertNotIn(str(directory), json.dumps(value))

    def test_tracker_and_publisher_work_without_posix_fchmod(self):
        scripts = ROOT.parent / 'skill-draft/understanding-map/scripts'
        sys.path.insert(0, str(scripts))
        import init_tracker
        import publish_view
        sid = '11111111-1111-4111-8111-111111111111'
        with patch.dict(os.__dict__):
            os.__dict__.pop('fchmod', None)
            result = init_tracker.initialize(self.home / 'windows-like-data', sid)
            config = json.loads(Path(result['config_path']).read_text())
            state = Path(config['state_file'])
            state.write_text(json.dumps({'version':1,'sessions':{sid:{'nodes':[],'topics':[]}}}))
            published = publish_view.publish(state, Path(config['view_file']), sid)
            self.assertEqual(published['node_count'], 0)


if __name__ == '__main__':
    unittest.main()
