"""Host-side tests: no archive code, models, or student program is executed."""
import ast
import importlib.util
import pathlib
import sys
import tempfile
import types
import unittest
import zipfile
import numpy as np
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class CodecTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.codec = load('basic_codec', 'codec.py')
    def setUp(self):
        class Device:
            def __init__(self, name):
                self.type = name
        torch = types.ModuleType('torch')
        torch.is_tensor = lambda value: False
        torch.device = Device
        self.mock = patch.dict(sys.modules, {'torch': torch})
        self.mock.start()
        self.addCleanup(self.mock.stop)
    def test_numeric_array_and_integer_metadata_round_trip(self):
        import numpy as np
        value = {'idx_to_char': {0: 'a', 1: 'b'}, 'array': np.array([1, 2, 3], dtype=np.int64), 'tuple': (True, None)}
        result = self.codec.unpack(self.codec.pack(value))
        self.assertEqual(result['idx_to_char'], value['idx_to_char'])
        self.assertEqual(result['tuple'], value['tuple'])
        np.testing.assert_array_equal(result['array'], value['array'])
    def test_nonfinite_values_and_forged_types_are_rejected(self):
        for value in [float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                self.codec.pack(value)
        for value in [{'kind': 'pickle', 'value': b'executable'}, {'kind': 'device', 'value': 'cuda'},
                      {'kind': 'dict', 'value': [['a', 1], ['a', 2]]},
                      {'kind': 'object', 'value': 'abc'}, {'kind': 'array', 'value': [1]}]:
            with self.assertRaises(ValueError):
                self.codec.unpack(value)
    def test_depth_is_bounded(self):
        value = 0
        for _ in range(45):
            value = [value]
        with self.assertRaises(ValueError):
            self.codec.pack(value)


class BuilderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = load('basic_build_test', 'build.py')
    def test_reference_merge_never_executes_source_or_retains_cli(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as temp:
            course = pathlib.Path(temp)
            code = course / 'backend' / 'code'
            code.mkdir(parents=True)
            (code / 'reference.py').write_text("from __future__ import annotations\nclass Model:\n    pass\nif __name__ == '__main__':\n    raise RuntimeError('must not run')\n")
            (code / 'test.py').write_text("from reference import Model\ndef helper():\n    return Model()\nraise RuntimeError('must not run')\n")
            result = self.builder.reference_source(course, {'reference_modules': ['reference']})
            tree = ast.parse(result)
            self.assertTrue(any(isinstance(node, ast.ClassDef) for node in tree.body))
            self.assertFalse(any(isinstance(node, (ast.If, ast.Raise)) for node in tree.body))
            self.assertNotIn('from reference', result)
    def test_resource_archive_cannot_include_backend(self):
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as temp:
            course = pathlib.Path(temp)
            (course / 'student').mkdir()
            (course / 'backend').mkdir()
            (course / 'student' / 'student.py').write_text('raise NotImplementedError()')
            (course / 'backend' / 'secret.py').write_text('answer = 42')
            target = course / 'resources.zip'
            self.builder.resource_zip(course, target)
            with zipfile.ZipFile(target) as archive:
                self.assertEqual(archive.namelist(), ['student.py'])
    def test_all_runtime_files_parse_and_grader_has_no_student_loader(self):
        for path in ROOT.glob('*.py'):
            ast.parse(path.read_text(encoding='utf8'))
        grader = (ROOT / 'grade.py').read_text(encoding='utf8')
        adapter = (ROOT / 'adapter.py').read_text(encoding='utf8')
        self.assertNotIn('exec(', grader)
        self.assertNotIn('torch.load(', grader + adapter)
        self.assertNotIn('import student', grader + adapter)
    def test_formal_test_and_mixed_sequence_data_are_not_published(self):
        import io
        with tempfile.TemporaryDirectory(dir=ROOT / 'tests') as temp:
            course = pathlib.Path(temp) / 'B05-synthetic-fixture'
            data = course / 'student' / 'data'
            data.mkdir(parents=True)
            np.savez(data / 'rnn_train.npz', sequences=np.ones((10, 2)), labels=np.arange(10))
            np.savez(data / 'rnn_test.npz', sequences=np.ones((2, 2)) * 999, labels=np.array([999, 999]))
            (data / 'sequence_dataset.csv').write_text('hidden,test,labels')
            target = course / 'resources.zip'
            changes = self.builder.resource_zip(course, target)
            self.assertEqual(len(changes), 2)
            with zipfile.ZipFile(target) as archive:
                self.assertNotIn('data/sequence_dataset.csv', archive.namelist())
                with np.load(io.BytesIO(archive.read('data/rnn_test.npz')), allow_pickle=False) as replaced:
                    np.testing.assert_array_equal(replaced['labels'], [0, 5])
                    self.assertNotIn(999, replaced['sequences'])
    def test_bert_labels_remain_in_grader(self):
        source = (ROOT / 'bootstrap.py').read_text(encoding='utf8')
        self.assertIn("[0] * len(data['texts'])", source)
        self.assertNotIn("data['labels']", source)
        adapter = (ROOT / 'adapter.py').read_text(encoding='utf8')
        self.assertIn('expected = torch.from_numpy(labels[indices])', adapter)
    def test_authoritative_score_is_not_taken_from_worker(self):
        source = (ROOT / 'grade.py').read_text(encoding='utf8')
        self.assertIn('basic_evaluator.evaluate', source)
        self.assertIn('0 <= score <= 100', source)
        worker = (ROOT / 'bootstrap.py').read_text(encoding='utf8')
        self.assertNotIn('result_path', worker)
        self.assertNotIn('basic_evaluator', worker)


class ResultContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract=load('result_contract_test','result_contract.py')
    def test_metrics_are_bounded_finite_flat_numbers(self):
        values={'qualificationMetric':1.,'legalityGate':True,'score_policy':'private diagnostic',
                'nested':{'Accuracy@0.5':.5,'bad':float('nan')},'array':[1,2]}
        values.update({f'x{i}':i for i in range(200)})
        result=self.contract.numeric_metrics(values)
        self.assertEqual(len(result),100)
        self.assertEqual(result['legalityGate'],1)
        self.assertEqual(result['nested.Accuracy_0.5'],.5)
        self.assertNotIn('score_policy',result)
        self.assertNotIn('nested.bad',result)
        self.assertTrue(all(type(value) in (float,int) for value in result.values()))
    def test_opponent_zero_is_failure_and_equal_positive_threshold_passes(self):
        context={'phase':'opponent','parameters':{'successThreshold':1/48}}
        evaluated={'score':0,'metrics':{'successMetric':0.,'legalityGate':1}}
        self.assertFalse(self.contract.completed(context,evaluated)['success'])
        evaluated['metrics']['successMetric']=1/48
        self.assertTrue(self.contract.completed(context,evaluated)['success'])
        self.assertNotIn('score',self.contract.completed(context,evaluated))
        context['parameters']['successThreshold']=0
        with self.assertRaises(ValueError): self.contract.completed(context,evaluated)


if __name__ == '__main__':
    unittest.main()
