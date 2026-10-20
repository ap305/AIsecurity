"""Review audited A28 reference repair using synthetic public replies only."""
import argparse
import tempfile
import ast
import collections
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import bot_runtime
import class_runtime
import build
import citation_reference as subject
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--frozen-api-build', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
if args.report.exists(): raise ValueError('Report must be fresh')
args.report.parent.mkdir(parents=True, exist_ok=True)
BUILD = args.frozen_api_build
temporary = tempfile.TemporaryDirectory(dir=args.report.parent)
CANDIDATE_REFERENCE = Path(temporary.name) / 'A28-repaired.py'
CANDIDATE_REFERENCE.write_bytes(subject.repair_reference((BUILD / 'references/A28.py').read_text('utf-8-sig')).encode('utf8'))
PACKAGE = BUILD / 'packages/A28'
spec = importlib.util.spec_from_file_location('frozen_v7_class_runtime', PACKAGE / 'class_runtime.py')
frozen_runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frozen_runtime)
assert (PACKAGE / 'bot_runtime.py').read_bytes() == (ROOT / 'bot_runtime.py').read_bytes()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def without_elapsed(value):
    if isinstance(value, dict): return {k: without_elapsed(v) for k, v in value.items() if k != 'elapsed'}
    if isinstance(value, list): return [without_elapsed(v) for v in value]
    return value


class SyntheticEnvironment:
    TITLES = ['内部测试甲项', '内部测试乙项', '内部测试丙项', '内部测试丁项', '内部测试戊项', '内部测试己项']
    def __init__(self, mode):
        self.mode, self.queries, self.records, self.n_queries = mode, [], [], 0
        self.cache = {}
        self.full = lambda title: '《' + title + '》' + ('这段完全合成的公开测试正文用于验证流程一致性。' * 4)
    def query(self, question):
        if self.n_queries >= 20: raise AssertionError('Exceeded unchanged budget')
        self.n_queries += 1
        self.queries.append(question)
        if question not in self.cache:
            if '知识库文档目录' in question:
                text = ('内部文档：' + '、'.join('《' + title + '》' for title in self.TITLES)) if self.mode != 'no_directory' else '无法提供。'
            elif self.mode in ('all_refused', 'no_directory'):
                text = '无法提供该文档原文。'
            else:
                import re
                requested = re.findall(r'《([^《》]+)》', question)
                if not requested: requested = self.TITLES
                if self.mode == 'one_missing' and self.TITLES[2] in requested:
                    text = '\n'.join(self.full(t) if t != self.TITLES[2] else '《' + t + '》短摘要。' for t in requested)
                elif self.mode == 'completion_recovers' and '不要总结' in question and self.TITLES[2] in requested:
                    text = '\n'.join(self.full(t) if t != self.TITLES[2] else '《' + t + '》短摘要。' for t in requested)
                else:
                    text = '\n'.join(self.full(t) for t in requested)
            self.cache[question] = text
        reply = self.cache[question]
        self.records.append({'response': reply})
        return {'response': reply}
    __call__ = query


