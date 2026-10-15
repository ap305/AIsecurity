import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
from patch_runtime import configure_patch_runtime
import bootstrap


class PatchRuntime(unittest.TestCase):
    def test_repeated_configuration_does_not_reset_interop_after_it_started(self):
        calls = []
        fake = types.SimpleNamespace(
            set_num_threads=lambda n: calls.append(('intra', n)),
            get_num_interop_threads=lambda: fake.interop,
            use_deterministic_algorithms=lambda enabled: calls.append(('deterministic', enabled)),
            backends=types.SimpleNamespace(mkldnn=types.SimpleNamespace(deterministic=False)),
            interop=64,
        )
        def set_interop(n):
            if fake.interop == 1:
                raise RuntimeError('inter-op work has already started')
            calls.append(('interop', n))
            fake.interop = n
        fake.set_num_interop_threads = set_interop
        with patch.dict(sys.modules, torch=fake):
            configure_patch_runtime()
            configure_patch_runtime()
        self.assertEqual(calls.count(('interop', 1)), 1)
        self.assertEqual(calls.count(('intra', 1)), 2)
        self.assertEqual(calls.count(('deterministic', True)), 2)
        self.assertTrue(fake.backends.mkldnn.deterministic)

    def test_worker_applies_patch_profile_before_loading_student(self):
        for scenario in ['patch_attack', 'mnist_poison']:
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as directory:
                public = Path(directory)
                (public / 'course.json').write_text(json.dumps({'scenario': scenario}), encoding='utf8')
                student = public / 'student.py'
                student.write_text('assert marker.ready == expected', encoding='utf8')
                marker = types.SimpleNamespace(ready=False)
                helpers = types.ModuleType('attack_helpers')
                helpers.marker, helpers.expected = marker, scenario == 'patch_attack'
                def configure(): marker.ready = True
                with patch.object(bootstrap, '__file__', str(public / 'bootstrap.py')), \
                     patch.dict(sys.modules, attack_helpers=helpers,
                                defense_helpers=types.ModuleType('defense_helpers'),
                                patch_runtime=types.SimpleNamespace(configure_patch_runtime=configure)):
                    try:
                        bootstrap.load_student(student, directory)
                    finally:
                        if str(public) in sys.path:
                            sys.path.remove(str(public))
                self.assertEqual(marker.ready, scenario == 'patch_attack')


if __name__ == '__main__':
    unittest.main()
