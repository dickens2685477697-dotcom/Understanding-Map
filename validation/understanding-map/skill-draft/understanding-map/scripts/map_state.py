#!/usr/bin/env python3
"""Local, explicit incremental checkpoint; never reads a chat on its own."""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


def fail(message):
    raise ValueError(message)


def load(path):
    if not path.exists():
        return {'version': 1, 'sessions': {}}
    with path.open(encoding='utf-8') as f:
        state = json.load(f)
    if state.get('version') != 1 or not isinstance(state.get('sessions'), dict):
        fail('unsupported or invalid state')
    return state


def write_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.map-state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def extract(turn):
    if turn.get('status') != 'completed':
        return None
    if not isinstance(turn.get('id'), str) or not turn['id']:
        fail('missing turn ID')
    messages = []
    for item in turn.get('items', []):
        role = None
        text = None
        if item.get('type') == 'userMessage':
            role = 'user'
            content = item.get('content', [])
            text = '\n'.join(x.get('text', '') for x in content if x.get('type') == 'text')
        elif item.get('type') == 'agentMessage' and item.get('phase') in ('final', 'final_answer'):
            role, text = 'assistant', item.get('text', '')
        if role:
            if not isinstance(item.get('id'), str) or not item['id']:
                fail('message is missing an ID')
            if not isinstance(text, str):
                fail('message text must be a string')
            messages.append({'id': item['id'], 'role': role, 'text': text})
    # A completed status can arrive before the final assistant item is visible.
    # Do not count or checkpoint a partial turn: a later read must be able to
    # ingest the complete version without treating it as a conflicting edit.
    if not any(x['role'] == 'user' for x in messages) or not any(x['role'] == 'assistant' for x in messages):
        return None
    return {'id': turn['id'], 'status': 'completed', 'messages': messages}


def get_session(state, payload):
    sid = payload.get('session_id')
    if not isinstance(sid, str) or not sid.strip():
        fail('session_id is required')
    return sid, state['sessions'].setdefault(sid, {'turns': [], 'processed_turn_ids': [], 'nodes': []})


def ingest(session, payload, threshold):
    incoming = payload.get('turns')
    if not isinstance(incoming, list):
        fail('turns must be a list in chronological order')
    index = {t['id']: t for t in session['turns']}
    added = 0
    for raw in incoming:
        turn = extract(raw)
        if turn is None:
            continue
        previous = index.get(turn['id'])
        if previous is not None:
            if previous != turn:
                fail('a previously ingested turn changed: ' + turn['id'])
            continue
        session['turns'].append(turn)
        index[turn['id']] = turn
        added += 1
    done = set(session['processed_turn_ids'])
    pending = [t['id'] for t in session['turns'] if t['id'] not in done]
    # A newly enabled map must cover existing history immediately; the normal
    # threshold applies only after the first successful map has been stored.
    initial = bool(pending) and not done and not session['nodes']
    reason = 'initial' if initial else 'threshold' if len(pending) >= threshold else None
    return {'added': added, 'pending_turn_ids': pending, 'pending_count': len(pending), 'threshold': threshold, 'due': reason is not None, 'due_reason': reason}


