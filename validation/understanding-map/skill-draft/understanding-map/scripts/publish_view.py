#!/usr/bin/env python3
"""Publish only one session's map summaries, not captured message bodies."""
import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from map_state import load


def publish(state_path, view_path, session_id):
    if not session_id or not session_id.strip():
        raise ValueError('session ID is required')
    if not state_path.is_file():
        raise ValueError('state file does not exist')
    if view_path.is_symlink():
        raise ValueError('view path must not be a symbolic link')
    if state_path.resolve() == view_path.resolve():
        raise ValueError('view path must differ from state path')
    if view_path.exists() and os.path.samefile(state_path, view_path):
        raise ValueError('view path must differ from state path')

    state = load(state_path)
    session = state['sessions'].get(session_id)
    if not isinstance(session, dict) or not isinstance(session.get('nodes'), list):
        raise ValueError('unknown session ID or invalid session')
    keys = ('id', 'turn_id', 'message_id', 'role', 'summary', 'parent_ids', 'source_ids', 'topic_id', 'intent')
    nodes = session['nodes']
    if not all(isinstance(node, dict) for node in nodes):
        raise ValueError('invalid session nodes')
    topics = session.get('topics', [])
    if not isinstance(topics, list) or not all(isinstance(topic, dict) for topic in topics):
        raise ValueError('invalid session topics')
    topic_keys = ('id', 'label', 'parent_id')
    view = {'version': 1, 'session_id': session_id,
            'topics': [{key: topic.get(key) for key in topic_keys} for topic in topics],
            'nodes': [{key: node.get(key) for key in keys} for node in nodes]}

    # A same-directory temporary file ensures replace is atomic. mkstemp uses
    # mode 0600, and fchmod makes the permission requirement explicit.
    fd, temporary = tempfile.mkstemp(prefix='.map-view-', dir=view_path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            if hasattr(os, 'fchmod'):
                os.fchmod(f.fileno(), 0o600)
            json.dump(view, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(temporary, view_path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'session_id': session_id, 'node_count': len(nodes)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--view', required=True, type=Path)
    parser.add_argument('--session-id', required=True)
    args = parser.parse_args()
    print(json.dumps(publish(args.state, args.view, args.session_id), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
