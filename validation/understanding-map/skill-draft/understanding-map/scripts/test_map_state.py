import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('map_state.py')

def turn(n):
    return {'id': f't{n}', 'status': 'completed', 'items': [
        {'id': f'u{n}', 'type': 'userMessage', 'content': [{'type': 'text', 'text': f'PRIVATE USER {n}'}]},
        {'id': f'a{n}', 'type': 'agentMessage', 'phase': 'final_answer', 'text': f'PRIVATE ASSISTANT {n}'},
    ]}

class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / 'state.json')

    def run_action(self, action, payload, ok=True):
        result = subprocess.run([sys.executable, str(SCRIPT), action, '--state', self.path], input=json.dumps(payload), text=True, capture_output=True)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        return json.loads(result.stderr)

    def test_threshold_dedup_and_complete_only(self):
        initial = self.run_action('ingest', {'session_id':'s1', 'turns':[turn(0)]})
        self.assertEqual((initial['pending_count'], initial['due'], initial['due_reason']), (1, True, 'initial'))
        initial_nodes = [
            {'id':'nu0','turn_id':'t0','message_id':'u0','role':'user','summary':'用户摘要','parent_ids':[],'source_ids':['u0']},
            {'id':'na0','turn_id':'t0','message_id':'a0','role':'assistant','summary':'回复摘要','parent_ids':['nu0'],'source_ids':['a0']},
        ]
        self.run_action('apply', {'session_id':'s1','turn_ids':['t0'],'nodes':initial_nodes})
        payload = {'session_id':'s1','turns':[turn(n) for n in range(1,5)] + [{'id':'current', 'status':'inProgress', 'items':[]}]}
        first = self.run_action('ingest', payload)
        self.assertEqual((first['pending_count'],first['due'],first['due_reason']), (4,False,None))
        self.assertEqual(self.run_action('ingest',payload)['added'],0)
        fifth = self.run_action('ingest',{'session_id':'s1','turns':[turn(5)]})
        self.assertEqual((fifth['pending_count'],fifth['due'],fifth['due_reason']), (5,True,'threshold'))
        changed=turn(1);changed['items'][0]['content'][0]['text']='DIFFERENT'
        self.run_action('ingest',{'session_id':'s1','turns':[changed]},ok=False)

    def test_initial_history_is_due_even_below_threshold(self):
        empty = self.run_action('ingest', {'session_id':'s1', 'turns':[]})
        self.assertEqual((empty['pending_count'], empty['due']), (0, False))
        history = {'session_id':'s1', 'turns':[turn(1), turn(2)]}
        first = self.run_action('ingest', history)
        self.assertEqual((first['pending_count'], first['due_reason']), (2, 'initial'))
        repeat = self.run_action('ingest', history)
        self.assertEqual((repeat['added'], repeat['pending_count'], repeat['due_reason']), (0, 2, 'initial'))
        self.run_action('apply', {'session_id':'s1', 'turn_ids':['t1'], 'nodes':[]}, ok=False)
        self.assertEqual(self.run_action('ingest', history)['due_reason'], 'initial')

    def test_apply_requires_coverage_and_exports_no_raw_text(self):
        self.run_action('ingest',{'session_id':'s1','turns':[turn(1)]})
        user = {'id':'nu','turn_id':'t1','message_id':'u1','role':'user','summary':'用户摘要','parent_ids':[],'source_ids':['u1']}
        assistant = {'id':'na','turn_id':'t1','message_id':'a1','role':'assistant','summary':'回复摘要','parent_ids':['nu'],'source_ids':['a1','u1']}
        self.run_action('apply',{'session_id':'s1','turn_ids':['t1'],'nodes':[user]},ok=False)
        invalid={**assistant,'source_ids':['a1','missing']}
        self.run_action('apply',{'session_id':'s1','turn_ids':['t1'],'nodes':[user,invalid]},ok=False)
        result=self.run_action('apply',{'session_id':'s1','turn_ids':['t1'],'nodes':[user,assistant]})
        self.assertEqual(result['nodes_added'],2)
        self.run_action('apply',{'session_id':'s1','turn_ids':['t1'],'nodes':[user,assistant]},ok=False)
        public=self.run_action('export',{'session_id':'s1'})
        self.assertEqual(len(public['nodes']),2)
        self.assertNotIn('PRIVATE',json.dumps(public))
        self.assertEqual(self.run_action('ingest',{'session_id':'s1','turns':[]})['pending_count'],0)

    def test_session_isolation(self):
        self.run_action('ingest',{'session_id':'s1','turns':[turn(1)]})
        self.assertEqual(self.run_action('ingest',{'session_id':'s2','turns':[turn(1)]})['pending_count'],1)
        self.assertEqual(self.run_action('export',{'session_id':'s2'})['nodes'],[])

    def test_topics_are_preserved_and_invalid_topics_do_not_commit(self):
        self.run_action('ingest', {'session_id':'s1', 'turns':[turn(1)]})
        user = {'id':'nu','turn_id':'t1','message_id':'u1','role':'user',
                'summary':'用户摘要','parent_ids':[],'source_ids':['u1'],'topic_id':'child'}
        assistant = {'id':'na','turn_id':'t1','message_id':'a1','role':'assistant',
                     'summary':'回复摘要','parent_ids':['nu'],'source_ids':['a1'],'topic_id':'child'}
        topics = [{'id':'main','label':'主题','parent_id':None},
                  {'id':'child','label':'子主题','parent_id':'main'}]
        cyclic = [{'id':'main','label':'主题','parent_id':'child'},
                  {'id':'child','label':'子主题','parent_id':'main'}]
        self.run_action('apply', {'session_id':'s1','turn_ids':['t1'],'nodes':[user,assistant],'topics':cyclic}, ok=False)
        self.assertEqual(self.run_action('export', {'session_id':'s1'})['nodes'], [])
        self.run_action('apply', {'session_id':'s1','turn_ids':['t1'],'nodes':[user,assistant],'topics':topics})
        exported = self.run_action('export', {'session_id':'s1'})
        self.assertEqual(exported['topics'], topics)
        self.assertEqual(exported['nodes'][0]['topic_id'], 'child')

    def test_completed_status_before_final_is_not_counted_or_checkpointed(self):
        partial = turn(1)
        partial['items'] = partial['items'][:1]
        result = self.run_action('ingest', {'session_id':'s1', 'turns':[partial]})
        self.assertEqual((result['added'], result['pending_count'], result['due']), (0, 0, False))
        self.run_action('apply', {'session_id':'s1', 'turn_ids':['t1'], 'nodes':[]}, ok=False)
        # The same ID becomes ingestible when its final assistant item arrives.
        result = self.run_action('ingest', {'session_id':'s1', 'turns':[turn(1)]})
        self.assertEqual((result['added'], result['pending_count']), (1, 1))

    def test_present_but_empty_final_is_retained_as_empty(self):
        complete = turn(1)
        complete['items'][1]['text'] = ''
        result = self.run_action('ingest', {'session_id':'s1', 'turns':[complete]})
        self.assertEqual(result['pending_count'], 1)
        with open(self.path, encoding='utf-8') as f:
            messages = json.load(f)['sessions']['s1']['turns'][0]['messages']
        self.assertEqual(messages[1], {'id':'a1', 'role':'assistant', 'text':''})

    def test_parent_cycles_are_rejected_without_mutating_checkpoint(self):
        self.run_action('ingest', {'session_id':'s1', 'turns':[turn(1)]})
        user = {'id':'nu','turn_id':'t1','message_id':'u1','role':'user',
                'summary':'用户摘要','parent_ids':['na'],'source_ids':['u1']}
        assistant = {'id':'na','turn_id':'t1','message_id':'a1','role':'assistant',
                     'summary':'回复摘要','parent_ids':['nu'],'source_ids':['a1']}
        self.run_action('apply', {'session_id':'s1','turn_ids':['t1'],
                                  'nodes':[user, assistant]}, ok=False)
        self.assertEqual(self.run_action('export', {'session_id':'s1'})['nodes'], [])
        self.assertEqual(self.run_action('ingest', {'session_id':'s1','turns':[]})['pending_count'], 1)
        # A forward reference itself is allowed when the graph remains acyclic.
        assistant['parent_ids'] = []
        self.assertEqual(self.run_action('apply', {'session_id':'s1','turn_ids':['t1'],
                                                   'nodes':[user, assistant]})['nodes_added'], 2)

if __name__ == '__main__':
    unittest.main(verbosity=2)
