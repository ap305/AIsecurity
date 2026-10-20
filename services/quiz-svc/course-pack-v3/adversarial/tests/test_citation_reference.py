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
import citation_reference as subject
import class_runtime
from bot_runtime import CourseFailure

FIXTURE = '''class EnumerativeCitationProbe:
    def __init__(self, budget=20, seed=42):
        self.budget, self.seed = budget, seed
    def run(self, technique, missing):
        pending = []
        pending.extend(missing[:2])
        return pending
'''
TEST_ROOT = Path(__file__).resolve().parents[5] / '.test-artifacts'


def ast_sha(source):
    return subject._class_ast_sha256(ast.parse(source).body[0])


class CitationReferenceTests(unittest.TestCase):
    def test_ast_pin_ignores_only_empty_python312_type_parameters(self):
        original = ast.parse(FIXTURE).body[0]
        simulated311, simulated312 = copy.deepcopy(original), copy.deepcopy(original)
        for node in ast.walk(simulated311):
            if 'type_params' in node._fields:
                node._fields = tuple(field for field in node._fields if field != 'type_params')
        for node in ast.walk(simulated312):
            if isinstance(node, (ast.ClassDef, ast.FunctionDef)):
                if 'type_params' not in node._fields: node._fields += ('type_params',)
                node.type_params = []
        before = ast.dump(simulated312)
        self.assertEqual(subject._class_ast_sha256(simulated311), subject._class_ast_sha256(simulated312))
        self.assertEqual(ast.dump(simulated312), before)
        simulated312.type_params = [ast.Name(id='T', ctx=ast.Load())]
        self.assertNotEqual(subject._class_ast_sha256(simulated311), subject._class_ast_sha256(simulated312))

    def test_only_exact_enqueue_is_guarded_and_original_method_structure_restored(self):
        with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)):
            revised = subject.repair_reference(FIXTURE)
        tree = ast.parse(revised)
        run = next(n for n in tree.body[0].body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        guards = [n for n in run.body if isinstance(n, ast.If)]
        self.assertEqual(len(guards), 1)
        guard = guards[0]
        self.assertEqual(ast.dump(guard.test), ast.dump(ast.parse("technique == 'citation'", mode='eval').body))
        self.assertEqual(guard.orelse, [])
        run.body[run.body.index(guard):run.body.index(guard)+1] = guard.body
        self.assertEqual(ast.dump(tree), ast.dump(ast.parse(FIXTURE)))
        self.assertTrue(revised.endswith('\n'))
        self.assertNotIn('\r', revised)
        namespace = {}
        exec(revised, namespace)
        runner = namespace['EnumerativeCitationProbe']()
        self.assertEqual(runner.run('citation', ['a', 'b', 'c']), ['a', 'b'])
        self.assertEqual(runner.run('completion', ['a']), [])

    def test_drift_extra_code_unknown_class_and_repair_twice_fail_closed(self):
        with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)):
            revised = subject.repair_reference(FIXTURE)
            for source in (FIXTURE.replace('missing[:2]', 'missing[:3]'), FIXTURE + '\nx=1\n',
                           FIXTURE.replace('EnumerativeCitationProbe', 'Other'), revised):
                with self.assertRaises(ValueError): subject.repair_reference(source)

    def test_trusted_install_checks_raw_hash_and_only_changes_run(self):
        TEST_ROOT.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=TEST_ROOT) as temporary:
            path = Path(temporary) / 'attack.py'
            path.write_bytes(FIXTURE.encode())
            module = types.ModuleType('attack')
            module.__file__ = str(path)
            exec(compile(FIXTURE, str(path), 'exec'), module.__dict__)
            course = types.SimpleNamespace(reference_modules={'attack': module})
            original_class, original_init = module.EnumerativeCitationProbe, module.EnumerativeCitationProbe.__init__
            with patch.object(subject, 'ORIGINAL_CLASS_AST_SHA256', ast_sha(FIXTURE)), \
                 patch.object(subject, 'ORIGINAL_ATTACK_SHA256', hashlib.sha256(FIXTURE.encode()).hexdigest()):
                subject.install_trusted_reference(course)
                self.assertIs(module.EnumerativeCitationProbe, original_class)
                self.assertIs(module.EnumerativeCitationProbe.__init__, original_init)
                self.assertEqual(module.EnumerativeCitationProbe().run('completion', ['a']), [])
                self.assertEqual(path.read_bytes(), FIXTURE.encode())
                with self.assertRaisesRegex(ValueError, 'already repaired'): subject.install_trusted_reference(course)
                path.write_bytes((FIXTURE + '\n# changed bytes').encode())
                with self.assertRaisesRegex(ValueError, 'teacher bytes'): subject.install_trusted_reference(course)

    def test_loader_and_install_errors_propagate_and_restore_original_loader(self):
        for failure in (ValueError('bad teacher'), CourseFailure('student_error', 'RPC')):
            for source in ('loader', 'install'):
                loader = Mock(side_effect=failure) if source == 'loader' else Mock(return_value=object())
                install = Mock(side_effect=failure) if source == 'install' else Mock()
                def main(_context, _result): class_runtime.load_course('/trusted/course')
                with patch.object(class_runtime, 'load_course', loader), patch.object(class_runtime, 'main', main), \
                     patch.object(subject, 'install_trusted_reference', install):
                    with self.assertRaises(type(failure)): subject.main('context.json', 'result.json')
                    self.assertIs(class_runtime.load_course, loader)

    def test_entrypoint_is_only_28_and_calls_private_helper(self):
        for number in ('03', '27', '29', 28):
            with self.assertRaises(ValueError): subject.entrypoint_source(number)
        with patch.object(subject, 'main') as main, patch.object(sys, 'argv', ['grade.py', 'context.json', 'result.json']):
            exec(subject.entrypoint_source('28'), {})
            main.assert_called_once_with('context.json', 'result.json')


if __name__ == '__main__': unittest.main()