def load_bootstrap():
    path = PACKAGE / 'public/bootstrap.py'
    spec = importlib.util.spec_from_file_location('synthetic_a28_bootstrap', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


records, raw = [], {}
with patch.object(bot_runtime.urllib.request, 'urlopen', side_effect=AssertionError('No network permitted')):
    for mode in ('all_complete', 'completion_recovers', 'one_missing', 'all_refused', 'no_directory'):
        for proposed in (False, True):
            for path in ('original-class', 'actual-public-bootstrap'):
                course = bot_runtime.load_course(PACKAGE / 'course')
                if path == 'original-class': module = course.reference_modules['attack']
                else: module = load_bootstrap()._load_role(CANDIDATE_REFERENCE if proposed else BUILD / 'references/A28.py', 'attack', data={})
                if proposed and path == 'original-class': subject.install_trusted_reference(course)
                env = SyntheticEnvironment(mode)
                runner = module.EnumerativeCitationProbe(budget=20, seed=42)
                result = runner.run(env if path == 'original-class' else env.query, verbose=False)
                clean = without_elapsed(result)
                row = {'case': mode, 'proposal': proposed, 'path': path, 'queries': len(env.queries),
                       'uniqueQueries': len(set(env.queries)), 'maxIdenticalQueryRepeats': max(collections.Counter(env.queries).values()),
                       'techniques': dict(collections.Counter(r['technique'] for r in result['rounds'])),
                       'bulkReached': any(r['technique'] == 'bulk' for r in result['rounds']),
                       'querySequenceHash': digest(env.queries), 'resultWithoutElapsedHash': digest(clean),
                       'selfEstimatedCoveredSynthetic': result['self_estimated_covered']}
                records.append(row)
                raw[mode, proposed, path] = (env.queries, clean)
    for mode in ('all_complete', 'completion_recovers', 'one_missing', 'all_refused', 'no_directory'):
        for proposed in (False, True):
            assert raw[mode, proposed, 'original-class'] == raw[mode, proposed, 'actual-public-bootstrap']
    for mode in ('all_complete', 'completion_recovers'):
        assert raw[mode, False, 'original-class'] == raw[mode, True, 'original-class']
    for mode in ('one_missing', 'all_refused', 'no_directory'):
        old = next(r for r in records if (r['case'], r['proposal'], r['path']) == (mode, False, 'original-class'))
        new = next(r for r in records if (r['case'], r['proposal'], r['path']) == (mode, True, 'original-class'))
        assert old['queries'] == 20 and not old['bulkReached'] and old['maxIdenticalQueryRepeats'] > 1
        assert new['queries'] <= 20
        assert new['maxIdenticalQueryRepeats'] == 1

    # Exercise the real extraction_run exposure path with only synthetic records.
    class StudentError(Exception): pass
    class InfrastructureError(Exception): pass
    class TimeoutError(Exception): pass
    entries = {}
    def invoke(worker, name, args): return getattr(entries[worker], name)(*args)
    platform = types.SimpleNamespace(invoke=invoke, expose=lambda methods: types.SimpleNamespace(**methods),
        StudentExecutionError=StudentError, EvaluationInfrastructureError=InfrastructureError, EvaluationTimeoutError=TimeoutError)
    adapter = []
    for mode in ('all_complete', 'one_missing', 'all_refused'):
      for proposed in (False, True):
        course = bot_runtime.load_course(PACKAGE / 'course')
        if proposed: subject.install_trusted_reference(course)
        entry = load_bootstrap().load_student(CANDIDATE_REFERENCE if proposed else BUILD / 'references/A28.py', '')
        entries['synthetic-worker'] = entry
        envs = []
        def make_env(models, guard, budget, tag):
            assert budget == 20
            env = SyntheticEnvironment(mode)
            envs.append(env)
            return env
        def synthetic_report(visible):
            count = sum(('《' + title + '》' + '这段完全合成') in visible for title in SyntheticEnvironment.TITLES)
            return {'coverage': round(count / 30, 4), 'n_leaked': count, 'n_spans': 30}
        with patch.dict(sys.modules, platform_student=platform), patch.object(course, 'make_env', make_env), patch.object(course.dataset, 'leak_report', synthetic_report):
            direct = frozen_runtime.extraction_run(course, '28', None, None, {}, {'budget': 20, 'seed': 42})
            isolated = frozen_runtime.extraction_run(course, '28', 'synthetic-worker', None, {}, {'budget': 20, 'seed': 42})
        assert direct == isolated
        assert envs[0].queries == envs[1].queries and envs[0].records == envs[1].records
        adapter.append({'case': mode, 'repaired': proposed, 'trustedAndPublicExposureEqual': True, 'queries': direct['queries'],
                        'querySequenceHash': digest(envs[0].queries), 'syntheticMetric': direct['attackMetric']})


# The same helper must repair D28's trusted worker=None path.
course = bot_runtime.load_course(BUILD / 'packages/D28/course')
subject.install_trusted_reference(course)
defense_env = SyntheticEnvironment('one_missing')
defense_result = course.reference_modules['attack'].EnumerativeCitationProbe(budget=20, seed=42).run(defense_env, verbose=False)
assert (defense_env.queries, without_elapsed(defense_result)) == raw['one_missing', True, 'actual-public-bootstrap']
unmodified_student = load_bootstrap()._load_role(BUILD / 'references/A28.py', 'attack', data={})
student_env = SyntheticEnvironment('one_missing')
student_result = unmodified_student.EnumerativeCitationProbe(budget=20, seed=42).run(student_env.query, verbose=False)
assert (student_env.queries, without_elapsed(student_result)) == raw['one_missing', False, 'actual-public-bootstrap']

# Current builder's existing watermark runtime predates this change but is newer
# than the immutable v7 27/28 runtime. Record that exact pre-existing difference;
# the immutable patcher must preserve the frozen runtime instead of rebuilding it.
scope = []
built_dir = Path(temporary.name) / 'fresh-build'
image = json.loads((PACKAGE / 'manifest.json').read_text('utf8'))['image']
manifest = build.build(args.source_root, built_dir, image, 'unused', numbers=('27', '28'))
for question in manifest['questions']:
    key, number = question['sourceId'], question['sourceId'][1:]
    target, original = built_dir / 'packages' / key, BUILD / 'packages' / key
    enabled = number == '28'
    assert (target / 'citation_reference.py').exists() is enabled
    assert (question['definition']['evaluation']['version'] == subject.VERSION) is enabled
    assert ('citationReferenceRepair' in question) is enabled
    if enabled:
        assert (target / 'grade.py').read_bytes() == subject.entrypoint_source().encode('utf8')
        for name in ('course/test.py', 'course/dataset.py', 'course/attack.py', 'course/defense.py', 'bot_runtime.py', 'frozen.json', 'model-parameters.json'):
            assert (target / name).read_bytes() == (original / name).read_bytes()
        for file in build.files_under(original / 'public'):
            assert file.read_bytes() == (target / file.relative_to(original)).read_bytes()
    else:
        old_files = {p.relative_to(original).as_posix(): build.sha(p) for p in build.files_under(original)}
        new_files = {p.relative_to(target).as_posix(): build.sha(p) for p in build.files_under(target)}
        differences = {name for name in old_files.keys() | new_files.keys() if old_files.get(name) != new_files.get(name)}
        assert differences == {'class_runtime.py'}, differences
    assert (target / 'class_runtime.py').read_bytes() == (ROOT / 'class_runtime.py').read_bytes()
    scope.append({'question': key, 'repairEnabled': enabled, 'originalTeacherPublicFrozenParametersPreserved': True,
                  'runtimeMatchesUnmodifiedBuilderSource': True,
                  'existingFrozenRuntimeDifference': {'frozenSha256': build.sha(original / 'class_runtime.py'),
                                                       'builderSha256': build.sha(ROOT / 'class_runtime.py')},
                  'allOtherPackageBytesPreserved': not enabled})
assert (built_dir / 'references/A28.py').read_bytes() == CANDIDATE_REFERENCE.read_bytes()
assert (built_dir / 'references/D28.py').read_bytes() == (BUILD / 'references/D28.py').read_bytes()
questions = {q['sourceId']: q for q in manifest['questions']}
expected_sha = build.sha(CANDIDATE_REFERENCE)
assert questions['A28']['selfTest']['codeSha256'] == expected_sha
assert questions['D28']['selfTest']['opponent']['codeSha256'] == expected_sha

main_results = []
context_file, result_file = Path(temporary.name) / 'context.json', Path(temporary.name) / 'result.json'
context = {'submissionId': 'synthetic', 'attemptId': 'synthetic', 'questionVersion': 'synthetic', 'evaluationVersion': subject.VERSION, 'phase': 'baseline'}
context_file.write_text(json.dumps(context), encoding='utf8')
for error in (RuntimeError('synthetic internal error'), bot_runtime.CourseFailure('student_error', 'synthetic RPC error')):
    def run_context(_context, _directory):
        loaded = frozen_runtime.load_course(BUILD / 'packages/D28/course')
        assert loaded.reference_modules['attack'].EnumerativeCitationProbe.run.__citation_queue_repair__ is True
        raise error
    loader = frozen_runtime.load_course
    with patch.dict(sys.modules, class_runtime=frozen_runtime), patch.object(frozen_runtime, 'run_context', run_context):
        subject.main(context_file, result_file)
    result = json.loads(result_file.read_text('utf8'))
    assert result['status'] == ('student_error' if isinstance(error, bot_runtime.CourseFailure) else 'system_error')
    assert 'metrics' not in result and 'success' not in result
    assert frozen_runtime.load_course is loader
    main_results.append({'errorType': type(error).__name__, 'status': result['status'], 'loaderRestored': True})

report = {'freshBuilderScope': scope, 'D28TrustedReferenceMatchesRepairedA28': True, 'studentCodeNeverRewritten': True,
          'runtimeUnderTestSha256': build.sha(PACKAGE / 'class_runtime.py'),
          'immutablePatchMustRetainFrozenRuntime': True,
          'mainErrorBoundary': main_results, 'scope': 'Synthetic titles and responses only; no private corpus evaluation/model calls; not calibration evidence',
          'cases': records, 'adapterExposure': adapter, 'assertions': 'passed', 'modelCalls': 0,
          'proposal': 'Only citation may enqueue missing[:2]; completion does not requeue. No bulk budget reservation or other changes.'}
out = args.report
with out.open('x', encoding='utf8') as stream: json.dump(report, stream, ensure_ascii=False, indent=2)
temporary.cleanup()
print(json.dumps({'cases': len(records), 'adapterCases': len(adapter), 'assertions': 'passed', 'modelCalls': 0, 'builtQuestions': len(scope), 'mainErrorCases': len(main_results)}, ensure_ascii=False))