def apply(session, payload):
    turn_ids, nodes = payload.get('turn_ids'), payload.get('nodes')
    if not isinstance(turn_ids, list) or not turn_ids or len(set(turn_ids)) != len(turn_ids):
        fail('turn_ids must be a nonempty unique list')
    if not isinstance(nodes, list):
        fail('nodes must be a list')
    turns = {t['id']: t for t in session['turns']}
    if not set(turn_ids) <= turns.keys():
        fail('unknown turn ID')
    if set(turn_ids) & set(session['processed_turn_ids']):
        fail('turn already processed; revisions require a separate workflow')
    if not session['processed_turn_ids'] and not session['nodes'] and set(turn_ids) != set(turns):
        fail('the initial map must cover all collected completed turns')
    existing_topics = session.get('topics', [])
    added_topics = payload.get('topics', [])
    if not isinstance(existing_topics, list) or not isinstance(added_topics, list):
        fail('topics must be lists')
    topics = existing_topics + added_topics
    if any(not isinstance(t, dict) or not isinstance(t.get('id'), str) or not t['id']
           or not isinstance(t.get('label'), str) or not t['label'].strip()
           or (t.get('parent_id') is not None and not isinstance(t['parent_id'], str)) for t in topics):
        fail('each topic needs an ID, a label and an optional parent ID')
    topic_ids = [t['id'] for t in topics]
    if len(set(topic_ids)) != len(topic_ids):
        fail('topic IDs must be unique')
    topic_parents = {t['id']: t.get('parent_id') for t in topics}
    for topic_id, parent in topic_parents.items():
        seen = {topic_id}
        while parent is not None:
            if parent not in topic_parents or parent in seen:
                fail('topic parents must exist and cannot form a cycle')
            seen.add(parent)
            parent = topic_parents[parent]
    expected = {m['id']: (t['id'], m['role']) for t in session['turns'] if t['id'] in turn_ids for m in t['messages']}
    existing_nodes = {n['id'] for n in session['nodes']}
    candidate_ids = [n.get('id') for n in nodes]
    if any(not isinstance(n, str) or not n for n in candidate_ids) or len(set(candidate_ids)) != len(candidate_ids) or existing_nodes.intersection(candidate_ids):
        fail('node IDs must be new, unique, nonempty strings')
    all_nodes = existing_nodes | set(candidate_ids)
    known_messages = {m['id'] for t in session['turns'] for m in t['messages']}
    seen_messages = set()
    for n in nodes:
        mid = n.get('message_id')
        if mid not in expected or mid in seen_messages or (n.get('turn_id'), n.get('role')) != expected[mid]:
            fail('node must map once to a selected message with matching turn and role')
        if not isinstance(n.get('summary'), str) or not n['summary'].strip():
            fail('node summary is required')
        if n.get('intent') is not None and n['intent'] not in ('question', 'idea', 'request', 'feedback', 'confirmation'):
            fail('node intent must use a supported category')
        topic_id = n.get('topic_id')
        if topic_id is not None and (not isinstance(topic_id, str) or topic_id not in topic_parents):
            fail('node topic ID must reference a known topic')
        parents = n.get('parent_ids', [])
        sources = n.get('source_ids', [])
        if not isinstance(parents, list) or not set(parents) <= all_nodes or n['id'] in parents:
            fail('parent IDs must refer to other existing or new nodes')
        if not isinstance(sources, list) or mid not in sources or not set(sources) <= known_messages:
            fail('source IDs must include the message and refer to known messages')
        seen_messages.add(mid)
    if seen_messages != expected.keys():
        fail('every captured user and final assistant message must have one node')

    # Parent references form a directed acyclic graph. Validate both existing
    # and new nodes before committing the batch; forward references within the
    # same batch are permitted provided they do not create a cycle.
    graph = {node['id']: node.get('parent_ids', []) for node in session['nodes'] + nodes}
    visiting, visited = set(), set()
    for start in graph:
        stack = [(start, False)]
        while stack:
            node_id, exiting = stack.pop()
            if exiting:
                visiting.remove(node_id)
                visited.add(node_id)
            elif node_id not in visited:
                if node_id in visiting:
                    fail('parent relationships must not contain cycles')
                visiting.add(node_id)
                stack.append((node_id, True))
                for parent_id in graph.get(node_id, []):
                    if parent_id in visiting:
                        fail('parent relationships must not contain cycles')
                    if parent_id not in visited:
                        stack.append((parent_id, False))
    session['nodes'].extend(nodes)
    if added_topics:
        session.setdefault('topics', []).extend(added_topics)
    session['processed_turn_ids'].extend(turn_ids)
    return {'processed_turn_ids': turn_ids, 'nodes_added': len(nodes)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('ingest', 'apply', 'export'))
    parser.add_argument('--state', required=True)
    parser.add_argument('--threshold', type=int, default=5)
    args = parser.parse_args()
    if args.threshold < 1:
        fail('threshold must be positive')
    payload = json.load(sys.stdin)
    state_path = Path(args.state)
    state = load(state_path)
    if args.action == 'export':
        sid = payload.get('session_id')
        session = state['sessions'].get(sid)
        if session is None:
            fail('unknown session ID')
        # Only allow-listed fields are exposed to a viewer; never serve raw state.
        keys = ('id', 'turn_id', 'message_id', 'role', 'summary', 'parent_ids', 'source_ids', 'topic_id', 'intent')
        topic_keys = ('id', 'label', 'parent_id')
        print(json.dumps({'version': 1, 'session_id': sid,
                          'topics': [{k: t.get(k) for k in topic_keys} for t in session.get('topics', [])],
                          'nodes': [{k: n.get(k) for k in keys} for n in session['nodes']]}, ensure_ascii=False))
        return
    sid, session = get_session(state, payload)
    result = ingest(session, payload, args.threshold) if args.action == 'ingest' else apply(session, payload)
    write_atomic(state_path, state)
    print(json.dumps({'session_id': sid, **result}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
