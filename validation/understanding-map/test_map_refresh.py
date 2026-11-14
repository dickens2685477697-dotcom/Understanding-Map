import json
from io import BytesIO
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import map_refresh as refresh
import preview_server


def user(mid, text='一条用户消息'):
    return {'type': 'userMessage', 'id': mid, 'content': [{'type': 'text', 'text': text}]}


def turn(tid, items, status='inProgress'):
    return {'id': tid, 'status': status, 'items': items}


def model_result(session, pending):
    return {'topics': [], 'messages': [{'message_id': message['message_id'], 'summary': '摘要 ' + message['text'],
                                      'topic_id': None, 'intent': 'question', 'parent_message_ids': []} for message in pending]}


class RefreshTests(unittest.TestCase):
    def test_reader_identifies_cli_launch_failures(self):
        for failure, code in [(FileNotFoundError(), 'codex_missing'),
                              (PermissionError(), 'codex_permission'),
                              (OSError(), 'codex_start_failed')]:
            with self.subTest(code=code), \
                 patch.object(refresh, 'codex_binary', return_value='fixture-codex'), \
                 patch.object(refresh.subprocess, 'Popen', side_effect=failure):
                with self.assertRaisesRegex(refresh.UpdateError, code):
                    refresh.CodexReader().__enter__()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.config_path = self.folder / 'tracking.json'
        self.config = {'session_id': 'test-chat', 'state_file': str(self.folder / 'state.json'),
                       'view_file': str(self.folder / 'map-view.json')}
        self.config_path.write_text(json.dumps(self.config))
        self.progress = Mock()

    def update(self, turns, model=model_result):
        reader = Mock(return_value=turns)
        result = refresh.update_map(self.config_path, self.config, self.progress, reader, model)
        self.assertEqual(reader.call_args.args[0], 'test-chat')
        return result

    def session(self):
        return json.loads((self.folder / 'state.json').read_text())['sessions']['test-chat']

    def test_initial_history_is_saved_in_batches_with_cross_batch_topics_and_parents(self):
        snapshot = [turn(f't{i}', [user(f'u{i}')], 'completed') for i in range(17)]
        sizes = []
        def summarize_batch(session, pending):
            sizes.append(len(pending))
            result = model_result(session, pending)
            if len(sizes) == 1:
                result['topics'] = [{'id': 'history', 'label': '历史话题', 'parent_id': None}]
            else:
                self.assertEqual(len(session['nodes']), 16)
                self.assertEqual(len(self.session()['nodes']), 16)
                self.assertEqual(self.session()['processed_turn_ids'], [f't{i}' for i in range(16)])
                view = json.loads((self.folder / 'map-view.json').read_text())
                self.assertEqual(len(view['nodes']), 16)
                self.assertEqual(session['topics'][0]['id'], 'history')
                result['messages'][0]['parent_message_ids'] = ['u15']
            for row in result['messages']:
                row['topic_id'] = 'history'
            return result
        self.assertEqual(self.update(snapshot, summarize_batch), 17)
        self.assertEqual(sizes, [16, 1])
        self.assertEqual(self.session()['processed_turn_ids'], [f't{i}' for i in range(17)])
        self.assertEqual(self.session()['nodes'][-1]['parent_ids'], ['node-u15'])
        self.assertEqual(self.progress.call_args_list[-1].args, ('summarizing', 1))

    def test_later_batch_timeout_preserves_partial_turn_and_retry_only_summarizes_the_rest(self):
        snapshot = [turn('t1', [user(f'u{i}') for i in range(18)], 'completed')]
        calls = 0
        def fail_second_batch(session, pending):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise refresh.UpdateError('model_timeout')
            return model_result(session, pending)
        with self.assertRaisesRegex(refresh.UpdateError, 'model_timeout'):
            self.update(snapshot, fail_second_batch)
        saved = self.session()
        self.assertEqual(len(saved['nodes']), 16)
        self.assertEqual(len(saved['turns'][0]['messages']), 18)
        self.assertEqual(saved['processed_turn_ids'], [])
        self.assertEqual(len(json.loads((self.folder / 'map-view.json').read_text())['nodes']), 16)
        def finish_batch(session, pending):
            self.assertEqual([message['message_id'] for message in pending], ['u16', 'u17'])
            self.assertEqual(session['nodes'], saved['nodes'])
            result = model_result(session, pending)
            result['messages'][0]['parent_message_ids'] = ['u15']
            result['messages'][1]['parent_message_ids'] = ['u16']
            return result
        model = Mock(side_effect=finish_batch)
        self.assertEqual(self.update(snapshot, model), 2)
        self.assertEqual(self.session()['nodes'][:16], saved['nodes'])
        self.assertEqual(self.session()['processed_turn_ids'], ['t1'])
        self.assertEqual(self.session()['nodes'][-1]['parent_ids'], ['node-u16'])
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 1)

    def test_legacy_classification_batches_preserve_nodes_and_can_mix_with_new_messages(self):
        snapshot = [turn(f't{i}', [user(f'u{i}')], 'completed') for i in range(17)]
        self.update(snapshot)
        state = json.loads((self.folder / 'state.json').read_text())
        original = state['sessions']['test-chat']['nodes']
        for node in original:
            del node['intent']
        (self.folder / 'state.json').write_text(json.dumps(state))
        sizes = []
        def classify_batch(session, pending):
            sizes.append(len(pending))
            result = model_result(session, pending)
            if len(sizes) == 2:
                checkpoint = self.session()['nodes']
                self.assertTrue(all(node['intent'] == 'idea' for node in checkpoint[:16]))
                self.assertNotIn('intent', checkpoint[16])
                self.assertEqual([message['message_id'] for message in pending], ['u16', 'u17', 'u18'])
            for message, row in zip(pending, result['messages']):
                if 'existing_summary' in message:
                    row.update(intent='idea', summary='不应覆盖旧摘要', parent_message_ids=['unknown'])
                else:
                    row.update(intent='request', parent_message_ids=['u16'])
            return result
        snapshot.extend([turn('t17', [user('u17')]), turn('t18', [user('u18')])])
        self.assertEqual(self.update(snapshot, classify_batch), 2)
        self.assertEqual(sizes, [16, 3])
        self.assertEqual(self.session()['nodes'][:17], [{**node, 'intent': 'idea'} for node in original])
        self.assertEqual(self.session()['nodes'][-1]['parent_ids'], ['node-u16'])

    def test_external_state_change_in_a_later_batch_is_preserved(self):
        snapshot = [turn(f't{i}', [user(f'u{i}')], 'completed') for i in range(17)]
        calls = 0
        external = '{"external":"later update"}'
        def change_after_checkpoint(session, pending):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.assertEqual(len(self.session()['nodes']), 16)
                (self.folder / 'state.json').write_text(external)
            return model_result(session, pending)
        with self.assertRaisesRegex(refresh.UpdateError, 'state_changed'):
            self.update(snapshot, change_after_checkpoint)
        self.assertEqual((self.folder / 'state.json').read_text(), external)
        self.assertEqual(len(json.loads((self.folder / 'map-view.json').read_text())['nodes']), 16)

    def test_later_publish_failure_is_repaired_without_resummarizing_committed_batches(self):
        snapshot = [turn(f't{i}', [user(f'u{i}')], 'completed') for i in range(17)]
        publish = refresh.publish
        calls = 0
        def fail_second_publish(*args):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError('publisher unavailable')
            return publish(*args)
        with patch.object(refresh, 'publish', side_effect=fail_second_publish):
            with self.assertRaises(OSError):
                self.update(snapshot)
        self.assertEqual(len(self.session()['nodes']), 17)
        self.assertEqual(len(json.loads((self.folder / 'map-view.json').read_text())['nodes']), 16)
        model = Mock(side_effect=AssertionError('saved batches must be reused'))
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 0)
        self.assertEqual(len(json.loads((self.folder / 'map-view.json').read_text())['nodes']), 17)

    def test_in_progress_message_is_summarized_once_and_final_context_is_collected_later(self):
        snapshot = [turn('t1', [user('u1')])]
        model = Mock(side_effect=model_result)
        self.assertEqual(self.update(snapshot, model), 1)
        self.assertEqual(self.session()['processed_turn_ids'], [])
        snapshot[0]['status'] = 'completed'
        snapshot[0]['items'].append({'type': 'agentMessage', 'id': 'a1', 'phase': 'final', 'text': '最后的回复'})
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(len(self.session()['nodes']), 1)
        self.assertEqual(self.session()['processed_turn_ids'], ['t1'])
        self.assertEqual(self.session()['turns'][0]['messages'][-1]['text'], '最后的回复')
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 1)

    def test_new_message_in_an_already_seen_turn_gets_its_own_node(self):
        self.update([turn('t1', [user('u1')])])
        self.assertEqual(self.update([turn('t1', [user('u1'), user('u2', '同轮补充')])]), 1)
        self.assertEqual([node['message_id'] for node in self.session()['nodes']], ['u1', 'u2'])

    def test_idea_and_later_request_keep_their_own_intents_and_source_relation(self):
        def classify(session, pending):
            result = model_result(session, pending)
            for node in result['messages']:
                node['intent'] = 'idea' if node['message_id'] == 'idea' else 'request'
                node['parent_message_ids'] = [] if node['message_id'] == 'idea' else ['idea']
            return result
        self.update([turn('t1', [user('idea', '我想到可以给摘要增加标签')])], classify)
        original = self.session()['nodes'][0]
        self.update([turn('t2', [user('start', '开始做')])], classify)
        nodes = self.session()['nodes']
        self.assertEqual(nodes[0], original)
        self.assertEqual(nodes[1]['intent'], 'request')
        self.assertEqual(nodes[1]['parent_ids'], ['node-idea'])
        view = json.loads((self.folder / 'map-view.json').read_text())
        self.assertEqual([node['intent'] for node in view['nodes']], ['idea', 'request'])

    def test_legacy_intents_are_backfilled_once_without_rewriting_saved_nodes(self):
        snapshot = [turn('t1', [user('u1', '我有一个想法')], 'completed')]
        self.update(snapshot)
        state = json.loads((self.folder / 'state.json').read_text())
        original = state['sessions']['test-chat']['nodes'][0]
        del original['intent']
        before = dict(original)
        (self.folder / 'state.json').write_text(json.dumps(state))
        def classify(session, pending):
            self.assertEqual(pending[0]['existing_summary'], before['summary'])
            result = model_result(session, pending)
            result['messages'][0].update(intent='idea', summary='改写的摘要', topic_id='changed')
            return result
        model = Mock(side_effect=classify)
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(self.session()['nodes'][0], {**before, 'intent': 'idea'})
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 1)

    def test_invalid_intent_preserves_saved_state_and_uncertain_intent_is_not_retried(self):
        snapshot = [turn('t1', [user('u1')])]
        self.update(snapshot)
        before = (self.folder / 'state.json').read_bytes()
        def invalid(session, pending):
            result = model_result(session, pending)
            result['messages'][0]['intent'] = 'unknown'
            return result
        with self.assertRaisesRegex(refresh.UpdateError, 'invalid_summary'):
            self.update([turn('t2', [user('u2')])], invalid)
        self.assertEqual((self.folder / 'state.json').read_bytes(), before)
        def uncertain(session, pending):
            result = model_result(session, pending)
            result['messages'][0]['intent'] = None
            return result
        model = Mock(side_effect=uncertain)
        snapshot.append(turn('t2', [user('u2')]))
        self.update(snapshot, model)
        self.update(snapshot, model)
        self.assertEqual(model.call_count, 1)

    def test_bad_summary_or_changed_source_preserves_existing_files(self):
        self.update([turn('t1', [user('u1')], 'completed')])
        before = (self.folder / 'state.json').read_bytes()
        view = (self.folder / 'map-view.json').read_bytes()
        bad = Mock(return_value={'topics': [], 'messages': []})
        with self.assertRaises(refresh.UpdateError):
            self.update([turn('t2', [user('u2')])], bad)
        self.assertEqual((self.folder / 'state.json').read_bytes(), before)
        self.assertEqual((self.folder / 'map-view.json').read_bytes(), view)
        with self.assertRaisesRegex(refresh.UpdateError, 'source_changed'):
            self.update([turn('t1', [user('u1', '修改后的内容')], 'completed')])
        self.assertEqual((self.folder / 'state.json').read_bytes(), before)

    def test_invalid_or_forward_relationship_is_rejected(self):
        def bad(session, pending):
            result = model_result(session, pending)
            result['messages'][0]['parent_message_ids'] = ['u2']
            return result
        with self.assertRaises(refresh.UpdateError):
            self.update([turn('t1', [user('u1'), user('u2')])], bad)
        self.assertFalse((self.folder / 'state.json').exists())

    def test_existing_legacy_nodes_and_context_are_preserved(self):
        self.update([turn('t1', [user('u1')], 'completed')])
        state = json.loads((self.folder / 'state.json').read_text())
        session = state['sessions']['test-chat']
        session['nodes'].append({'id': 'node-a1', 'message_id': 'a1', 'turn_id': 't1', 'role': 'assistant',
                                 'summary': '历史 AI 摘要', 'parent_ids': ['node-u1'], 'source_ids': ['a1']})
        (self.folder / 'state.json').write_text(json.dumps(state))
        self.update([turn('t2', [user('u2')])])
        self.assertEqual([node['id'] for node in self.session()['nodes']], ['node-u1', 'node-a1', 'node-u2'])

    def test_publish_failure_can_be_repaired_without_resummarizing(self):
        model = Mock(side_effect=model_result)
        snapshot = [turn('t1', [user('u1')])]
        with patch.object(refresh, 'publish', side_effect=OSError('disk unavailable')):
            with self.assertRaises(OSError):
                self.update(snapshot, model)
        self.assertEqual(self.update(snapshot, model), 0)
        self.assertEqual(model.call_count, 1)
        self.assertEqual(len(json.loads((self.folder / 'map-view.json').read_text())['nodes']), 1)

    def test_concurrent_file_update_is_detected_before_commit(self):
        def change_state(session, pending):
            (self.folder / 'state.json').write_text('{"external":"update"}')
            return model_result(session, pending)
        with self.assertRaisesRegex(refresh.UpdateError, 'state_changed'):
            self.update([turn('t1', [user('u1')])], change_state)
        self.assertEqual(json.loads((self.folder / 'state.json').read_text()), {'external': 'update'})

    def test_process_lock_prevents_overlapping_updates(self):
        with refresh.update_lock(self.folder):
            with self.assertRaisesRegex(refresh.UpdateError, 'busy'):
                self.update([turn('t1', [user('u1')])])

    def test_refresh_jobs_are_scoped_and_deduplicate_reloads(self):
        entered, finish = threading.Event(), threading.Event()
        def updater(path, config, progress):
            progress('summarizing', 1)
            entered.set()
            finish.wait(2)
            return 1
        update = Mock(side_effect=updater)
        jobs = refresh.RefreshJobs(update)
        first = jobs.start(self.config_path, self.config)
        self.assertTrue(entered.wait(1))
        second = jobs.start(self.config_path, self.config)
        self.assertEqual(first['id'], second['id'])
        self.assertEqual(jobs.status(self.folder / 'other.json'), {'status': 'idle'})
        finish.set()
        deadline = time.monotonic() + 2
        while jobs.status(self.config_path)['status'] == 'summarizing' and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(jobs.status(self.config_path)['status'], 'updated')
        self.assertEqual(update.call_count, 1)

    def test_model_input_removes_host_metadata_and_local_capability(self):
        token = 'a' * 43
        text = '<external_browser_tabs><in-app-browser-context>http://127.0.0.1:18766/' + token + '/live-panel.html</in-app-browser-context></external_browser_tabs>\n实际问题'
        cleaned = refresh.clean_text(text)
        self.assertNotIn(token, cleaned)
        self.assertIn('实际问题', cleaned)
        self.assertNotIn('external_browser_tabs', cleaned)
        ordinary = '示例\n## My request: 保留整个输入'
        self.assertEqual(refresh.clean_text(ordinary), ordinary)
        malformed = '<send_user_message_question_reply>不是 JSON</send_user_message_question_reply>'
        self.assertEqual(refresh.clean_text(malformed), malformed)

    def test_refresh_http_requires_same_origin_and_resolves_chat_from_token(self):
        token = 'a' * 43
        self.config.update(view_access_token=token)
        self.config_path.write_text(json.dumps(self.config))
        jobs = Mock()
        jobs.start.return_value = {'status': 'checking'}
        jobs.status.return_value = {'status': 'updated', 'added_messages': 1}
        handler_type = preview_server.make_handler(self.folder, refresh_jobs=jobs)
        handler = handler_type.__new__(handler_type)
        handler.server = Mock(server_port=18766)
        handler.path = '/' + token + '/refresh'
        handler.headers = {'Host': '127.0.0.1:18766', 'Origin': 'http://127.0.0.1:18766',
                           'X-Understanding-Map-Action': 'refresh', 'Content-Type': 'application/json',
                           'Content-Length': '2'}
        handler.rfile = BytesIO(b'{}')
        handler.send_json = Mock()
        handler.send_error = Mock()
        handler.do_POST()
        jobs.start.assert_called_once()
        self.assertEqual(jobs.start.call_args.args[1]['session_id'], 'test-chat')
        handler.send_json.assert_called_with({'status': 'checking'}, 202)
        handler.path = '/' + token + '/refresh-status'
        handler.do_GET()
        handler.send_json.assert_called_with({'status': 'updated', 'added_messages': 1})
        handler.path = '/' + token + '/refresh'
        handler.headers['Origin'] = 'http://other.example'
        handler.do_POST()
        handler.send_error.assert_called_with(403)
        self.assertEqual(jobs.start.call_count, 1)


if __name__ == '__main__':
    unittest.main()
