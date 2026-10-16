"""Security/causality checks for the data-only tabular bridge."""
import importlib.util
from pathlib import Path
import sys
import types
import unittest
import tempfile

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'basic'))
spec = importlib.util.spec_from_file_location('tabular_codec', ROOT / 'codec.py')
codec = importlib.util.module_from_spec(spec); sys.modules[spec.name] = codec; spec.loader.exec_module(codec)
platform = types.ModuleType('platform_student')
platform.invoke = lambda *_a, **_kw: None
platform.expose = lambda **kw: types.SimpleNamespace(**kw['methods'])
for name in ('StudentExecutionError', 'EvaluationInfrastructureError', 'EvaluationTimeoutError'):
    setattr(platform, name, type(name, (Exception,), {}))
sys.modules['platform_student'] = platform
spec = importlib.util.spec_from_file_location('tabular_runtime', ROOT / 'runtime.py')
runtime = importlib.util.module_from_spec(spec); sys.modules[spec.name] = runtime; spec.loader.exec_module(runtime)
spec = importlib.util.spec_from_file_location('tabular_build', ROOT / 'build.py')
builder = importlib.util.module_from_spec(spec); sys.modules[spec.name] = builder; spec.loader.exec_module(builder)


class BridgeContracts(unittest.TestCase):
    def test_membership_order_is_private_but_samples_and_truth_are_preserved(self):
        import numpy as np
        membership = np.concatenate([np.ones(2000, dtype=np.int64), np.zeros(2000, dtype=np.int64)])
        public_rng = np.random.default_rng(2024)
        public_rng.choice(4000, 2000, replace=False); public_rng.choice(4000, 2000, replace=False)
        leaked = membership[public_rng.permutation(4000)]
        original = {'candidate_images': np.arange(4000).reshape(-1, 1), 'candidate_labels': np.arange(4000) % 10,
                    'candidate_membership': leaked, 'public_images': np.array([5000])}
        private = builder.private_ordering(original, '23', np.random.default_rng(918273))
        indexes = private['candidate_images'].ravel()
        np.testing.assert_array_equal(np.sort(indexes), np.arange(4000))
        np.testing.assert_array_equal(private['candidate_membership'], leaked[indexes])
        np.testing.assert_array_equal(private['candidate_labels'], original['candidate_labels'][indexes])
        np.testing.assert_array_equal(private['public_images'], original['public_images'])
        self.assertLess(float(np.mean(leaked == private['candidate_membership'])), .55)

    def test_reidentification_order_preserves_true_records_without_public_row_mapping(self):
        import numpy as np
        release = np.arange(8000).reshape(-1, 1)
        old_targets = np.arange(0, 8000, 8, dtype=np.int32)
        private = builder.private_ordering({'release_train': release, 'target_true_index': old_targets}, '26', np.random.default_rng(987654))
        actual = private['release_train'][private['target_true_index']].ravel()
        np.testing.assert_array_equal(np.sort(actual), old_targets)
        np.testing.assert_array_equal(np.sort(private['release_train'].ravel()), np.arange(8000))
        self.assertFalse(np.array_equal(private['target_true_index'], old_targets))
        self.assertFalse(np.array_equal(private['target_true_index'], np.sort(private['target_true_index'])))

    def test_public_dataset_excludes_formal_generators_and_seed_metadata(self):
        import numpy as np
        with tempfile.TemporaryDirectory(dir=ROOT, prefix='contract-fixture-') as temporary:
            course = Path(temporary)
            (course / 'backend' / 'code' / 'data').mkdir(parents=True)
            np.savez(course / 'backend' / 'code' / 'data' / 'local.npz',
                     train_images=np.arange(2400).reshape(600, 2, 2), client_0=np.arange(100))
            (course / 'backend' / 'code' / 'dataset.py').write_text('''
CANDIDATE_SEED = 2024
DEFAULT_SEED = 42
N_RAW = 48842
def _build_splits(): return "PRIVATE_MEMBERSHIP_RULE"
def build_split(): return "PRIVATE_ROW_MAPPING"
def fetch_openml_table(): return "PRIVATE_SOURCE"
def to_image_format(x, normalize=True): return x
def _unpack(data): return data
def parse_cell(value): return value
''', encoding='utf8')
            for number in ('23', '24', '25', '26'):
                public = builder.public_dataset(course, number)
                for forbidden in ('CANDIDATE_SEED', 'DEFAULT_SEED = 42', 'N_RAW', '_build_splits', 'build_split', 'fetch_openml_table', 'PRIVATE_'):
                    self.assertNotIn(forbidden, public)
                self.assertIn('def load_benchmark', public)
                compile(public, 'public-dataset.py', 'exec')

    def test_local_fl_training_subset_cannot_reveal_the_eight_hidden_images_by_set_difference(self):
        import numpy as np
        images = np.arange(2400).reshape(600, 2, 2)
        clients = np.arange(100)
        picked = clients[np.random.RandomState(42).choice(len(clients), size=8, replace=False)]
        images[599] = images[picked[0]]  # Duplicate pixels must also be excluded.
        selection = builder.practice24_selection({'train_images': images, 'client_0': clients})
        hidden = {images[index].tobytes() for index in picked}
        self.assertFalse(any(image.tobytes() in hidden for image in images[selection]))
        self.assertLess(len(selection), 300)
        self.assertGreater(len(images) - len(selection), 300)

    def test_missing_ratings_use_finite_wire_values(self):
        import numpy as np
        original = np.array([[1., np.nan], [5., 2.]], dtype=np.float32)
        wire = codec.pack(original)
        self.assertEqual(wire['kind'], 'masked_array')
        self.assertTrue(np.isfinite(wire['value'][0]).all())
        np.testing.assert_equal(codec.unpack(wire), original)

    def test_dynamic_objects_and_infinite_arrays_are_rejected(self):
        import numpy as np
        with self.assertRaises(ValueError): codec.pack(object())
        with self.assertRaises(ValueError): codec.pack(np.array([float('inf')]))
        with self.assertRaises(ValueError): codec.unpack({'kind': '__import__', 'value': 'os'})

    def test_pandas_data_remain_data_only(self):
        import pandas as pd
        frame = pd.DataFrame({'age': ['20~30', '40'], 'education': ['{a,b}', 'c']}, index=[7, 8])
        pd.testing.assert_frame_equal(codec.unpack(codec.pack(frame)), frame)

    def test_malformed_missing_mask_is_rejected(self):
        import numpy as np
        with self.assertRaises(ValueError):
            codec.unpack({'kind': 'masked_array', 'value': [np.ones(2), np.ones(3, dtype=bool)]})

    def test_hidden_reconstruction_truth_never_crosses_rpc(self):
        import torch
        participant = runtime.Participant({}, 'attack')
        sent = []
        participant.call = lambda operation, values: sent.append((operation, values)) or {}
        model = torch.nn.Linear(2, 2)
        participant.dlg(model, [torch.zeros(2)], reference_images='PRIVATE_IMAGES', reference_labels='PRIVATE_LABELS', seed=42)
        self.assertEqual(sent[0][1]['kwargs'], {'seed': 42})

    def test_poison_budget_and_written_target_are_recomputed(self):
        import numpy as np
        clean = np.array([[1., np.nan], [2., 3.]], dtype=np.float32)
        poisoned = clean.copy(); poisoned[0, 1] = 5
        _matrix, changed, written = runtime.validate_poison31({'poisoned': poisoned, 'used': 0, 'written_target': [False, False]}, clean, 1, 1)
        self.assertEqual(int(changed.sum()), 1)
        self.assertEqual(written.tolist(), [True, False])
        with self.assertRaises(runtime.SubmissionError):
            runtime.validate_poison31({'poisoned': poisoned, 'used': 0, 'compliant': True}, clean, 1, 0)
        poisoned[1, 0] = np.nan
        with self.assertRaises(runtime.SubmissionError):
            runtime.validate_poison31({'poisoned': poisoned}, clean, 1, 10)

    def test_fabricated_unlearning_auc_is_not_accepted(self):
        import numpy as np
        import torch
        participant = runtime.Participant({}, 'attack')
        images, labels = np.zeros((2, 32, 32, 3), dtype=np.uint8), np.zeros(2, dtype=np.int64)
        def fake_call(_operation, _values, capability):
            capability.query(codec.pack(torch.zeros((1, 3, 32, 32))))
            return {'verification_auc': 1.0}
        participant.call = fake_call
        reference = types.SimpleNamespace(per_sample_stats=lambda *_args: {'loss': np.zeros(2)}, _auc_from_losses=lambda *_args: .5)
        with self.assertRaises(runtime.SubmissionError):
            participant.forget(reference, lambda values: torch.zeros((len(values), 10)), images, labels, images, labels)

    def test_public_qi_targets_are_batched_without_changing_order(self):
        import numpy as np
        import pandas as pd
        participant = runtime.Participant({}, 'attack')
        targets = pd.DataFrame({'age': [str(n) for n in range(201)]})
        participant.qi_targets = targets
        calls = []
        def fake_call(operation, value):
            calls.append(operation)
            if operation == 'qi_context': return True
            return [np.array([float(row['age'])]) for _, row in value['rows'].iterrows()]
        participant.call = fake_call
        table, context = pd.DataFrame({'age': ['0']}), {}
        result = [participant.qi_distance(row, table, ['age'], context)[0] for _, row in targets.iterrows()]
        self.assertEqual(result, list(range(201)))
        self.assertEqual(calls, ['qi_context', 'qi_batch', 'qi_batch', 'qi_batch'])


if __name__ == '__main__':
    unittest.main()
