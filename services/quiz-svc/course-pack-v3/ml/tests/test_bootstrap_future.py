"""Synthetic public frameworks only; no model, checkpoint or hidden data needed."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

BOOTSTRAP = Path(__file__).resolve().parents[1] / 'bootstrap.py'


class FutureAssemblyTests(unittest.TestCase):
    def test_docstring_and_later_future_import_remain_valid_after_assembly(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TEST_TMPDIR')) as directory:
            root = Path(directory)
            (root / 'bootstrap.py').write_bytes(BOOTSTRAP.read_bytes())
            (root / 'course.json').write_text(json.dumps({'number': '04', 'symbols': {'attack': ['attack']}}))
            (root / 'dataset.py').write_text('')
            (root / 'attack_backend.py').write_text('from __future__ import annotations\nHELPER = 7\n__COURSE_SLOT__ = True\n')
            code = root / 'student.py'
            code.write_text('"""Student description."""\n\n\n\n\n\n\nfrom __future__ import annotations\ndef attack(x: UnknownType):\n    return x + HELPER\n')
            compile(code.read_text(), str(code), 'exec')
            torch = types.ModuleType('torch')
            torch.set_num_threads = lambda value: None
            codec = types.ModuleType('course_codec')
            codec.pack = codec.unpack = lambda value: value
            spec = importlib.util.spec_from_file_location('synthetic_ml_bootstrap', root / 'bootstrap.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            with patch.dict(sys.modules, {'torch': torch, 'numpy': types.ModuleType('numpy'), 'checkpoints': types.ModuleType('checkpoints'), 'course_codec': codec}):
                worker = module.load_student(code, root)
                self.assertEqual(worker.course_ml_call('attack', 'function', {'name': 'attack', 'args': [3]}), 10)


if __name__ == '__main__':
    unittest.main()
