from __future__ import annotations
import ast
import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cumulative_reference as subject
import class_runtime
from bot_runtime import CourseFailure

FIXTURE = '''class GuardedPromptWithLeakFilter:
    def __init__(self, use_output_filter=True):
        self.use_output_filter = use_output_filter
        self.spans = []
        self.n_filtered = 0
    def system_prompt(self, base_prompt=None):
        if base_prompt is None:
            return 'base'
        return base_prompt.rstrip()
    def guard_response(self, response):
        report = ds.leak_report(response, self.spans)
        if not self.use_output_filter or not report['n_leaked']:
            return dict(response=response, filtered=False, mode=None, leak=report, dropped_sentences=[])
        self.n_filtered += 1
        return dict(response=REFUSAL_TEXT, filtered=True, mode='refuse', leak=report, dropped_sentences=[])
    def describe(self):
        return 'original description'
'''
TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'


def ast_sha(source):
    return subject._class_ast_sha256(ast.parse(source).body[0])


def namespace():
    def report(text, _spans):
        return {'n_leaked': int('CONFIDENTIAL' in ''.join(text.split()))}
    return {'ds': types.SimpleNamespace(leak_report=report), 'REFUSAL_TEXT': 'Refused safely.'}


class CumulativeReferenceTests(unittest.TestCase):
    def test_cumulative_guard_and_reset_preserve_single_turn_body_and_signature(self):
        with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)):
            repaired = subject.repair_reference(FIXTURE)
        old = ast.parse(FIXTURE).body[0]
        new = ast.parse(repaired).body[0]
        old_methods = {n.name: n for n in old.body if isinstance(n, ast.FunctionDef)}
        new_methods = {n.name: n for n in new.body if isinstance(n, ast.FunctionDef)}
        for name in old_methods:
            self.assertEqual(ast.dump(old_methods[name].args), ast.dump(new_methods[name].args))
        self.assertEqual(ast.dump(old_methods['describe']), ast.dump(new_methods['describe']))
        self.assertEqual([ast.dump(n) for n in old_methods['guard_response'].body],
                         [ast.dump(n) for n in new_methods['guard_response'].body[0].body])
        ns = namespace()
        exec(repaired, ns)
        guard = ns['GuardedPromptWithLeakFilter']()
        first = guard.guard_response('CONFI')
        second = guard.guard_response('DENTIAL')
        self.assertFalse(first['filtered'])
        self.assertEqual(second['response'], ns['REFUSAL_TEXT'])
        self.assertEqual(second['leak']['n_leaked'], 0)
        self.assertEqual(guard.n_filtered, 1)
        self.assertEqual(guard._delivered, ['CONFI', ns['REFUSAL_TEXT']])
        with self.assertRaises(AttributeError): guard.system_prompt(object())
        self.assertEqual(len(guard._delivered), 2)
        self.assertEqual(guard.system_prompt('new env '), 'new env')
        self.assertEqual(guard._delivered, [])
        self.assertFalse(guard.guard_response('DENTIAL')['filtered'])
        self.assertNotIn('\r', repaired)

    def test_ast_pin_ignores_only_empty_python312_type_parameters(self):
        original = ast.parse(FIXTURE).body[0]
        older, newer = copy.deepcopy(original), copy.deepcopy(original)
        for node in ast.walk(older):
            node._fields = tuple(field for field in node._fields if field != 'type_params')
        for node in ast.walk(newer):
            if isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                if 'type_params' not in node._fields: node._fields += ('type_params',)
                node.type_params = []
        before = ast.dump(newer)
        self.assertEqual(subject._class_ast_sha256(older), subject._class_ast_sha256(newer))
        self.assertEqual(ast.dump(newer), before)
        newer.type_params = [ast.Name(id='T', ctx=ast.Load())]
        self.assertNotEqual(subject._class_ast_sha256(older), subject._class_ast_sha256(newer))

    def test_drift_extra_code_unknown_class_and_second_repair_fail_closed(self):
        with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)):
            repaired = subject.repair_reference(FIXTURE)
            for source in (FIXTURE.replace('self.n_filtered = 0', 'self.n_filtered = 1'),
                           FIXTURE + '\nx=1\n', FIXTURE.replace('GuardedPromptWithLeakFilter', 'Other'), repaired):
                with self.assertRaises(ValueError): subject.repair_reference(source)

    def test_trusted_install_checks_raw_hash_preserves_class_other_methods_and_file(self):
        TEST_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            path = Path(temporary) / 'defense.py'
            path.write_bytes(FIXTURE.encode())
            module = types.ModuleType('defense')
            module.__file__ = str(path)
            module.__dict__.update(namespace())
            exec(FIXTURE, module.__dict__)
            course = types.SimpleNamespace(reference_modules={'defense': module})
            original, description = module.GuardedPromptWithLeakFilter, module.GuardedPromptWithLeakFilter.describe
            with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)), \
                 patch.object(subject, 'ORIGINAL_DEFENSE_SHA256', hashlib.sha256(FIXTURE.encode()).hexdigest()):
                subject.install_trusted_reference(course)
                self.assertIs(module.GuardedPromptWithLeakFilter, original)
                self.assertIs(module.GuardedPromptWithLeakFilter.describe, description)
                guard = original()
                guard.guard_response('CONFI')
                self.assertTrue(guard.guard_response('DENTIAL')['filtered'])
                self.assertEqual(path.read_bytes(), FIXTURE.encode())
                with self.assertRaisesRegex(ValueError, 'already repaired'): subject.install_trusted_reference(course)
                path.write_bytes((FIXTURE + '\n# drift').encode())
                with self.assertRaisesRegex(ValueError, 'teacher bytes'): subject.install_trusted_reference(course)

    def test_loader_and_install_errors_propagate_and_restore(self):
        for failure in (ValueError('bad teacher'), CourseFailure('student_error', 'RPC')):
            for source in ('loader', 'install'):
                loader = Mock(side_effect=failure) if source == 'loader' else Mock(return_value=object())
                install = Mock(side_effect=failure) if source == 'install' else Mock()
                def main(_context, _result): class_runtime.load_course('/trusted/course')
                with patch.object(class_runtime, 'load_course', loader), patch.object(class_runtime, 'main', main), \
                     patch.object(subject, 'install_trusted_reference', install):
                    with self.assertRaises(type(failure)): subject.main('context.json', 'result.json')
                    self.assertIs(class_runtime.load_course, loader)

    def test_entrypoint_is_only_27_and_calls_private_helper(self):
        for number in ('03', '28', '29', 27):
            with self.assertRaises(ValueError): subject.entrypoint_source(number)
        with patch.object(subject, 'main') as main, patch.object(sys, 'argv', ['grade.py', 'context.json', 'result.json']):
            exec(subject.entrypoint_source('27'), {})
            main.assert_called_once_with('context.json', 'result.json')


if __name__ == '__main__': unittest.main()
