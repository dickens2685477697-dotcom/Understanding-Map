#!/usr/bin/env python3
"""Exercise a complete synthetic 5-turn checkpoint and summary publication."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
SCRIPTS = ROOT / 'skill-draft' / 'understanding-map' / 'scripts'


def call(script, args, payload):
    result = subprocess.run(['python3', str(SCRIPTS / script), *args],
                            input=json.dumps(payload, ensure_ascii=False),
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


class IncrementalWorkflow(unittest.TestCase):
    def test_five_completed_turns_then_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            state, view = str(Path(tmp) / 'state.json'), str(Path(tmp) / 'view.json')
            turns = []
            nodes = []
            for i in range(6):
                tid, uid, aid = f't{i}', f'u{i}', f'a{i}'
                turns.append({'id': tid, 'status': 'completed', 'items': [
                    {'id': uid, 'type': 'userMessage', 'content': [{'type': 'text', 'text': f'private-user-{i}'}]},
                    {'id': aid, 'type': 'agentMessage', 'phase': 'final_answer', 'text': f'private-assistant-{i}'}]})
                nodes.extend([
                    {'id': f'n{uid}', 'turn_id': tid, 'message_id': uid, 'role': 'user', 'summary': f'用户摘要{i}', 'parent_ids': [], 'source_ids': [uid]},
                    {'id': f'n{aid}', 'turn_id': tid, 'message_id': aid, 'role': 'assistant', 'summary': f'回复摘要{i}', 'parent_ids': [f'n{uid}'], 'source_ids': [aid]}])
            initial = call('map_state.py', ['ingest', '--state', state], {'session_id': 'test', 'turns': turns[:1]})
            self.assertEqual(initial['due_reason'], 'initial')
            call('map_state.py', ['apply', '--state', state], {'session_id': 'test', 'turn_ids': [turns[0]['id']], 'nodes': nodes[:2]})
            first = call('map_state.py', ['ingest', '--state', state], {'session_id': 'test', 'turns': turns[1:5]})
            self.assertFalse(first['due'])
            fifth = call('map_state.py', ['ingest', '--state', state], {'session_id': 'test', 'turns': turns[5:]})
            self.assertTrue(fifth['due'])
            self.assertEqual(fifth['due_reason'], 'threshold')
            self.assertEqual(fifth['pending_count'], 5)
            call('map_state.py', ['apply', '--state', state], {'session_id': 'test', 'turn_ids': [t['id'] for t in turns[1:]], 'nodes': nodes[2:]})
            published = subprocess.run(['python3', str(SCRIPTS / 'publish_view.py'), '--state', state, '--view', view, '--session-id', 'test'], text=True, capture_output=True, check=True)
            self.assertEqual(json.loads(published.stdout)['node_count'], 12)
            raw = Path(view).read_text(encoding='utf-8')
            self.assertNotIn('private-user', raw)
            self.assertEqual(len(json.loads(raw)['nodes']), 12)
            again = call('map_state.py', ['ingest', '--state', state], {'session_id': 'test', 'turns': turns})
            self.assertEqual(again['pending_count'], 0)
            self.assertFalse(again['due'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
