#!/usr/bin/env python3
"""Synthetic-only hook event storage PoC. This is NOT a deployable hook."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

EVENT_FIELDS = {'UserPromptSubmit': 'prompt', 'Stop': 'last_assistant_message'}


def validate_event(event):
    if not isinstance(event, dict) or event.get('synthetic_test_event') is not True:
        raise ValueError('Only explicit synthetic test events are accepted')
    event_type = event.get('hook_event_name')
    if event_type not in EVENT_FIELDS:
        raise ValueError('Unsupported event')
    for name in ('session_id', 'turn_id'):
        if not isinstance(event.get(name), str) or not event[name].strip():
            raise ValueError('session_id and turn_id are required')
    field = EVENT_FIELDS[event_type]
    if field not in event:
        raise ValueError(f'Missing {field}')
    value = event[field]
    if not isinstance(value, str) and not (event_type == 'Stop' and value is None):
        raise ValueError(f'Invalid {field}')
    return event['session_id'], event['turn_id'], event_type, value


def validate_dir(value):
    path = Path(value).resolve()
    roots = {Path(tempfile.gettempdir()).resolve(), Path('/private/tmp').resolve()}
    if not any(path != root and path.is_relative_to(root) for root in roots):
        raise ValueError('Test directory must be a subdirectory of a temporary directory')
    if not path.is_dir():
        raise ValueError('Test directory must already exist')
    return path


def ingest(event, directory):
    session, turn, event_type, text = validate_event(event)
    database = validate_dir(directory) / 'synthetic-events.sqlite3'
    with sqlite3.connect(database, timeout=5) as db:
        db.execute('''CREATE TABLE IF NOT EXISTS events (
            session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
            event_type TEXT NOT NULL, text_value TEXT,
            PRIMARY KEY (session_id, turn_id, event_type)
        )''')
        old = db.execute('SELECT text_value FROM events WHERE session_id=? AND turn_id=? AND event_type=?',
                         (session, turn, event_type)).fetchone()
        if old is None:
            db.execute('INSERT INTO events VALUES (?, ?, ?, ?)', (session, turn, event_type, text))
        elif old[0] != text:
            raise ValueError('Conflicting duplicate event: preserved existing value')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test-data-dir', required=True, help='existing temporary directory for synthetic events only')
    args = parser.parse_args()
    try:
        event = json.load(sys.stdin)
        ingest(event, args.test_data_dir)
    except (ValueError, sqlite3.Error, OSError) as exc:
        print(f'Synthetic event rejected: {exc}', file=sys.stderr)
        return 1
    # Empty JSON is compatible with successful Stop hooks and adds no context.
    print('{}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
