import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('plugin_backend', Path(__file__).resolve().parents[1] / 'backend.py')
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)


class Reader:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def call(self, method, params):
        return {'thread': {'id': params['threadId']}}


class BackendTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        env = patch.dict(os.environ, {'UNDERSTANDING_MAP_HOME': str(self.root)})
        env.start()
        self.addCleanup(env.stop)
        reader = patch.object(backend, 'CodexReader', Reader)
        reader.start()
        self.addCleanup(reader.stop)
        self.service = backend.Backend()
        self.sessions = {}

    def open_map(self, sid):
        result = self.service.dispatch({'action': 'open', 'thread_id': sid})
        self.sessions[sid] = result['session']
        path = self.root / 'sessions' / sid / 'tracking.json'
        config = json.loads(path.read_text())
        Path(config['view_file']).write_text(json.dumps({'nodes': [], 'marker': sid}))
        return path

    def request(self, sid, resource, **extra):
        return {'action': 'request', 'thread_id': sid, 'session': self.sessions[sid], 'resource': resource, **extra}

    def test_views_are_bound_to_the_opened_chat(self):
        self.open_map('chat-a')
        self.open_map('chat-b')
        for sid in ('chat-a', 'chat-b'):
            value = self.service.dispatch(self.request(sid, 'map-view.json'))
            self.assertEqual(value['body']['marker'], sid)
        with self.assertRaises(ValueError):
            self.service.dispatch({**self.request('chat-a', 'map-view.json'), 'thread_id': 'chat-b'})

    def test_reopening_preserves_existing_configuration_and_view(self):
        path = self.open_map('chat-a')
        before = path.read_bytes()
        self.service.dispatch({'action': 'open', 'thread_id': 'chat-a'})
        self.assertEqual(path.read_bytes(), before)
        value = self.service.dispatch(self.request('chat-a', 'map-view.json'))
        self.assertEqual(value['body']['marker'], 'chat-a')

    def test_refresh_reuses_existing_job_manager(self):
        path = self.open_map('chat-a')
        with patch.object(self.service.jobs, 'start', return_value={'status': 'running'}) as start:
            value = self.service.dispatch(self.request('chat-a', 'refresh'))
        self.assertEqual(value['status'], 202)
        self.assertEqual(start.call_args.args[0], path)

    def test_rejects_unlisted_resources_and_invalid_nodes(self):
        self.open_map('chat-a')
        for resource in ('state.json', '../tracking.json', 'http://localhost/'):
            with self.assertRaises(ValueError):
                self.service.dispatch(self.request('chat-a', resource))
        with self.assertRaises(ValueError):
            self.service.dispatch(self.request('chat-a', 'navigate'))

    def test_restored_panel_can_read_and_refresh_after_worker_restart(self):
        path = self.open_map('chat-a')
        restored = backend.Backend()
        value = restored.dispatch(self.request('chat-a', 'map-view.json'))
        self.assertEqual(value['body']['marker'], 'chat-a')
        with patch.object(restored.jobs, 'start', return_value={'status': 'checking'}) as start:
            result = restored.dispatch(self.request('chat-a', 'refresh'))
        self.assertEqual(result['status'], 202)
        self.assertEqual(start.call_args.args[0], path)

    def test_old_in_memory_connection_is_reported_as_expired(self):
        self.open_map('chat-a')
        request = {**self.request('chat-a', 'refresh'), 'session': '00000000-0000-4000-8000-000000000001'}
        with self.assertRaises(backend.MapSessionExpired):
            backend.Backend().dispatch(request)


if __name__ == '__main__':
    unittest.main()
