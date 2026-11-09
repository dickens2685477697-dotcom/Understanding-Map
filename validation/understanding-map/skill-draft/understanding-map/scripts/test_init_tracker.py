import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('init_tracker.py')
spec = importlib.util.spec_from_file_location('init_tracker', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class InitTrackerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'private'

    def test_new_config_private_and_idempotent(self):
        first = module.initialize(self.root, 'thread-01')
        config = Path(first['config_path'])
        original = config.read_bytes()
        payload = json.loads(original)
        self.assertTrue(first['created'])
        self.assertEqual(payload['interval'], 5)
        self.assertEqual(set(payload), {'version','session_id','interval','state_file','view_file','view_access_token','panel_url'})
        self.assertEqual(payload['panel_url'], 'http://127.0.0.1:18766/' + payload['view_access_token'] + '/live-panel.html')
        self.assertNotIn(payload['view_access_token'], json.dumps(first))
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        self.assertEqual(config.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse(Path(payload['state_file']).exists())
        self.assertFalse(Path(payload['view_file']).exists())
        second = module.initialize(self.root, 'thread-01', 9)
        self.assertFalse(second['created'])
        self.assertEqual(config.read_bytes(), original)

    def test_sessions_are_isolated(self):
        a = module.initialize(self.root, 'thread-A')
        b = module.initialize(self.root, 'thread-B')
        self.assertNotEqual(a['config_path'], b['config_path'])
        a_data = json.loads(Path(a['config_path']).read_text())
        b_data = json.loads(Path(b['config_path']).read_text())
        self.assertNotEqual(a_data['state_file'], b_data['state_file'])
        self.assertNotEqual(a_data['view_file'], b_data['view_file'])
        self.assertNotEqual(a_data['view_access_token'], b_data['view_access_token'])

    def test_invalid_identifiers_and_intervals(self):
        for value in ('../escape', '.', '..', 'a/b', 'a\\b', '', 'a b', '中文'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                module.initialize(self.root, value)
        for interval in (0, -1, True):
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                module.initialize(self.root, 's1', interval)
        self.assertFalse((self.root.parent / 'escape').exists())

    def test_legacy_match_keeps_existing_configuration_unchanged(self):
        self.root.mkdir()
        legacy = self.root / 'tracking.json'
        data = {'version':1, 'session_id':'s1', 'interval':3, 'state_file':'/private/state',
                'view_file':'/private/view', 'view_access_token':'SENTINEL_SECRET'}
        legacy.write_text(json.dumps(data))
        before = legacy.read_bytes()
        result = module.initialize(self.root, 's1')
        self.assertEqual(result, {'config_path':str(legacy.resolve()), 'created':False, 'legacy':True})
        self.assertNotIn('SENTINEL_SECRET', json.dumps(result))
        self.assertEqual(legacy.read_bytes(), before)
        self.assertFalse((self.root / 'sessions').exists())

    def test_legacy_other_session_is_preserved(self):
        self.root.mkdir()
        legacy = self.root / 'tracking.json'
        legacy.write_text(json.dumps({'version':1,'session_id':'old','interval':5,'state_file':'a','view_file':'b'}))
        before = legacy.read_bytes()
        new = module.initialize(self.root, 'new')
        self.assertTrue(new['created'])
        self.assertEqual(legacy.read_bytes(), before)
        self.assertIn('/sessions/new/', new['config_path'])

    def test_rejects_symbolic_session_directory(self):
        (self.root / 'sessions').mkdir(parents=True)
        outside = Path(self.tmp.name) / 'outside'
        outside.mkdir()
        (self.root / 'sessions' / 's1').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            module.initialize(self.root, 's1')
        self.assertEqual(list(outside.iterdir()), [])

    def test_cli_rejects_missing_or_mismatched_trusted_identity(self):
        env = dict(os.environ)
        env.pop('CODEX_THREAD_ID', None)
        missing = subprocess.run([sys.executable, str(SCRIPT), '--directory', str(self.root)], env=env, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        env['CODEX_THREAD_ID'] = 'current'
        mismatch = subprocess.run([sys.executable, str(SCRIPT), '--directory', str(self.root), '--session-id', 'other'], env=env, capture_output=True, text=True)
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertFalse(self.root.exists())
        okay = subprocess.run([sys.executable, str(SCRIPT), '--directory', str(self.root)], env=env, capture_output=True, text=True)
        self.assertEqual(okay.returncode, 0, okay.stderr)
        self.assertTrue(json.loads(okay.stdout)['created'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
