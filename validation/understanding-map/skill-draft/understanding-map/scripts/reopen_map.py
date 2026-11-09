#!/usr/bin/env python3
"""Find an existing tracker and restore its view without discarding map data."""
import argparse
import json
import os
from pathlib import Path
import sys

from init_tracker import checked_session_id, read_config
from map_state import load
from publish_view import publish


def existing_config(directory, sid):
    root = Path(directory).expanduser().resolve()
    if not root.is_dir():
        return None
    legacy = root / 'tracking.json'
    if legacy.exists() or legacy.is_symlink():
        config = read_config(legacy)
        if config['session_id'] == sid:
            return legacy, config
    sessions = root / 'sessions'
    folder = sessions / sid
    if sessions.is_symlink() or folder.is_symlink():
        raise ValueError('session paths must not be symbolic links')
    path = folder / 'tracking.json'
    if not path.exists() and not path.is_symlink():
        return None
    config = read_config(path)
    if config['session_id'] != sid:
        raise ValueError('tracker belongs to a different session')
    return path, config


def valid_file(path, expected):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve() != expected.resolve():
        raise ValueError('tracker file path is invalid')
    if path.exists() and (not path.is_file() or path.stat().st_nlink != 1):
        raise ValueError('tracker file must be a private regular file')
    return path


def node_ids(nodes):
    if not isinstance(nodes, list):
        raise ValueError('map nodes are invalid')
    ids = []
    for node in nodes:
        if not isinstance(node, dict) or not isinstance(node.get('id'), str) or not node['id']:
            raise ValueError('map contains an invalid node')
        ids.append(node['id'])
    if len(set(ids)) != len(ids):
        raise ValueError('map contains duplicate node IDs')
    return set(ids)


def recover(directory, sid):
    sid = checked_session_id(sid)
    found = existing_config(directory, sid)
    if found is None:
        return {'status':'not_found', 'node_count':0}
    config_path, config = found
    state = valid_file(config['state_file'], config_path.parent / 'state.json')
    view = valid_file(config['view_file'], config_path.parent / 'map-view.json')
    result = {'config_path':str(config_path), 'status':'not_found', 'node_count':0}

    view_data = None
    if view.exists():
        view_data = json.loads(view.read_text(encoding='utf-8'))
        if not isinstance(view_data, dict) or view_data.get('session_id') != sid:
            raise ValueError('existing map belongs to a different session or is invalid')
        view_ids = node_ids(view_data.get('nodes'))
    else:
        view_ids = set()

    if not state.exists():
        if view_data is not None:
            result.update(status='view_only', node_count=len(view_ids))
        return result

    state_data = load(state)
    session = state_data['sessions'].get(sid)
    if not isinstance(session, dict):
        raise ValueError('saved state does not contain the current session')
    state_ids = node_ids(session.get('nodes'))
    if not view_ids.issubset(state_ids):
        raise ValueError('existing view contains nodes not in saved state; preserving both')
    state_nodes = {n['id']: n for n in session['nodes']}
    core = ('id', 'turn_id', 'message_id', 'role', 'summary', 'parent_ids', 'source_ids')
    if view_data is not None:
        for node in view_data['nodes']:
            if any(node.get(key) != state_nodes[node['id']].get(key) for key in core):
                raise ValueError('existing view differs from saved messages; preserving both')
    saved_topics = session.get('topics', [])
    if not isinstance(saved_topics, list) or not all(isinstance(topic, dict) for topic in saved_topics):
        raise ValueError('saved topics are invalid; preserving both')
    topics = [{key: topic.get(key) for key in ('id','label','parent_id')}
              for topic in saved_topics]
    grouping_changed = view_data is not None and (view_data.get('topics', []) != topics or any(
        node.get('topic_id') != state_nodes[node['id']].get('topic_id') for node in view_data['nodes']))
    if view_data is None or view_ids != state_ids or grouping_changed:
        published = publish(state, view, sid)
        result.update(status='restored', node_count=published['node_count'])
    else:
        result.update(status='ready', node_count=len(view_ids))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--session-id', help='must equal the trusted CODEX_THREAD_ID')
    args=parser.parse_args()
    trusted=checked_session_id(os.environ.get('CODEX_THREAD_ID'))
    if args.session_id is not None and args.session_id != trusted:
        raise ValueError('requested session ID differs from the current Codex thread')
    print(json.dumps(recover(args.directory,trusted),ensure_ascii=False))


if __name__=='__main__':
    try:
        main()
    except (ValueError,OSError,json.JSONDecodeError) as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False),file=sys.stderr)
        sys.exit(1)
