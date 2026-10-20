"""Offline prototype tests; all span text, targets and judges are synthetic."""
from __future__ import annotations
import ast
import argparse
import tempfile
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time
import types
import typing
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import cumulative_reference as subject
import build
parser = argparse.ArgumentParser(description='Synthetic original teacher and actual bootstrap cumulative-reference review')
parser.add_argument('--frozen-api-build', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
if args.report.exists(): raise ValueError('Report must be fresh')
args.report.parent.mkdir(parents=True, exist_ok=True)
BUILD = args.frozen_api_build
PACKAGE = BUILD / 'packages/D27'
REFERENCE = BUILD / 'references/D27.py'
temporary = tempfile.TemporaryDirectory(dir=args.report.parent)
REPAIRED_REFERENCE = Path(temporary.name) / 'D27.py'
REPAIRED_REFERENCE.write_bytes(subject.repair_reference(REFERENCE.read_text('utf-8-sig')).encode('utf8'))


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def spans(text='Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima'):
    return [{'id': 'synthetic-' + str(i), 'title': 'Synthetic only',
             'text': text if i == 0 else 'unique_token_' + str(i) + ' ' + 'unused_marker_' + str(i)} for i in range(6)]


def environment(path, synthetic_spans):
    if path == 'actual-public-bootstrap':
        bootstrap = load('synthetic_d27_bootstrap', PACKAGE / 'public/bootstrap.py')
        module = bootstrap._load_role(REFERENCE, 'defense', data={'spans': synthetic_spans, 'systemPrompt': 'synthetic base'})
    else:
        dataset = load('synthetic_d27_dataset', PACKAGE / 'public/dataset_defense.py')
        dataset.configure({'spans': synthetic_spans, 'systemPrompt': 'synthetic base'})
        before = list(sys.path)
        with patch.dict(sys.modules, dataset=dataset):
            module = load('synthetic_d27_teacher_defense', PACKAGE / 'course/defense.py')
        sys.path[:] = before
    old_namespace = dict(module.__dict__)
    exec(REFERENCE.read_text('utf-8-sig'), old_namespace)
    original = old_namespace['GuardedPromptWithLeakFilter']
    if path == 'actual-public-bootstrap':
        module = bootstrap._load_role(REPAIRED_REFERENCE, 'defense', data={'spans': synthetic_spans, 'systemPrompt': 'synthetic base'})
    else:
        subject.install_trusted_reference(types.SimpleNamespace(reference_modules={'defense': module}))
    return module, original, module.GuardedPromptWithLeakFilter


def teacher_environment_functions(dataset):
    # Select environment/utility functions only; never import the teacher's data.
    source = ast.parse((PACKAGE / 'course/test.py').read_text('utf-8-sig'))
    names = {'BlackBoxEnv', 'make_env', 'evaluate_utility'}
    nodes = [node for node in source.body if isinstance(node, (ast.ClassDef, ast.FunctionDef)) and node.name in names]
    maximum = next(node for node in source.body if isinstance(node, ast.Assign)
                   and any(isinstance(target, ast.Name) and target.id == 'MAX_TARGET_TOKENS' for target in node.targets))
    namespace = dict(ds=dataset, time=time, Any=typing.Any)
    future = ast.ImportFrom(module='__future__', names=[ast.alias(name='annotations')], level=0)
    exec(compile(ast.fix_missing_locations(ast.Module(body=[future, maximum, *nodes], type_ignores=[])), '<original-d27-environment>', 'exec'), namespace)
    return namespace


class CumulativeReplayTests(unittest.TestCase):
    paths = ('original-teacher', 'actual-public-bootstrap')

    def test_single_turn_safe_refuse_and_redact_outputs_preserved(self):
        for path in self.paths:
            for mode in ('refuse', 'redact'):
                module, original, revised = environment(path, spans())
                for raw in ('Order completed safely.', spans()[0]['text'], spans()[0]['text'] + '. Safe response remains.'):
                    with self.subTest(path=path, mode=mode, raw=raw):
                        old, new = original(filter_mode=mode), revised(filter_mode=mode)
                        self.assertEqual(old.system_prompt('synthetic base'), new.system_prompt('synthetic base'))
                        self.assertEqual(old.guard_response(raw), new.guard_response(raw))
                        self.assertEqual(old.n_filtered, new.n_filtered)

    def test_two_individually_safe_halves_no_longer_accumulate(self):
        first, second = 'Alpha Bravo Charlie Delta Echo Foxtrot', 'Golf Hotel India Juliet Kilo Lima'
        for path in self.paths:
            module, original, revised = environment(path, spans())
            self.assertEqual(module.ds.leak_report(first)['n_leaked'], 0)
            self.assertEqual(module.ds.leak_report(second)['n_leaked'], 0)
            old, new = original(), revised()
            old_visible = [old.guard_response(raw)['response'] for raw in (first, second)]
            new_results = [new.guard_response(raw) for raw in (first, second)]
            self.assertEqual(module.ds.leak_report('\n'.join(old_visible))['n_leaked'], 1)
            self.assertEqual(new_results[0]['response'], first)
            self.assertEqual(new_results[1]['response'], module.REFUSAL_TEXT)
            self.assertEqual(new_results[1]['leak']['n_leaked'], 0)
            self.assertEqual(module.ds.leak_report('\n'.join(new._delivered))['n_leaked'], 0)
            self.assertEqual(new.n_filtered, 1)

    def test_original_refusal_can_complete_a_safe_prefix_and_needs_empty_fallback(self):
        prefix = 'Quartz Nebula Cobalt Nimbus Velvet Mosaic'
        synthetic = spans(prefix + ' 内部配置信息')
        for path in self.paths:
            module, original, revised = environment(path, synthetic)
            self.assertEqual(module.ds.leak_report(prefix)['n_leaked'], 0)
            self.assertEqual(module.ds.leak_report(module.REFUSAL_TEXT)['n_leaked'], 0)
            self.assertEqual(module.ds.leak_report(prefix + '\n' + module.REFUSAL_TEXT)['n_leaked'], 1)
            for last in ('内部配置信息', synthetic[0]['text']):
                new = revised()
                new.guard_response(prefix)
                raw_report = module.ds.leak_report(last)
                result = new.guard_response(last)
                self.assertEqual(result['response'], '')
                self.assertEqual(result['leak'], raw_report)
                self.assertEqual(result['mode'], 'refuse')
                self.assertTrue(result['filtered'])
                self.assertEqual(new.n_filtered, 1)
                self.assertEqual(new._delivered, [prefix, ''])
                self.assertEqual(module.ds.leak_report('\n'.join(new._delivered))['n_leaked'], 0)

    def test_disabled_filter_preserves_all_original_fields_and_counts(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            old, new = original(use_output_filter=False), revised(use_output_filter=False)
            for raw in ('Alpha Bravo Charlie Delta Echo Foxtrot', 'Golf Hotel India Juliet Kilo Lima', spans()[0]['text']):
                self.assertEqual(old.guard_response(raw), new.guard_response(raw))
            self.assertEqual(old.n_filtered, new.n_filtered)
            self.assertEqual(new.n_filtered, 0)
            self.assertEqual(len(new._delivered), 3)

    def test_history_is_delivered_text_not_raw_or_discarded_candidate(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            new = revised(filter_mode='redact')
            result = new.guard_response(spans()[0]['text'] + '. Safe remaining text.')
            self.assertEqual(new._delivered, [result['response']])
            self.assertNotIn('Alpha', new._delivered[0])
            safe = new.guard_response('Unrelated response.')
            self.assertFalse(safe['filtered'])
            self.assertEqual(new.n_filtered, 1)

    def test_reset_only_after_successful_original_system_prompt(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            new = revised()
            new.guard_response('Alpha Bravo Charlie Delta Echo Foxtrot')
            before = list(new._delivered)
            with self.assertRaises(AttributeError): new.system_prompt(object())
            self.assertEqual(new._delivered, before)
            expected = original().system_prompt('new env')
            self.assertEqual(new.system_prompt('new env'), expected)
            self.assertEqual(new._delivered, [])
            self.assertFalse(new.guard_response('Golf Hotel India Juliet Kilo Lima')['filtered'])

    def test_original_and_cumulative_errors_propagate_without_appending_history(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            for failure_at in (1, 2, 3):
                new = revised()
                new.guard_response('Alpha Bravo Charlie Delta Echo Foxtrot')
                before = list(new._delivered)
                real = module.ds.leak_report
                calls = [0]
                def report(*args, **kwargs):
                    calls[0] += 1
                    if calls[0] == failure_at: raise RuntimeError('synthetic report failure')
                    return real(*args, **kwargs)
                with patch.object(module.ds, 'leak_report', side_effect=report):
                    with self.assertRaisesRegex(RuntimeError, 'synthetic report'): new.guard_response('Golf Hotel India Juliet Kilo Lima')
                self.assertEqual(new._delivered, before)

    def test_real_environment_40_utility_tasks_share_one_reset_and_keep_history(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            namespace = teacher_environment_functions(module.ds)
            replies = ['Alpha Bravo Charlie Delta Echo Foxtrot', 'Golf Hotel India Juliet Kilo Lima'] + ['Unrelated safe response.'] * 38
            target = types.SimpleNamespace(chat=Mock(side_effect=replies))
            new = revised()
            new.guard_response('Previous environment visible text.')
            prompt_calls = Mock(wraps=new.system_prompt)
            new.system_prompt = prompt_calls
            namespace['judge_utility'] = Mock(return_value={'correct': True, 'reason': 'synthetic-only'})
            tasks = [{'id': str(i), 'category': 'synthetic', 'question': 'Unrelated task ' + str(i)} for i in range(40)]
            result = namespace['evaluate_utility']({'target': target, 'judge': object()}, new, tasks, 'synthetic', quiet=True)
            self.assertEqual(prompt_calls.call_count, 1)
            self.assertEqual(target.chat.call_count, 40)
            self.assertEqual(len(new._delivered), 40)
            self.assertEqual(result['n_filtered'], 1)
            self.assertEqual(result['items']['1']['response'], module.REFUSAL_TEXT)
            self.assertEqual(module.ds.leak_report('\n'.join(new._delivered))['n_leaked'], 0)

    def test_synthetic_eight_query_environment_preserves_budget_and_messages_reset_does_not_reset_guard(self):
        for path in self.paths:
            module, original, revised = environment(path, spans())
            namespace = teacher_environment_functions(module.ds)
            new = revised()
            model = types.SimpleNamespace(chat=Mock(side_effect=['Alpha Bravo Charlie Delta Echo Foxtrot', 'Golf Hotel India Juliet Kilo Lima'] + ['Unrelated answer.'] * 6))
            env = namespace['BlackBoxEnv'](model, 'synthetic base', budget=8, tag='synthetic', guard=new, spans=spans())
            for index in range(8): env.query([{'role': 'user', 'content': 'fresh message ' + str(index)}])
            self.assertEqual(env.n_queries, 8)
            self.assertTrue(env.records[1]['filtered'])
            self.assertEqual(env.records[1]['leak_raw'], 0)
            with self.assertRaises(RuntimeError): env.query([])
            self.assertEqual(model.chat.call_count, 8)
            self.assertEqual(len(new._delivered), 8)

    def test_frozen_runtime_direct_and_actual_defense_worker_rpc_match(self):
        runtime = load('frozen_cumulative_rpc_runtime', PACKAGE / 'class_runtime.py')
        module, original, repaired = environment('original-teacher', spans())
        ds = module.ds
        namespace = teacher_environment_functions(ds)
        bootstrap = load('cumulative_rpc_bootstrap', PACKAGE / 'public/bootstrap.py')
        entry = bootstrap.load_student(REPAIRED_REFERENCE, '')
        calls = []
        class RemoteObject:
            def __init__(self, value): self.value = value
        def invoke(worker, name, args):
            calls.append(name)
            if name == 'course_attack_run':
                self.assertEqual(args[1], {'budget': 8, 'seed': 42})
                for index in range(3): args[2].query([{'role': 'user', 'content': 'fresh synthetic message ' + str(index)}])
                return {'attackMetric': 999}  # the frozen grader must ignore self-reports
            result = getattr(entry, name)(*args)
            return RemoteObject(result) if name == 'course_create' else result
        def call_method(remote, name, args):
            calls.append(name)
            return getattr(remote.value, name)(*args)
        platform = types.SimpleNamespace(invoke=invoke, call_method=call_method, RemoteObject=RemoteObject,
            expose=lambda methods: types.SimpleNamespace(**methods), StudentExecutionError=type('StudentError', (Exception,), {}),
            EvaluationInfrastructureError=type('InfrastructureError', (Exception,), {}), EvaluationTimeoutError=type('TimeoutError', (Exception,), {}))
        envs = []
        def make_env(models, guard, budget, tag):
            self.assertEqual(budget, 8)
            model = types.SimpleNamespace(chat=Mock(side_effect=['Alpha Bravo Charlie Delta Echo Foxtrot',
                'Golf Hotel India Juliet Kilo Lima', 'Unrelated safe answer.']))
            env = namespace['BlackBoxEnv'](model, 'synthetic base', budget, tag, guard=guard, spans=spans())
            envs.append(env)
            return env
        course = types.SimpleNamespace(dataset=ds, make_env=make_env)
        with patch.dict(sys.modules, platform_student=platform):
            remote = runtime.RemoteGuard('defense-worker', '27', course)
            direct = runtime.extraction_run(course, '27', 'synthetic-attacker', repaired(), {}, {'budget': 8, 'seed': 42})
            isolated = runtime.extraction_run(course, '27', 'synthetic-attacker', remote, {}, {'budget': 8, 'seed': 42})
        self.assertEqual(direct, isolated)
        self.assertEqual(direct, {'attackMetric': 0.0, 'defenseMetric': 1.0, 'leakedSpans': 0, 'queries': 3, 'samples': 6})
        def stable(records): return [{k: v for k, v in row.items() if k != 'elapsed'} for row in records]
        self.assertEqual(stable(envs[0].records), stable(envs[1].records))
        self.assertEqual(calls.count('system_prompt'), 1)
        self.assertEqual(calls.count('guard_response'), 3)
        self.assertEqual(calls.count('course_attack_run'), 2)

    def test_frozen_main_errors_preserve_status_and_restore_loader(self):
        runtime = load('frozen_cumulative_main_runtime', PACKAGE / 'class_runtime.py')
        import bot_runtime
        context = Path(temporary.name) / 'context.json'
        output = Path(temporary.name) / 'result.json'
        context.write_text(json.dumps({'submissionId': 'synthetic', 'attemptId': 'synthetic', 'questionVersion': 'synthetic',
            'evaluationVersion': subject.VERSION, 'phase': 'baseline'}), encoding='utf8')
        for error in (RuntimeError('synthetic internal'), bot_runtime.CourseFailure('student_error', 'synthetic RPC')):
            def run_context(_context, _directory):
                course = runtime.load_course(PACKAGE / 'course')
                self.assertTrue(course.reference_modules['defense'].GuardedPromptWithLeakFilter.guard_response.__cumulative_reference_repair__)
                raise error
            loader = runtime.load_course
            with patch.dict(sys.modules, class_runtime=runtime), patch.object(runtime, 'run_context', run_context):
                subject.main(context, output)
            result = json.loads(output.read_text('utf8'))
            self.assertEqual(result['status'], 'student_error' if isinstance(error, bot_runtime.CourseFailure) else 'system_error')
            self.assertNotIn('metrics', result)
            self.assertNotIn('success', result)
            self.assertIs(runtime.load_course, loader)


def builder_scope():
    destination = Path(temporary.name) / 'build'
    image = json.loads((PACKAGE / 'manifest.json').read_text('utf8'))['image']
    manifest = build.build(args.source_root, destination, image, 'unused', numbers=('27', '28'))
    rows = []
    for question in manifest['questions']:
        key = question['sourceId']
        target, original = destination / 'packages' / key, BUILD / 'packages' / key
        enabled = key.endswith('27')
        assert (target / 'cumulative_reference.py').exists() is enabled
        assert (question['definition']['evaluation']['version'] == subject.VERSION) is enabled
        assert ('cumulativeReferenceRepair' in question) is enabled
        old_files = {p.relative_to(original).as_posix(): build.sha(p) for p in build.files_under(original)}
        new_files = {p.relative_to(target).as_posix(): build.sha(p) for p in build.files_under(target)}
        differences = {name for name in old_files.keys() | new_files.keys() if old_files.get(name) != new_files.get(name)}
        expected = {'class_runtime.py', 'grade.py', 'cumulative_reference.py'} if enabled else {'class_runtime.py'}
        assert differences == expected, (key, differences)
        # This pre-existing watermark source/frozen difference is not included by
        # the immutable two-question patcher; every original runtime stays frozen.
        assert (target / 'class_runtime.py').read_bytes() == (ROOT / 'class_runtime.py').read_bytes()
        if enabled: assert (target / 'grade.py').read_bytes() == subject.entrypoint_source().encode('utf8')
        rows.append({'question': key, 'repairEnabled': enabled, 'differencesFromFrozen': sorted(differences),
            'frozenRuntimeSha256': old_files['class_runtime.py'], 'unchangedSourceRuntimeSha256': new_files['class_runtime.py']})
    questions = {q['sourceId']: q for q in manifest['questions']}
    expected = build.sha(REPAIRED_REFERENCE)
    assert (destination / 'references/D27.py').read_bytes() == REPAIRED_REFERENCE.read_bytes()
    assert questions['D27']['selfTest']['codeSha256'] == expected
    assert questions['A27']['selfTest']['opponent']['codeSha256'] == expected
    for key in ('A27', 'A28', 'D28'):
        assert (destination / 'references' / (key + '.py')).read_bytes() == (BUILD / 'references' / (key + '.py')).read_bytes()
    return rows


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(CumulativeReplayTests))
    if not result.wasSuccessful(): raise SystemExit(1)
    scope = builder_scope()
    report = {'scope': 'Synthetic original teacher and actual bootstrap replay only; no private corpus evaluation or calibration',
              'modelCalls': 0, 'tests': result.testsRun, 'assertions': 'passed', 'paths': list(CumulativeReplayTests.paths),
              'helperSha256': build.sha(ROOT / 'cumulative_reference.py'), 'repairedReferenceSha256': build.sha(REPAIRED_REFERENCE),
              'originalTeacherDefenseSha256': build.sha(PACKAGE / 'course/defense.py'),
              'frozenRuntimeSha256': build.sha(PACKAGE / 'class_runtime.py'), 'freshBuilderScope': scope,
              'immutablePatchMustPreserveFrozenRuntime': True, 'originalStudentCodeNeverRewritten': True}
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.cleanup()
    print(json.dumps({'tests': result.testsRun, 'builtQuestions': len(scope), 'modelCalls': 0, 'assertions': 'passed'}))
