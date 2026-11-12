#!/usr/bin/env python3
"""Installed skill entry points; personal data stays outside the shared package."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from native_navigation import ADAPTER_REVISION

SKILL_ROOT = Path(__file__).resolve().parent.parent


def data_directory():
    return Path(os.environ.get('UNDERSTANDING_MAP_HOME', Path.home() / '.understanding-map')).expanduser().resolve()


def helper_path():
    if sys.platform == 'darwin':
        return SKILL_ROOT / 'assets/native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator'
    if sys.platform == 'win32':
        return SKILL_ROOT / 'assets/windows/MapNavigator.exe'
    raise ValueError('This test package supports macOS and native Windows.')


def service_status(root):
    try:
        with urlopen('http://127.0.0.1:18766/health', timeout=2) as response:
            value = json.load(response)
    except (HTTPError, ValueError):
        return {'ready': False, 'port_in_use': True}
    except (OSError, URLError):
        return {'ready': False}
    expected = hashlib.sha256(str(root.resolve()).encode()).hexdigest()[:16]
    return {'ready': value.get('service') == 'understanding-map' and value.get('data_id') == expected
            and value.get('native_enabled') is True and value.get('adapter_revision') == ADAPTER_REVISION
            and value.get('refresh_enabled') is True and value.get('refresh_revision') == 1,
            'port_in_use': True, 'adapter_revision': value.get('adapter_revision')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('init', 'reopen', 'status', 'serve'))
    args = parser.parse_args()
    root = data_directory()
    if args.action == 'status':
        print(json.dumps(service_status(root)))
        return
    if args.action == 'init':
        from init_tracker import checked_session_id, initialize
        print(json.dumps(initialize(root, checked_session_id(os.environ.get('CODEX_THREAD_ID')))))
        return
    if args.action == 'reopen':
        from init_tracker import checked_session_id
        from reopen_map import recover
        print(json.dumps(recover(root, checked_session_id(os.environ.get('CODEX_THREAD_ID')))))
        return
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    status = service_status(root)
    if status['ready']:
        print('Understanding Map is already running. In Codex, ask: $understanding-map 打开理解地图', flush=True)
        return
    if status.get('port_in_use'):
        raise ValueError('Port 18766 belongs to another map service. Stop its terminal before starting this installation.')
    helper = helper_path()
    if not helper.is_file():
        raise ValueError('Native helper is missing. Run the installer again.')
    if sys.platform == 'darwin' and platform.machine() != 'arm64':
        raise ValueError('The included Mac build requires Apple Silicon and macOS 15 or later.')
    print('Starting Understanding Map. Keep this terminal open. Ctrl+C stops it.', flush=True)
    print('In Codex, ask: $understanding-map 为当前聊天开启理解地图并打开右侧面板', flush=True)
    command = [sys.executable, str(Path(__file__).with_name('preview_server.py')),
               '--config', str(root / 'tracking.json'), '--native-helper', str(helper)]
    try:
        raise SystemExit(subprocess.call(command))
    except KeyboardInterrupt:
        return


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
