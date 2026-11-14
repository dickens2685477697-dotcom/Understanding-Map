import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

BUILDER = Path(__file__).resolve().parents[2] / 'validation/understanding-map/distribution/windows/build_helper.py'
SPEC = importlib.util.spec_from_file_location('windows_build', BUILDER)
windows_build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(windows_build)


class WindowsBuildTests(unittest.TestCase):
    def test_release_requires_matching_source_and_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'MapNavigator.cs'
            binary = root / 'MapNavigator.exe'
            source.write_bytes(b'current source')
            binary.write_bytes(b'compiled artifact')
            metadata = {'version': 1, 'source_sha256': windows_build.digest(source),
                        'binary_sha256': windows_build.digest(binary)}
            binary.with_suffix('.build.json').write_text(json.dumps(metadata))
            self.assertEqual(windows_build.verify(binary, source), metadata)
            source.write_bytes(b'new source after build')
            with self.assertRaisesRegex(ValueError, 'stale'):
                windows_build.verify(binary, source)
            source.write_bytes(b'current source')
            binary.write_bytes(b'old release binary')
            with self.assertRaisesRegex(ValueError, 'stale'):
                windows_build.verify(binary, source)

    def test_legacy_binary_without_build_record_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / 'MapNavigator.exe'
            binary.write_bytes(b'legacy artifact')
            with self.assertRaises(FileNotFoundError):
                windows_build.verify(binary)
