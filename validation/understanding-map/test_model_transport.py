import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import Mock, patch

import map_refresh as refresh


class SummaryTransportTests(unittest.TestCase):
    def run_summary(self, events, failure=None):
        def execute(command, **options):
            self.assertIn('--json', command)
            def communicate(input, timeout):
                self.assertEqual(timeout, 300)
                for event in events:
                    options['stdout'].write((json.dumps(event) + '\n').encode())
                options['stdout'].flush()
                if failure:
                    raise failure
                Path(command[command.index('-o') + 1]).write_text('{"topics":[],"messages":[]}')
            return Mock(returncode=0, communicate=communicate)
        with patch.object(refresh, 'codex_binary', return_value='fixture-codex'), \
             patch.object(refresh, 'summary_transport_args', return_value=[]), \
             patch.object(refresh.subprocess, 'Popen', side_effect=execute), \
             patch.object(refresh, 'stop_summary_process'):
            return refresh.summarize({'turns': [], 'nodes': []}, [])

    def test_success_keeps_the_structured_summary(self):
        self.assertEqual(self.run_summary([]), {'topics': [], 'messages': []})

    def test_timeout_retains_only_an_error_category(self):
        for message, code in [('401 Unauthorized for private-token', 'model_auth_failed'),
                              ('429 rate limit exceeded', 'model_rate_limited'),
                              ('stream disconnected: error sending request to private-url', 'model_connection_failed'),
                              ('model is still generating', 'model_timeout')]:
            with self.subTest(code=code):
                with self.assertRaises(refresh.UpdateError) as captured:
                    self.run_summary([{'type': 'error', 'message': message}], subprocess.TimeoutExpired('codex', 300))
                self.assertEqual(str(captured.exception), code)

    def test_agent_text_cannot_be_mistaken_for_a_connection_error(self):
        with self.assertRaisesRegex(refresh.UpdateError, '^model_timeout$'):
            self.run_summary([{'type': 'item.completed', 'item': {'text': '401 Unauthorized error sending request'}}],
                             subprocess.TimeoutExpired('codex', 300))

    def test_failed_turn_is_classified_without_exposing_details(self):
        event = {'type': 'turn.failed', 'error': {'message': 'TLS certificate failure for private-url'}}
        with self.assertRaisesRegex(refresh.UpdateError, '^model_connection_failed$'):
            self.run_summary([event], subprocess.TimeoutExpired('codex', 300))

    def test_windows_timeout_cleans_up_the_cli_process_tree(self):
        process = Mock(pid=42)
        with patch.object(refresh.sys, 'platform', 'win32'), \
             patch.object(refresh.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            refresh.stop_summary_process(process)
        self.assertEqual(run.call_args.args[0], ['taskkill', '/pid', '42', '/t', '/f'])
        process.communicate.assert_called_once_with(timeout=5)

    def test_failed_windows_tree_cleanup_falls_back_to_the_direct_child(self):
        process = Mock(pid=42)
        with patch.object(refresh.sys, 'platform', 'win32'), \
             patch.object(refresh.subprocess, 'run', side_effect=FileNotFoundError()):
            refresh.stop_summary_process(process)
        process.kill.assert_called_once()
        process.communicate.assert_called_once_with(timeout=5)


if __name__ == '__main__':
    unittest.main()
