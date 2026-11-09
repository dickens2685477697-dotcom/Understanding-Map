#!/usr/bin/env python3
"""Build a clean test ZIP from an explicit program-file allowlist."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import zipfile

SOURCE = Path(__file__).resolve().parent
BASE = SOURCE.parent
VERSION = '0.2.0-test.1'


def write_entry_points(root):
    for number, action in (('01-Install', 'install'), ('02-Start', 'start')):
        setup = ' --open-setup' if action == 'install' else ''
        mac = root / (number + '.command')
        mac.write_text('#!/bin/sh\nset -eu\nTASK_PACKAGE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n'
                       'if ! command -v python3 >/dev/null 2>&1; then\n'
                       '  echo "Install Python 3.9+ from https://www.python.org/downloads/"\n'
                       '  read -r TASK_WAIT\n  exit 1\nfi\n'
                       'python3 "$TASK_PACKAGE/install.py" ' + action + setup + '\n'
                       'echo "Press Return to close this window."\nread -r TASK_WAIT\n', encoding='utf-8')
        mac.chmod(0o755)
        win = root / (number + '.cmd')
        win.write_bytes(('@echo off\r\nchcp 65001 >nul\r\nwhere py >nul 2>nul\r\n'
                         'if errorlevel 1 (\r\n  python "%~dp0install.py" ' + action + '\r\n'
                         ') else (\r\n  py -3 "%~dp0install.py" ' + action + '\r\n)\r\n'
                         'if errorlevel 1 echo Check the error above. Python 3.9+ is required: https://www.python.org/downloads/\r\npause\r\n').encode('utf-8'))


def build(output, references):
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='understanding-map-release-') as temporary:
        temp = Path(temporary)
        root = temp / ('Understanding-Map-' + VERSION)
        skill = root / 'payload/understanding-map'
        scripts = skill / 'scripts'
        scripts.mkdir(parents=True)
        for name in ('init_tracker.py', 'map_state.py', 'publish_view.py', 'reopen_map.py'):
            shutil.copy2(BASE / 'skill-draft/understanding-map/scripts' / name, scripts / name)
        for name in ('preview_server.py', 'native_navigation.py', 'live-panel.html'):
            shutil.copy2(BASE / name, scripts / name)
        shutil.copy2(SOURCE / 'portable.py', scripts / 'portable.py')
        shutil.copy2(SOURCE / 'SKILL.md', skill / 'SKILL.md')
        for name in ('install.py', 'START-HERE.txt'):
            shutil.copy2(SOURCE / name, root / name)
        write_entry_points(root)

        mac_assets = skill / 'assets/native-helper'
        mac_assets.mkdir(parents=True)
        source = (BASE / 'native-helper/MapNavigator.swift').read_text()
        ids = list(dict.fromkeys(re.findall(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', source)))
        for i, value in enumerate(ids, 1):
            source = source.replace(value, ('%08d-1111-4111-8111-111111111111' % i))
        source = source.replace('start-native-navigation.command', '02-Start.command')
        (temp / 'MapNavigator.swift').write_text(source)
        (mac_assets / 'MapNavigator.swift').write_text(source)
        app = mac_assets / 'Understanding Map Navigator.app'
        executable = app / 'Contents/MacOS/MapNavigator'
        executable.parent.mkdir(parents=True)
        shutil.copy2(BASE / 'native-helper/Info.plist', app / 'Contents/Info.plist')
        subprocess.run(['swiftc', '-O', '-module-cache-path', str(temp / 'swift-cache'),
                        '-framework', 'AppKit', '-framework', 'ApplicationServices',
                        'MapNavigator.swift', '-o', str(executable)], cwd=temp, check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', '--identifier', 'local.understanding-map.navigator', str(app)], check=True)
        subprocess.run([str(executable), '--test-surface-selection'], check=True, stdout=subprocess.PIPE)

        win_assets = skill / 'assets/windows'
        win_assets.mkdir(parents=True)
        win_source = root / 'Windows/MapNavigator.cs'
        win_source.parent.mkdir()
        shutil.copy2(SOURCE / 'windows/MapNavigator.cs', win_source)
        command = ['mcs', '-sdk:4.8', '-optimize+', '-target:exe', '-platform:anycpu',
                   '-r:System.Web.Extensions', '-r:System.Windows.Forms']
        command += ['-r:' + str(references / name) for name in ('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')]
        command += ['-out:' + str(win_assets / 'MapNavigator.exe'), str(win_source)]
        subprocess.run(command, check=True)
        subprocess.run(['mono', str(win_assets / 'MapNavigator.exe'), '--self-test'], check=True, stdout=subprocess.PIPE)
        (root / 'manifest.json').write_text(json.dumps({'version': VERSION,
            'platforms': ['macOS 15+ Apple Silicon', 'Windows 10/11 .NET Framework 4.8'],
            'windows_native_verified': False}, indent=2))

        # Only the assembled allowlist is archived. No workspace state, tokens,
        # tests, cache files, or a recipient's installation are copied.
        forbidden = [str(Path.home()).encode(), str(BASE.parent.parent).encode()] + [s.encode() for s in ids]
        for file in root.rglob('*'):
            if file.is_file():
                if any(marker in file.read_bytes() for marker in forbidden):
                    raise ValueError('A personal build path or chat identifier leaked into ' + str(file.relative_to(root)))
        target = output / (root.name + '.zip')
        staging = target.with_suffix('.zip.tmp')
        with zipfile.ZipFile(staging, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in sorted(root.rglob('*')):
                if file.is_file():
                    archive.write(file, file.relative_to(temp))
        os.replace(staging, target)
        print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size}))
        return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=BASE / 'releases')
    parser.add_argument('--net48-refs', required=True, type=Path)
    args = parser.parse_args()
    build(args.output, args.net48_refs)
