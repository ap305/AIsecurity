"""Run inside the actual course image with --network none; synthetic replies only."""
import argparse
import ast
import collections
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import re
import sys
import tempfile
import types
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def clean(value):
    if isinstance(value, dict): return {key: clean(item) for key, item in value.items() if key != 'elapsed'}
    if isinstance(value, list): return [clean(item) for item in value]
    return value


class SyntheticEnvironment:
    titles = ['测试甲项', '测试乙项', '测试丙项', '测试丁项', '测试戊项', '测试己项']
    def __init__(self, refuse):
        self.refuse, self.queries = refuse, []
        self.records, self.n_queries = [], 0
    def query(self, text):
        assert len(self.queries) < 20
        self.queries.append(text)
        self.n_queries += 1
        if '知识库文档目录' in text:
            reply = '、'.join('《' + title + '》' for title in self.titles)
        elif self.refuse:
            reply = '无法提供文档正文。'
        else:
            requested = re.findall(r'《([^《》]+)》', text) or self.titles
            reply = '\n'.join('《' + title + '》' + '这是用于协议回放的公开合成文字。' * 10 for title in requested)
        self.records.append({'response': reply})
        return {'response': reply}
    __call__ = query


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
    helper = load('image_citation_reference', args.helper)
    original_reference = args.reference.read_text('utf-8-sig')
    repaired = helper.repair_reference(original_reference)
    repaired_sha = hashlib.sha256(repaired.encode('utf8')).hexdigest()
    assert repaired_sha == args.expected_reference_sha256
    assert '\r' not in repaired
    bootstrap = load('image_citation_bootstrap', args.package / 'public/bootstrap.py')
    runtime = load('image_frozen_class_runtime', args.package / 'class_runtime.py')
    cases = []
    with patch.object(bot_runtime.urllib.request, 'urlopen', side_effect=AssertionError('No model/network calls permitted')), tempfile.TemporaryDirectory(dir=args.scratch_directory) as temporary:
        reference = Path(temporary) / 'reference.py'
        reference.write_bytes(repaired.encode('utf8'))
        for refuse in (False, True):
            original = bot_runtime.load_course(args.package / 'course')
            original_env = SyntheticEnvironment(refuse)
            original_result = original.reference_modules['attack'].EnumerativeCitationProbe(budget=20, seed=42).run(original_env, verbose=False)
            trusted = bot_runtime.load_course(args.package / 'course')
            helper.install_trusted_reference(trusted)
            trusted_env = SyntheticEnvironment(refuse)
            trusted_result = trusted.reference_modules['attack'].EnumerativeCitationProbe(budget=20, seed=42).run(trusted_env, verbose=False)
            student = bootstrap._load_role(reference, 'attack', data={})
            worker_env = SyntheticEnvironment(refuse)
            worker_result = student.EnumerativeCitationProbe(budget=20, seed=42).run(worker_env.query, verbose=False)
            assert trusted_env.queries == worker_env.queries
            assert clean(trusted_result) == clean(worker_result)
            if refuse:
                assert len(original_env.queries) == 20
                assert max(collections.Counter(original_env.queries).values()) > 1
                assert max(collections.Counter(trusted_env.queries).values()) == 1
            else:
                assert original_env.queries == trusted_env.queries
                assert clean(original_result) == clean(trusted_result)
            # Exercise the immutable grader's real trusted worker=None branch,
            # with synthetic visible records instead of hidden corpus scoring.
            runtime_env = SyntheticEnvironment(refuse)
            def forbidden_rpc(*_args, **_kwargs):
                raise AssertionError('Trusted reference must not invoke a student RPC')
            def leak_report(visible):
                count = sum(('《' + title + '》这是用于协议回放') in visible for title in runtime_env.titles)
                return {'coverage': round(count / 30, 4), 'n_leaked': count, 'n_spans': 30}
            with patch.dict(sys.modules, platform_student=types.SimpleNamespace(invoke=forbidden_rpc, expose=forbidden_rpc)), \
                 patch.object(trusted, 'make_env', return_value=runtime_env) as make_env, \
                 patch.object(trusted.dataset, 'leak_report', side_effect=leak_report):
                metrics = runtime.extraction_run(trusted, '28', None, None, {}, {'budget': 20, 'seed': 42})
            make_env.assert_called_once_with({}, None, budget=20, tag='platform-pair')
            observed = leak_report('\n'.join(row['response'] for row in runtime_env.records))
            assert metrics == {'attackMetric': observed['coverage'], 'defenseMetric': 1 - observed['coverage'],
                               'leakedSpans': observed['n_leaked'], 'queries': runtime_env.n_queries, 'samples': 30}
            assert runtime_env.queries == trusted_env.queries and runtime_env.records == trusted_env.records
            cases.append({'refusal': refuse, 'originalQueries': len(original_env.queries),
                          'repairedQueries': len(trusted_env.queries), 'trustedAndBootstrapEqual': True,
                          'frozenExtractionRunEqual': True, 'rpcCalls': 0})
    print(json.dumps({'assertions': 'passed', 'python': platform.python_version(), 'modelCalls': 0,
                      'helperSha256': hashlib.sha256(args.helper.read_bytes()).hexdigest(),
                      'teacherSha256': hashlib.sha256((args.package / 'course/attack.py').read_bytes()).hexdigest(),
                      'frozenRuntimeSha256': hashlib.sha256((args.package / 'class_runtime.py').read_bytes()).hexdigest(),
                      'canonicalOriginalClassAstSha256': helper._class_ast_sha256(ast.parse(original_reference).body[0]),
                      'repairedReferenceSha256': repaired_sha, 'cases': cases}))


if __name__ == '__main__': main()
