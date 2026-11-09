"""Network-free tests for private token-scoped preview route resolution."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

BASE = Path(__file__).resolve().parent


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


server = load_module('preview_server', BASE / 'preview_server.py')
tracker = load_module('init_tracker', BASE / 'skill-draft/understanding-map/scripts/init_tracker.py')


class PreviewRoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / 'private'
        self.root.mkdir(mode=0o700)
        self.panel = Path(self.tmp.name).resolve() / 'panel.html'
        self.panel.write_text('test panel', encoding='utf-8')

    def make_session(self, sid):
        info = tracker.initialize(self.root, sid)
        config_path = Path(info['config_path'])
        config = json.loads(config_path.read_text(encoding='utf-8'))
        Path(config['view_file']).write_text(json.dumps({'session':sid}), encoding='utf-8')
        return config_path, config

    def resolve(self, token, resource):
        return server.resolve_resource(self.root, f'/{token}/{resource}', self.panel)

    def test_existing_legacy_is_preserved_and_served(self):
        token = 'A' * 43
        view = self.root / 'map-view.json'
        view.write_text('{"session":"legacy"}')
        config = self.root / 'tracking.json'
        config.write_text(json.dumps({'session_id':'legacy','view_file':str(view),'view_access_token':token}))
        before = config.read_bytes()
        self.assertEqual(self.resolve(token,'map-view.json')[0], view)
        self.assertEqual(self.resolve(token,'live-panel.html')[0], self.panel)
        self.assertEqual(config.read_bytes(), before)

    def test_two_sessions_resolve_only_their_own_views(self):
        _, a = self.make_session('session-a')
        _, b = self.make_session('session-b')
        self.assertNotEqual(a['view_access_token'], b['view_access_token'])
        path_a = self.resolve(a['view_access_token'], 'map-view.json')[0]
        path_b = self.resolve(b['view_access_token'], 'map-view.json')[0]
        self.assertEqual(json.loads(path_a.read_text())['session'], 'session-a')
        self.assertEqual(json.loads(path_b.read_text())['session'], 'session-b')
        self.assertIsNone(self.resolve('X' * 43, 'map-view.json'))
        self.assertIsNone(self.resolve(a['view_access_token'], 'state.json'))
        self.assertIsNone(server.resolve_resource(self.root, '/map-view.json', self.panel))
        self.assertIsNone(server.resolve_resource(self.root, f'/{a["view_access_token"]}/../state.json', self.panel))

    def test_modified_config_is_seen_without_restart(self):
        path, a = self.make_session('a')
        self.assertIsNotNone(self.resolve(a['view_access_token'], 'map-view.json'))
        new_token = 'Z' * 43
        a['view_access_token'] = new_token
        path.write_text(json.dumps(a))
        self.assertIsNone(self.resolve(a['panel_url'].split('/')[3], 'map-view.json'))
        self.assertIsNotNone(self.resolve(new_token, 'map-view.json'))

    def test_outside_session_view_and_state_alias_are_rejected(self):
        path, a = self.make_session('a')
        token = a['view_access_token']
        outside = self.root / 'outside.json'
        outside.write_text('sensitive')
        a['view_file'] = str(outside)
        path.write_text(json.dumps(a))
        self.assertIsNone(self.resolve(token, 'map-view.json'))
        a['view_file'] = str(path.parent / 'map-view.json')
        view = Path(a['view_file'])
        view.unlink()
        view.symlink_to(outside)
        path.write_text(json.dumps(a))
        self.assertIsNone(self.resolve(token, 'map-view.json'))
        view.unlink()
        os.link(outside, view)
        self.assertIsNone(self.resolve(token, 'map-view.json'))

    def test_duplicate_tokens_and_linked_configs_are_rejected(self):
        _, a = self.make_session('a')
        path_b, b = self.make_session('b')
        token = a['view_access_token']
        b['view_access_token'] = token
        path_b.write_text(json.dumps(b))
        self.assertIsNone(self.resolve(token, 'map-view.json'))
        path_b.unlink()
        path_b.symlink_to(self.root / 'sessions' / 'a' / 'tracking.json')
        self.assertIsNotNone(self.resolve(token, 'map-view.json'))

    def test_malformed_or_mismatched_session_config_is_ignored(self):
        path, config = self.make_session('a')
        token = config['view_access_token']
        config['session_id'] = 'another'
        path.write_text(json.dumps(config))
        self.assertIsNone(self.resolve(token, 'map-view.json'))
        path.write_text('{')
        self.assertIsNone(self.resolve(token, 'map-view.json'))

    def test_node_source_is_session_scoped_and_strips_ui_metadata(self):
        _, a = self.make_session('a')
        _, b = self.make_session('b')
        state = {'sessions': {'a': {
            'nodes': [{'id':'node-a','turn_id':'turn-a','message_id':'msg-a','role':'user'}],
            'turns': [{'id':'turn-a','messages':[{'id':'msg-a','role':'user',
                'text':'<in-app-browser-context>private URL</in-app-browser-context>\n用户原文'}]}]
        }}}
        Path(a['state_file']).write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
        path = f'/{a["view_access_token"]}/node-source?id=node-a'
        self.assertEqual(server.resolve_node_source(self.root,path),
                         {'id':'node-a','role':'user','text':'用户原文'})
        self.assertIsNone(server.resolve_node_source(self.root,f'/{b["view_access_token"]}/node-source?id=node-a'))
        self.assertIsNone(server.resolve_node_source(self.root,f'/{a["view_access_token"]}/node-source?id=missing'))
        self.assertIsNone(server.resolve_node_source(self.root,f'/{a["view_access_token"]}/node-source?id=node-a&id=node-a'))

    def test_node_source_rejects_state_links_and_outside_paths(self):
        path, config = self.make_session('a')
        token = config['view_access_token']
        outside = self.root/'outside-state.json'
        outside.write_text('{}')
        state = Path(config['state_file'])
        state.symlink_to(outside)
        self.assertIsNone(server.resolve_node_source(self.root,f'/{token}/node-source?id=n1'))
        state.unlink()
        config['state_file'] = str(outside)
        path.write_text(json.dumps(config))
        self.assertIsNone(server.resolve_node_source(self.root,f'/{token}/node-source?id=n1'))

    def test_node_source_removes_annotation_envelope_for_search(self):
        _, a = self.make_session('a')
        state = {'sessions': {'a': {
            'nodes': [{'id':'node-a','turn_id':'turn-a','message_id':'msg-a','role':'user'}],
            'turns': [{'id':'turn-a','messages':[{'id':'msg-a','role':'user',
                'text':'# Response annotations:\n<response-annotations>untrusted metadata</response-annotations>\n\n## My request:\n这是没有问题的'}]}]
        }}}
        Path(a['state_file']).write_text(json.dumps(state,ensure_ascii=False),encoding='utf-8')
        path = f'/{a["view_access_token"]}/node-source?id=node-a'
        self.assertEqual(server.resolve_node_source(self.root,path)['text'],'这是没有问题的')


if __name__ == '__main__':
    unittest.main(verbosity=2)
