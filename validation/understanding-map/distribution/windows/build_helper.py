#!/usr/bin/env python3
"""Compile the Windows navigator and record which source produced the binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'MapNavigator.cs'
REFERENCES = ('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify(output, source=SOURCE):
    output = Path(output)
    metadata = json.loads(output.with_suffix('.build.json').read_text(encoding='utf-8'))
    if (metadata.get('version') != 1 or metadata.get('source_sha256') != digest(source)
            or metadata.get('binary_sha256') != digest(output)):
        raise ValueError('Windows navigator is stale. Rebuild it from the current source.')
    return metadata


def build(output, references=None):
    output = Path(output).resolve()
    references = Path(references or os.environ.get('UNDERSTANDING_MAP_NET48_REFS')
                      or ROOT.parent.parent / 'releases/net48/build/.NETFramework/v4.8').resolve()
    if not all((references / name).is_file() for name in REFERENCES):
        raise ValueError('Missing .NET Framework 4.8 reference assemblies. Set '
                         'UNDERSTANDING_MAP_NET48_REFS to the reference directory.')
    compiler = shutil.which('mcs')
    runtime = shutil.which('mono')
    if not compiler or not runtime:
        raise ValueError('Building the Windows navigator requires Mono (mcs and mono).')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='understanding-map-windows-') as temporary:
        staged = Path(temporary)
        shutil.copyfile(SOURCE, staged / 'MapNavigator.cs')
        command = [compiler, '-sdk:4.8', '-optimize+', '-target:exe', '-platform:anycpu',
                   '-r:System.Web.Extensions', '-r:System.Windows.Forms']
        command += ['-r:' + str(references / name) for name in REFERENCES]
        command += ['-out:MapNavigator.exe', 'MapNavigator.cs']
        subprocess.run(command, cwd=staged, check=True)
        subprocess.run([runtime, str(staged / 'MapNavigator.exe'), '--self-test'],
                       check=True, stdout=subprocess.PIPE)
        metadata = {'version': 1, 'source_sha256': digest(staged / 'MapNavigator.cs'),
                    'binary_sha256': digest(staged / 'MapNavigator.exe')}
        shutil.copyfile(staged / 'MapNavigator.exe', output)
        shutil.copyfile(staged / 'MapNavigator.cs', output.with_suffix('.cs'))
        output.with_suffix('.build.json').write_text(
            json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    verify(output)
    return metadata


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--net48-refs', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.net48_refs)))
