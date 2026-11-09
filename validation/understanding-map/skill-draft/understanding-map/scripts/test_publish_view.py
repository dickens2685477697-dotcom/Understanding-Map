import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('publish_view.py')


class PublishViewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.state = self.folder / 'state.json'
        self.view = self.folder / 'map-view.json'
        self.state.write_text(json.dumps({'version': 1, 'sessions': {
            'wanted': {'turns': [{'text': 'PRIVATE ORIGINAL'}], 'nodes': [{
                'id': 'n1', 'turn_id': 't1', 'message_id': 'm1', 'role': 'user',
                'summary': '节点摘要', 'parent_ids': [], 'source_ids': ['m1'],
                'unexpected_field': 'PRIVATE EXTRA'}]},
            'other': {'turns': [], 'nodes': [{'id': 'OTHER SESSION'}]}
        }}, ensure_ascii=False), encoding='utf-8')

    def publish(self, view=None, session='wanted'):
        return subprocess.run([sys.executable, str(SCRIPT), '--state', str(self.state),
                               '--view', str(view or self.view), '--session-id', session],
                              text=True, capture_output=True)

    def test_exports_only_requested_session_and_allowlisted_node_fields(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['node_count'], 1)
        content = self.view.read_text(encoding='utf-8')
        self.assertNotIn('PRIVATE ORIGINAL', content)
        self.assertNotIn('PRIVATE EXTRA', content)
        self.assertNotIn('OTHER SESSION', content)
        output = json.loads(content)
        self.assertEqual(output['session_id'], 'wanted')
        self.assertEqual(output['nodes'][0]['summary'], '节点摘要')
        self.assertEqual(stat.S_IMODE(self.view.stat().st_mode), 0o600)
        self.assertEqual(list(self.folder.glob('.map-view-*')), [])

    def test_failure_preserves_previous_view(self):
        self.view.write_text('previous', encoding='utf-8')
        self.assertNotEqual(self.publish(session='missing').returncode, 0)
        self.assertEqual(self.view.read_text(encoding='utf-8'), 'previous')

    def test_exports_topic_labels_without_extra_fields(self):
        data = json.loads(self.state.read_text(encoding='utf-8'))
        data['sessions']['wanted']['topics'] = [{'id':'a','label':'产品','parent_id':None,'extra':'PRIVATE TOPIC'}]
        data['sessions']['wanted']['nodes'][0]['topic_id'] = 'a'
        self.state.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
        self.assertEqual(self.publish().returncode, 0)
        content = self.view.read_text(encoding='utf-8')
        self.assertNotIn('PRIVATE TOPIC', content)
        out = json.loads(content)
        self.assertEqual(out['topics'], [{'id':'a','label':'产品','parent_id':None}])
        self.assertEqual(out['nodes'][0]['topic_id'], 'a')

    def test_refuses_to_overwrite_the_state_file(self):
        original = self.state.read_bytes()
        self.assertNotEqual(self.publish(view=self.state).returncode, 0)
        self.assertEqual(self.state.read_bytes(), original)
        alias = self.folder / 'state-hardlink.json'
        os.link(self.state, alias)
        self.assertNotEqual(self.publish(view=alias).returncode, 0)
        self.assertEqual(self.state.read_bytes(), original)

    def test_refuses_to_replace_a_symbolic_link(self):
        self.view.symlink_to(self.state)
        self.assertNotEqual(self.publish().returncode, 0)
        self.assertTrue(self.view.is_symlink())


if __name__ == '__main__':
    unittest.main(verbosity=2)
