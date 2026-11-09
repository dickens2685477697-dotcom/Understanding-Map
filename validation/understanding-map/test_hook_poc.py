#!/usr/bin/env python3
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('hook_poc.py')


class HookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='map-hook-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = {'synthetic_test_event': True, 'session_id': 'synthetic-session', 'turn_id': 'synthetic-turn'}

    def call(self, event):
        return subprocess.run([sys.executable, str(SCRIPT), '--test-data-dir', self.temp.name],
                              input=json.dumps(event), text=True, capture_output=True, check=False)

    def rows(self):
        with sqlite3.connect(Path(self.temp.name) / 'synthetic-events.sqlite3') as db:
            return db.execute('SELECT event_type, text_value FROM events ORDER BY event_type').fetchall()

    def test_out_of_order_empty_stop_and_idempotency(self):
        stop = dict(self.base, hook_event_name='Stop', last_assistant_message=None)
        prompt = dict(self.base, hook_event_name='UserPromptSubmit', prompt='synthetic hello')
        for event in (stop, prompt, stop, prompt):
            result = self.call(event)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), '{}')
        self.assertEqual(self.rows(), [('Stop', None), ('UserPromptSubmit', 'synthetic hello')])

    def test_same_key_different_payload_is_not_silently_overwritten(self):
        original = dict(self.base, hook_event_name='Stop', last_assistant_message='synthetic first')
        other = dict(original, last_assistant_message='synthetic second')
        self.assertEqual(self.call(original).returncode, 0)
        result = self.call(other)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.rows(), [('Stop', 'synthetic first')])

    def test_real_event_without_synthetic_marker_is_rejected(self):
        event = dict(self.base, hook_event_name='UserPromptSubmit', prompt='synthetic text')
        del event['synthetic_test_event']
        self.assertNotEqual(self.call(event).returncode, 0)
        self.assertFalse((Path(self.temp.name) / 'synthetic-events.sqlite3').exists())

    def test_missing_stop_field_and_missing_turn_rejected(self):
        self.assertNotEqual(self.call(dict(self.base, hook_event_name='Stop')).returncode, 0)
        event = dict(self.base, hook_event_name='UserPromptSubmit', prompt='synthetic text')
        del event['turn_id']
        self.assertNotEqual(self.call(event).returncode, 0)

    def test_different_turns_do_not_mix(self):
        for turn in ('synthetic-turn-1', 'synthetic-turn-2'):
            event = dict(self.base, turn_id=turn, hook_event_name='UserPromptSubmit', prompt=turn)
            self.assertEqual(self.call(event).returncode, 0)
        self.assertEqual(len(self.rows()), 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
