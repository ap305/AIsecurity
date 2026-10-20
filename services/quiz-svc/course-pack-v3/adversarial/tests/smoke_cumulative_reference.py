"""Actual course-image smoke: synthetic spans, no network or model calls."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import sys
import tempfile
import types
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, required=True)
    parser.add_argument('--package', type=Path, required=True)
    parser.add_argument('--reference', type=Path, required=True)
    parser.add_argument('--scratch-directory', type=Path)
    parser.add_argument('--expected-reference-sha256', required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.package))
    import bot_runtime
    helper = load('image_cumulative_reference', args.helper)
    repaired = helper.repair_reference(args.reference.read_text('utf-8-sig'))
    reference_sha = hashlib.sha256(repaired.encode('utf8')).hexdigest()
    assert reference_sha == args.expected_reference_sha256 and '\r' not in repaired
    runtime = load('image_frozen_cumulative_runtime', args.package / 'class_runtime.py')
    bootstrap = load('image_cumulative_bootstrap', args.package / 'public/bootstrap.py')
    rows = []
    cases = [('split', 'Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima',
              ['Alpha Bravo Charlie Delta Echo Foxtrot', 'Golf Hotel India Juliet Kilo Lima']),
             ('refusal-fallback', 'Quartz Nebula Cobalt Nimbus Velvet Mosaic 内部配置信息',
              ['Quartz Nebula Cobalt Nimbus Velvet Mosaic', '内部配置信息'])]
    with patch.object(bot_runtime.urllib.request, 'urlopen', side_effect=AssertionError('No network permitted')), \
         tempfile.TemporaryDirectory(dir=args.scratch_directory) as temporary:
        reference = Path(temporary) / 'D27.py'
        reference.write_bytes(repaired.encode('utf8'))
        for name, text, replies in cases:
            spans = [{'id': str(index), 'title': 'synthetic', 'text': text if index == 0 else 'unused_' + str(index)} for index in range(6)]
            trusted = bot_runtime.load_course(args.package / 'course')
            helper.install_trusted_reference(trusted)
            direct = trusted.reference_modules['defense'].GuardedPromptWithLeakFilter(spans=spans)
            worker = bootstrap._load_role(reference, 'defense', data={'spans': spans, 'systemPrompt': 'synthetic base'})
            local = worker.GuardedPromptWithLeakFilter()
            entry = bootstrap.load_student(reference, '')
            calls = []
            class RemoteObject:
                def __init__(self, value): self.value = value
            def invoke(_worker, method, args):
                calls.append(method)
                value = getattr(entry, method)(*args)
                return RemoteObject(value)
            def call_method(remote, method, args):
                calls.append(method)
                return getattr(remote.value, method)(*args)
            bridge = types.SimpleNamespace(invoke=invoke, call_method=call_method, RemoteObject=RemoteObject,
                StudentExecutionError=type('StudentError', (Exception,), {}), EvaluationInfrastructureError=type('InfrastructureError', (Exception,), {}),
                EvaluationTimeoutError=type('TimeoutError', (Exception,), {}))
            with patch.dict(sys.modules, platform_student=bridge):
                remote = runtime.RemoteGuard('synthetic', '27', types.SimpleNamespace(dataset=worker.ds))
                prompts = [guard.system_prompt('synthetic base') for guard in (direct, local, remote)]
                assert len(set(prompts)) == 1
                for reply in replies:
                    first, second, third = [guard.guard_response(reply) for guard in (direct, local, remote)]
                    assert first == second
                    assert third == {key: first[key] for key in ('response', 'filtered', 'mode', 'leak')}
                assert first['filtered'] is True and first['leak']['n_leaked'] == 0
                assert first['response'] == ('' if name == 'refusal-fallback' else worker.REFUSAL_TEXT)
                assert direct.n_filtered == local.n_filtered == 1
                assert direct._delivered == local._delivered
                assert worker.ds.leak_report('\n'.join(direct._delivered))['n_leaked'] == 0
                before = list(direct._delivered)
                try: direct.system_prompt(object())
                except AttributeError: pass
                else: raise AssertionError('Original prompt error was swallowed')
                assert direct._delivered == before
                direct.system_prompt('next synthetic environment')
                assert direct._delivered == []
            rows.append({'case': name, 'trustedBootstrapFrozenRemoteGuardEqual': True, 'visibleLeakCount': 0,
                         'filteredCount': 1, 'rpcMethods': calls})
    print(json.dumps({'assertions': 'passed', 'python': platform.python_version(), 'modelCalls': 0,
        'helperSha256': hashlib.sha256(args.helper.read_bytes()).hexdigest(), 'repairedReferenceSha256': reference_sha,
        'teacherDefenseSha256': hashlib.sha256((args.package / 'course/defense.py').read_bytes()).hexdigest(),
        'frozenRuntimeSha256': hashlib.sha256((args.package / 'class_runtime.py').read_bytes()).hexdigest(), 'cases': rows}))


if __name__ == '__main__': main()
