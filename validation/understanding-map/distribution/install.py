#!/usr/bin/env python3
"""Install or start the shared test package without copying personal map data."""
import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time

PACKAGE = Path(__file__).resolve().parent


def install(home, update=False):
    target = home / '.agents/skills/understanding-map'
    legacy = home / '.codex/skills/understanding-map'
    if legacy.exists():
        raise ValueError('An older understanding-map skill exists in ~/.codex/skills. Keep or relocate that copy before installing to avoid duplicate skills.')
    manifest = json.loads((PACKAGE / 'manifest.json').read_text(encoding='utf-8'))
    if target.is_symlink():
        raise ValueError('The destination is a symbolic link. Choose a regular skill directory.')
    if target.exists() and not update:
        marker = target / 'release.json'
        if marker.exists() and json.loads(marker.read_text()) == manifest:
            return target
        raise ValueError('A skill already exists. To back it up and update explicitly, run install.py install --update.')
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.understanding-map-', dir=target.parent))
    backup = None
    try:
        shutil.copytree(PACKAGE / 'payload/understanding-map', stage, dirs_exist_ok=True)
        (stage / 'release.json').write_text(json.dumps(manifest), encoding='utf-8')
        if not (stage / 'SKILL.md').is_file():
            raise ValueError('The package is incomplete.')
        if sys.platform == 'darwin':
            if platform.machine() != 'arm64':
                raise ValueError('The included Mac build requires Apple Silicon.')
            helper = stage / 'assets/native-helper/Understanding Map Navigator.app/Contents/MacOS/MapNavigator'
            helper.chmod(helper.stat().st_mode | 0o111)
            command = [str(helper), '--test-surface-selection']
        elif sys.platform == 'win32':
            command = [str(stage / 'assets/windows/MapNavigator.exe'), '--self-test']
        else:
            raise ValueError('Install this package on macOS or native Windows.')
        checked = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        if checked.returncode != 0:
            raise ValueError('Native helper could not start. Check the OS prompt and platform/runtime requirements in START-HERE.txt.')
        if target.exists():
            if not update:
                raise ValueError('Another installation finished meanwhile. Run the installer again to reuse it.')
            backups = home / '.understanding-map/backups'
            backups.mkdir(parents=True, mode=0o700, exist_ok=True)
            backup = backups / ('understanding-map-' + str(time.time_ns()))
            target.rename(backup)
        try:
            stage.rename(target)
        except OSError:
            if backup is not None:
                backup.rename(target)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'start', 'status'))
    parser.add_argument('--home', type=Path, default=Path.home(), help='Alternative recipient home for isolated installation tests')
    parser.add_argument('--update', action='store_true')
    parser.add_argument('--open-setup', action='store_true', help='Open the installed Mac permission helper after a user starts the installer')
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        raise ValueError('Install Python 3.9 or later from https://www.python.org/downloads/')
    target = args.home.expanduser().resolve() / '.agents/skills/understanding-map'
    if args.action == 'install':
        target = install(args.home.expanduser().resolve(), args.update)
        print('Installed skill: ' + str(target))
        print('Next: restart Codex if the skill is not listed, then double-click 02-Start for your platform.')
        if sys.platform == 'darwin':
            print('Grant Accessibility permission to the app under: ' + str(target / 'assets/native-helper'))
            if args.open_setup:
                subprocess.run(['/usr/bin/open', str(target / 'assets/native-helper/Understanding Map Navigator.app')], check=True)
        return
    if not (target / 'SKILL.md').is_file():
        raise ValueError('Run 01-Install first.')
    command = [sys.executable, str(target / 'scripts/portable.py'), 'serve' if args.action == 'start' else 'status']
    raise SystemExit(subprocess.call(command))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
