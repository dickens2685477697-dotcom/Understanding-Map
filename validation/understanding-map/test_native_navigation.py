"""Offline tests. No test invokes the native --navigate execution path."""
from email.message import Message
from io import BytesIO
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import native_navigation as navigation
import preview_server as server

SID = '11111111-1111-4111-8111-111111111111'


class NativeNavigationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.token = 'N' * 43
        self.turns = [
            {'id': 't1', 'messages': [
                {'id': 'u1', 'role': 'user', 'text': '继续'},
                {'id': 'a1', 'role': 'assistant', 'text': '第一条回复包含完整的来源文字。'}]},
            {'id': 't2', 'messages': [
                {'id': 'u2', 'role': 'user', 'text': '继续'},
                {'id': 'u3', 'role': 'user', 'text': '补充一条有不同含义的指令'},
                {'id': 'a2', 'role': 'assistant', 'text': '**有格式的原文**\n\n这是一段需要定位的回复正文。'}]},
        ]
        self.nodes = [
            {'id': 'nu1', 'turn_id': 't1', 'message_id': 'u1', 'role': 'user'},
            {'id': 'nu2', 'turn_id': 't2', 'message_id': 'u2', 'role': 'user'},
            {'id': 'na2', 'turn_id': 't2', 'message_id': 'a2', 'role': 'assistant'},
        ]
        (self.root / 'tracking.json').write_text(json.dumps({
            'session_id': SID, 'view_access_token': self.token,
            'view_file': str(self.root / 'map-view.json'),
            'state_file': str(self.root / 'state.json'),
        }))
        (self.root / 'state.json').write_text(json.dumps({
            'sessions': {SID: {'nodes': self.nodes, 'turns': self.turns}}
        }))

    def target(self, node):
        record = server.resolve_node_record(self.root, f'/{self.token}/node-source?id={node}')
        return navigation.build_target(record)

    def request(self, *, dry_run=False, helper=None, origin='http://127.0.0.1:18766',
                token=None, body=None, action='navigate'):
        # Instantiate without a socket, with the same handler methods and closure.
        cls = server.make_handler(self.root, native_helper=helper, dry_run=dry_run)
        handler = cls.__new__(cls)
        handler.path = f'/{token or self.token}/navigate'
        handler.server = SimpleNamespace(server_port=18766)
        data = body if isinstance(body, bytes) else json.dumps(body or {'node_id': 'nu2'}).encode()
        handler.rfile = BytesIO(data)
        handler.headers = Message()
        for k, v in {'Host': '127.0.0.1:18766', 'Origin': origin,
                     'Content-Type': 'application/json', 'Content-Length': str(len(data)),
                     'X-Understanding-Map-Action': action}.items():
            if v is not None:
                handler.headers[k] = v
        response = {}
        handler.send_error = lambda code: response.update(code=code)
        handler.send_json = lambda value, status=200: response.update(code=status, value=value)
        handler.do_POST()
        return response

    def test_repeated_user_messages_keep_their_ordinal(self):
        self.assertEqual(self.target('nu1')['user_position'], 1)
        self.assertEqual(self.target('nu2')['user_position'], 2)
        self.assertEqual(self.target('nu2')['captured_user_count'], 3)
        self.assertEqual(self.target('nu2')['scope'], 'current_window')
        self.assertEqual(self.target('nu2')['excluded_origins'], ['http://127.0.0.1:18766'])

    def test_reply_targets_its_own_latest_user_message(self):
        target = self.target('na2')
        self.assertEqual(target['user_position'], 3)
        self.assertEqual(target['message_id'], 'a2')
        self.assertTrue(any('这是一段需要定位' in anchor for anchor in target['anchors']))
        self.assertNotIn('**', ''.join(target['anchors']))

    def test_short_repeated_messages_use_their_own_paired_reply(self):
        first, second = self.target('nu1'), self.target('nu2')
        self.assertEqual(first['short_text'], '继续')
        self.assertEqual(second['short_text'], '继续')
        self.assertFalse(first['anchors'])
        self.assertFalse(second['anchors'])
        self.assertTrue(first['context_anchors'])
        self.assertTrue(second['context_anchors'])
        self.assertNotEqual(first['context_anchors'], second['context_anchors'])
        for target, index in ((first, 0), (second, 1)):
            paired = navigation.plain_text(self.turns[index]['messages'][-1]['text'])
            self.assertTrue(all(anchor in paired for anchor in target['context_anchors']))

    def test_short_context_never_uses_another_turn_or_a_repeated_fragment(self):
        turns = [{'id':'t1','messages':[{'id':'u1','role':'user','text':'继续'},
                  {'id':'a1','role':'assistant','text':'这是一段在两个回复中完全重复的上下文'}]},
                 {'id':'t2','messages':[{'id':'a2','role':'assistant','text':'这是一段在两个回复中完全重复的上下文。另一轮独有文字不能借用'}]}]
        self.assertEqual(navigation.context_anchors(turns, {'turn_id':'t1','role':'user'}), [])

    def test_structured_feedback_uses_the_visible_answer_as_its_source(self):
        state_path = self.root / 'state.json'
        state = json.loads(state_path.read_text())
        message = state['sessions'][SID]['turns'][0]['messages'][0]
        message['text'] = '<send_user_message_question_reply>\n' + json.dumps([
            {'question': '系统测试问题不应该成为原文查找片段', 'answer': '对应轮次和短消息都可见'}
        ], ensure_ascii=False) + '\n</send_user_message_question_reply>'
        state_path.write_text(json.dumps(state))
        record = server.resolve_node_record(self.root, f'/{self.token}/node-source?id=nu1')
        self.assertEqual(record[-1], '对应轮次和短消息都可见')
        self.assertEqual(navigation.build_target(record)['anchors'], ['对应轮次和短消息都可见'])

    def test_cross_origin_missing_headers_and_wrong_tokens_cannot_navigate(self):
        with patch.object(navigation, 'invoke_helper', side_effect=AssertionError('must not operate apps')):
            self.assertEqual(self.request(helper='/unused', origin='http://evil.test')['code'], 403)
            self.assertEqual(self.request(helper='/unused', origin=None)['code'], 403)
            self.assertEqual(self.request(helper='/unused', action=None)['code'], 403)
            self.assertEqual(self.request(helper='/unused', token='X' * 43)['code'], 404)
            self.assertEqual(self.request(helper='/unused', body={'node_id': 'missing'})['code'], 404)

    def test_duplicate_keys_and_extra_target_fields_are_rejected(self):
        with patch.object(navigation, 'invoke_helper', side_effect=AssertionError('must not operate apps')):
            self.assertEqual(self.request(body=b'{"node_id":"nu1","node_id":"nu2"}')['code'], 400)
            self.assertEqual(self.request(body={'node_id': 'nu2', 'thread_id': 'another'})['code'], 400)

    def test_normal_preview_never_runs_helper_and_dry_run_is_explicit(self):
        with patch.object(navigation, 'invoke_helper', side_effect=AssertionError('must not operate apps')):
            self.assertEqual(self.request()['code'], 503)
            response = self.request(dry_run=True)
            self.assertEqual(response['value']['status'], 'dry_run')
            self.assertFalse(response['value']['verified'])
            self.assertEqual(response['value']['user_position'], 2)

    def test_capabilities_declare_current_window_scope(self):
        cls = server.make_handler(self.root, dry_run=True)
        handler = cls.__new__(cls)
        handler.path = f'/{self.token}/native-navigation'
        response = {}
        handler.send_json = lambda value, status=200: response.update(value)
        handler.do_GET()
        self.assertEqual(response['navigation_scope'], 'current_window')
        self.assertEqual(response['mode'], 'dry_run')
        self.assertEqual(response['adapter_revision'], 7)

    def test_mocked_native_adapter_receives_only_server_resolved_target(self):
        with patch.object(navigation, 'invoke_helper', return_value={'status': 'turn_revealed', 'verified': False}) as run:
            response = self.request(helper='/configured/MapNavigator')
            self.assertEqual(response['value']['status'], 'turn_revealed')
            self.assertEqual(run.call_args.args[1]['thread_id'], SID)
            self.assertEqual(run.call_args.args[1]['message_id'], 'u2')

    def test_contradictory_helper_success_is_not_accepted(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        result = SimpleNamespace(stdout=b'{"status":"located","verified":false}', returncode=0)
        with patch.object(subprocess, 'run', return_value=result):
            self.assertEqual(navigation.invoke_helper(helper, self.target('nu2'))['status'], 'helper_failed')

    def test_find_statuses_preserve_method_without_claiming_success(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        for status, returncode in (('search_requested', 0), ('find_unavailable', 1),
                                   ('source_unsearchable', 1), ('context_revealed', 0)):
            with self.subTest(status=status):
                result = SimpleNamespace(stdout=json.dumps({
                    'status': status, 'verified': True, 'method': 'native_accessibility_find',
                }).encode(), returncode=returncode)
                with patch.object(subprocess, 'run', return_value=result):
                    response = navigation.invoke_helper(helper, self.target('nu2'))
                self.assertEqual(response['status'], status)
                self.assertEqual(response['method'], 'native_accessibility_find')
                self.assertFalse(response['verified'])

    def test_helper_methods_are_allowlisted(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        for method in (None, 'must not be returned', [], {'private': 'must not be returned'},
                       'native_accessibility_find', 'native_accessibility_rail'):
            with self.subTest(method=method):
                result = SimpleNamespace(stdout=json.dumps({
                    'status': 'located', 'verified': True, 'method': method,
                }).encode(), returncode=0)
                with patch.object(subprocess, 'run', return_value=result):
                    response = navigation.invoke_helper(helper, self.target('nu2'))
                expected = method if method in ('native_accessibility_find', 'native_accessibility_rail') else 'native_accessibility_rail'
                self.assertEqual(response['method'], expected)
                self.assertTrue(response['verified'])
                self.assertNotIn('must not be returned', json.dumps(response))

    def test_failed_process_cannot_claim_search_was_requested(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        result = SimpleNamespace(stdout=json.dumps({
            'status': 'search_requested', 'verified': False, 'method': 'native_accessibility_find',
        }).encode(), returncode=1)
        with patch.object(subprocess, 'run', return_value=result):
            self.assertEqual(navigation.invoke_helper(helper, self.target('nu2'))['status'], 'helper_failed')

    def test_protocol_failures_report_only_fixed_process_diagnostics(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        cases = (
            (b'private output' * 400, 0, 1, False),
            (b'', -11, 2, False),
            (b'', 0, 2, False),
            (b'private invalid JSON', 1, 2, False),
            (b'\xff', 1, 2, False),
            (b'[]', 0, 3, False),
            (b'{"status":"private status"}', 1, 4, False),
            (b'{"status":{"private":"status"}}', 1, 4, False),
            (b'{"status":"located","verified":false}', 0, 4, False),
            (b'{"status":"search_requested","verified":false}', 2, 5, True),
            (b'{"status":"chat_unverified","verified":false}', -20001, 5, True),
        )
        for stdout, returncode, error, response_valid in cases:
            with self.subTest(error=error, returncode=returncode, stdout_size=len(stdout)):
                result = SimpleNamespace(stdout=stdout, stderr=b'private stderr', returncode=returncode)
                with patch.object(subprocess, 'run', return_value=result):
                    response = navigation.invoke_helper(helper, self.target('nu2'))
                self.assertEqual(response, {
                    'status': 'helper_failed', 'verified': False,
                    'diagnostics': {
                        'protocol_error': error, 'helper_exit_code': min(abs(returncode), 12000),
                        'helper_crashed': returncode < 0, 'helper_output_empty': not bool(stdout),
                        'helper_response_valid': response_valid,
                    },
                })
                self.assertNotIn('private', json.dumps(response))

    def test_launch_failure_does_not_echo_exception_details(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        with patch.object(subprocess, 'run', side_effect=OSError('private launch failure')):
            response = navigation.invoke_helper(helper, self.target('nu2'))
        self.assertEqual(response, {
            'status': 'helper_failed', 'verified': False,
            'diagnostics': {'protocol_error': 6, 'helper_response_valid': False},
        })

    def test_nonzero_process_can_report_an_ordinary_native_failure(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        result = SimpleNamespace(stdout=b'{"status":"find_unavailable","verified":false}', returncode=1)
        with patch.object(subprocess, 'run', return_value=result):
            response = navigation.invoke_helper(helper, self.target('nu2'))
        self.assertEqual(response['status'], 'find_unavailable')
        self.assertFalse(response['verified'])

    def test_diagnostics_allow_only_counts_and_booleans(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        diagnostics = {
            'focused_window': True, 'native_pages': 2, 'readable_addresses': 1,
            'matching_pages': 0, 'scan_complete': True, 'window_conflict': False,
            'diagnostic_version': 2, 'eligible_pages': 1, 'inspected_pages': 1,
            'nested_pages': 1, 'readable_buttons': 48, 'labelled_buttons': 31,
            'rail_buttons': 0, 'target_buttons': 0, 'rail_nodes': 350,
            'rail_scan_complete': True, 'document_scan_complete': True,
            'manual_accessibility': True, 'file_address_pages': 0,
            'enhanced_accessibility': True, 'manual_accessibility_error': 25205,
            'unknown_address_pages': 1,
            'ax_read_errors': 2,
            'find_triggered': True, 'chat_scope_found': False, 'find_input_found': False,
            'query_written': False, 'search_candidates': 0,
            'chat_scope_pressed': True, 'chat_scope_selected': False, 'find_stage': 5,
            'find_fields': 2, 'chat_named_fields': 0, 'field_scan_complete': True, 'field_read_errors': 0,
            'field_nodes': 35, 'focused_find_field': True,
            'browser_named_fields': 1, 'scope_keyboard_attempted': True, 'scope_keyboard_activated': False,
        }
        result = SimpleNamespace(stdout=json.dumps({
            'status': 'chat_unverified', 'verified': False,
            'diagnostics': dict(diagnostics, private_url='must not be returned',
                                source_text='must not be returned'),
        }).encode(), returncode=1)
        with patch.object(subprocess, 'run', return_value=result):
            response = navigation.invoke_helper(helper, self.target('nu2'))
        self.assertEqual(response['diagnostics'], diagnostics)
        self.assertNotIn('must not be returned', json.dumps(response))

    def test_invalid_diagnostic_values_are_not_returned(self):
        helper = self.root / 'mock-helper'
        helper.write_text('not executed')
        for invalid in ('private value', None, [], {}, 1.5, -1, 12001):
            with self.subTest(value=invalid):
                result = SimpleNamespace(stdout=json.dumps({
                    'status': 'chat_unverified', 'verified': False,
                    'diagnostics': {'diagnostic_version': 2, 'manual_accessibility': True,
                                    'readable_buttons': invalid, 'unknown_address_pages': invalid,
                                    'find_triggered': invalid, 'chat_scope_found': invalid,
                                    'find_input_found': invalid, 'query_written': invalid,
                                    'search_candidates': invalid,
                                    'private_url': 'must not be returned'},
                }).encode(), returncode=1)
                with patch.object(subprocess, 'run', return_value=result):
                    response = navigation.invoke_helper(helper, self.target('nu2'))
                self.assertEqual(response['diagnostics'],
                                 {'diagnostic_version': 2, 'manual_accessibility': True})

    def test_compiled_surface_selection_regressions_without_native_apis(self):
        helper = Path(__file__).parent / 'native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator'
        if not helper.exists():
            self.skipTest('build the helper first')
        result = subprocess.run([str(helper), '--test-surface-selection'],
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout)['status'], 'self_test_passed')

    def test_compiled_helper_validation_only_never_enters_native_path(self):
        helper = Path(__file__).parent / 'native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator'
        if not helper.exists():
            self.skipTest('build the helper first')
        target = self.target('nu2')
        result = subprocess.run([str(helper), '--validate-request'],
                                input=json.dumps(target).encode(), capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(json.loads(result.stdout)['status'], 'valid_request')
        target['thread_id'] = 'invalid'
        result = subprocess.run([str(helper), '--validate-request'],
                                input=json.dumps(target).encode(), capture_output=True, timeout=5)
        self.assertEqual(json.loads(result.stdout)['status'], 'invalid_request')


if __name__ == '__main__':
    unittest.main(verbosity=2)
