import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from init_tracker import initialize
from publish_view import publish
from reopen_map import recover


class ReopenMapTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / 'private'
        result = initialize(self.root, 'session-a')
        self.config = Path(result['config_path'])
        config = json.loads(self.config.read_text())
        self.state = Path(config['state_file'])
        self.view = Path(config['view_file'])
        self.data = {'version': 1, 'sessions': {'session-a': {
            'turns': [{'text': 'PRIVATE ORIGINAL'}],
            'topics': [{'id': 'a', 'label': '产品', 'parent_id': None}],
            'nodes': [self.node('1'), self.node('2')],
        }}}
        self.write_state()
        publish(self.state, self.view, 'session-a')

    def node(self, number):
        return {'id': 'n' + number, 'turn_id': 't' + number,
                'message_id': 'm' + number, 'role': 'user',
                'summary': '摘要' + number, 'topic_id': 'a',
                'parent_ids': [], 'source_ids': ['m' + number]}

    def write_state(self):
        self.state.write_text(json.dumps(self.data, ensure_ascii=False), encoding='utf-8')

    def view_json(self):
        return json.loads(self.view.read_text(encoding='utf-8'))

    def test_intact_reopen_is_idempotent(self):
        before = self.state.read_bytes(), self.view.read_bytes(), self.config.read_bytes()
        for _ in range(2):
            result = recover(self.root, 'session-a')
            self.assertEqual((result['status'], result['node_count']), ('ready', 2))
            self.assertEqual((self.state.read_bytes(), self.view.read_bytes(),
                              self.config.read_bytes()), before)

    def test_missing_view_restores_summaries_without_private_original(self):
        self.view.unlink()
        state_before = self.state.read_bytes()
        result = recover(self.root, 'session-a')
        self.assertEqual((result['status'], result['node_count']), ('restored', 2))
        self.assertEqual(self.state.read_bytes(), state_before)
        self.assertEqual([n['id'] for n in self.view_json()['nodes']], ['n1', 'n2'])
        self.assertNotIn('PRIVATE ORIGINAL', self.view.read_text())

    def test_stale_view_gets_missing_nodes_and_updated_grouping(self):
        view = self.view_json()
        view['nodes'] = view['nodes'][:1]
        view['topics'][0]['label'] = '旧标题'
        self.view.write_text(json.dumps(view), encoding='utf-8')
        result = recover(self.root, 'session-a')
        self.assertEqual((result['status'], result['node_count']), ('restored', 2))
        self.assertEqual(self.view_json()['topics'][0]['label'], '产品')
        self.assertEqual([n['id'] for n in self.view_json()['nodes']], ['n1', 'n2'])

    def test_conflicting_view_preserves_both_files(self):
        for mutation in ('extra', 'changed'):
            with self.subTest(mutation=mutation):
                publish(self.state, self.view, 'session-a')
                view = self.view_json()
                if mutation == 'extra':
                    view['nodes'].append(self.node('3'))
                else:
                    view['nodes'][0]['summary'] = '不同摘要'
                self.view.write_text(json.dumps(view), encoding='utf-8')
                before = self.state.read_bytes(), self.view.read_bytes()
                with self.assertRaises(ValueError):
                    recover(self.root, 'session-a')
                self.assertEqual((self.state.read_bytes(), self.view.read_bytes()), before)

    def test_missing_state_preserves_view_and_no_saved_map_is_not_created(self):
        self.state.unlink()
        before = self.view.read_bytes()
        result = recover(self.root, 'session-a')
        self.assertEqual((result['status'], result['node_count']), ('view_only', 2))
        self.assertEqual(self.view.read_bytes(), before)
        self.view.unlink()
        self.assertEqual(recover(self.root, 'session-a')['status'], 'not_found')
        self.assertFalse(self.state.exists())
        self.assertFalse(self.view.exists())

    def test_other_sessions_and_cli_identity_are_isolated(self):
        self.assertEqual(recover(self.root, 'session-b')['status'], 'not_found')
        self.assertFalse((self.root / 'sessions' / 'session-b').exists())
        env = dict(os.environ, CODEX_THREAD_ID='session-a')
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('reopen_map.py')),
                                 '--directory', str(self.root), '--session-id', 'session-b'],
                                text=True, capture_output=True, env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / 'sessions' / 'session-b').exists())

    def test_view_symlink_is_rejected(self):
        self.view.unlink()
        self.view.symlink_to(self.state)
        before = self.state.read_bytes()
        with self.assertRaises(ValueError):
            recover(self.root, 'session-a')
        self.assertTrue(self.view.is_symlink())
        self.assertEqual(self.state.read_bytes(), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
