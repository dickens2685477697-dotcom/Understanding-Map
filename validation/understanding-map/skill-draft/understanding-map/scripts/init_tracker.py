#!/usr/bin/env python3
"""Initialize a private, session-scoped map tracker without replacing existing settings."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import sys
import tempfile

VALID_ID = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def checked_session_id(value):
    if not isinstance(value, str) or not VALID_ID.fullmatch(value):
        raise ValueError('session ID must contain only letters, digits, hyphens, and underscores')
    return value


def read_config(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('existing tracker configuration must be a regular file')
    with path.open(encoding='utf-8') as f:
        config = json.load(f)
    if (not isinstance(config, dict) or config.get('version') != 1 or
        not isinstance(config.get('session_id'), str) or
        not isinstance(config.get('state_file'), str) or
        not isinstance(config.get('view_file'), str) or
        type(config.get('interval')) is not int or config['interval'] < 1):
        raise ValueError('invalid existing tracker configuration')
    return config


def initialize(directory, session_id, interval=5):
    session_id = checked_session_id(session_id)
    if type(interval) is not int or interval < 1:
        raise ValueError('interval must be a positive integer')
    root = Path(directory).expanduser().resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not root.is_dir():
        raise ValueError('tracker directory must be a directory')

    # Recognize the first prototype's one-session config without changing it.
    legacy = root / 'tracking.json'
    if legacy.exists() or legacy.is_symlink():
        old = read_config(legacy)
        if old['session_id'] == session_id:
            return {'config_path': str(legacy), 'created': False, 'legacy': True}

    sessions = root / 'sessions'
    if sessions.is_symlink():
        raise ValueError('sessions directory must not be a symbolic link')
    sessions.mkdir(mode=0o700, exist_ok=True)
    folder = sessions / session_id
    if folder.is_symlink():
        raise ValueError('session directory must not be a symbolic link')
    folder.mkdir(mode=0o700, exist_ok=True)
    if not folder.resolve().is_relative_to(root):
        raise ValueError('session directory escapes tracker directory')
    config_path = folder / 'tracking.json'
    if config_path.exists() or config_path.is_symlink():
        existing = read_config(config_path)
        if existing['session_id'] != session_id:
            raise ValueError('existing config belongs to a different session')
        return {'config_path': str(config_path), 'created': False, 'legacy': False}

    token = secrets.token_urlsafe(32)
    config = {'version': 1, 'session_id': session_id, 'interval': interval, 'update_mode': 'refresh',
              'state_file': str(folder / 'state.json'), 'view_file': str(folder / 'map-view.json'),
              'view_access_token': token,
              'panel_url': 'http://127.0.0.1:18766/' + token + '/live-panel.html'}
    fd, temporary = tempfile.mkstemp(prefix='.tracker-', dir=folder)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            if hasattr(os, 'fchmod'):
                os.fchmod(f.fileno(), 0o600)
            json.dump(config, f, ensure_ascii=False, indent=2)
            f.write('\n')
        try:
            # Atomic, no-overwrite publication: two initializers cannot clobber.
            os.link(temporary, config_path)
            created = True
        except FileExistsError:
            existing = read_config(config_path)
            if existing['session_id'] != session_id:
                raise ValueError('existing config belongs to a different session')
            created = False
    finally:
        os.unlink(temporary)
    return {'config_path': str(config_path), 'created': created, 'legacy': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--session-id', help='must equal the trusted CODEX_THREAD_ID')
    parser.add_argument('--interval', type=int, default=5)
    args = parser.parse_args()
    trusted = checked_session_id(os.environ.get('CODEX_THREAD_ID'))
    if args.session_id is not None and args.session_id != trusted:
        raise ValueError('requested session ID differs from the current Codex thread')
    print(json.dumps(initialize(args.directory, trusted, args.interval), ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
