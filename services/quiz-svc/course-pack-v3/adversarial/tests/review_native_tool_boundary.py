"""Frozen public native-tool protocol review; zero model calls or hidden evaluations."""
import argparse
import tempfile
import copy
import hashlib
import json
from pathlib import Path
import sys
import traceback
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import bot_runtime as runtime
import build
import native_tool_boundary as boundary

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--frozen-api-build', type=Path, required=True)
parser.add_argument('--source-root', type=Path, required=True)
parser.add_argument('--report', type=Path, required=True)
args = parser.parse_args()
if args.report.exists(): raise ValueError('Report must be fresh')
args.report.parent.mkdir(parents=True, exist_ok=True)
BUILD = args.frozen_api_build / 'packages'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def native(call_id, name, arguments='{}'):
    return {'id': call_id, 'type': 'function', 'function': {'name': name, 'arguments': arguments}}


def protocol_errors(messages):
    errors, waiting = [], set()
    for index, msg in enumerate(messages):
        if msg['role'] == 'assistant':
            if waiting: errors.append({'kind': 'unanswered_before_assistant', 'index': index})
            for call in msg.get('tool_calls') or []:
                if call.get('type') != 'function' or not isinstance(call.get('function'), dict):
                    errors.append({'kind': 'flat_or_invalid_tool_call_shape', 'index': index})
                cid = call.get('id')
                if not isinstance(cid, str) or not cid or cid in waiting:
                    errors.append({'kind': 'invalid_or_duplicate_tool_call_id', 'index': index})
                else: waiting.add(cid)
        elif msg['role'] == 'tool':
            cid = msg.get('tool_call_id')
            if cid not in waiting: errors.append({'kind': 'orphan_tool_result', 'index': index})
            else: waiting.remove(cid)
        elif waiting:
            errors.append({'kind': 'unanswered_before_non_tool_message', 'index': index})
    if waiting: errors.append({'kind': 'unanswered_tool_calls_at_request', 'count': len(waiting)})
    return errors


class Gateway:
    def __init__(self, replies): self.replies, self.inputs = replies, []
    def message(self, messages):
        self.inputs.append(copy.deepcopy(messages))
        return copy.deepcopy(self.replies[len(self.inputs)-1] if len(self.inputs) <= len(self.replies) else {'content': 'Finished.', 'tool_calls': []})


results, requests = [], {}
with patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('Network disabled')):
    for number in ('20', '21', '22'):
        for enabled in (False, True):
            for case in ('one_valid', 'two_valid', 'mixed_blocked_observed', 'all_blocked', 'text_fallback', 'text_fallback_blocked', 'two_native_rounds', 'text_repeated_ids', 'bad_json_container', 'arguments_not_string', 'internal_env', 'defense_exception', 'rpc_failure'):
                course = runtime.load_course(BUILD / ('A' + number) / 'course')
                cls = getattr(course, {'20': 'VendorEnv', '21': 'AgendaEnv', '22': 'WebEnv'}[number])
                env = cls(course.build_match_env())
                first = 'get_materials' if number == '20' else 'get_user_information'
                second = 'get_purchase_orders' if number == '20' else 'get_user_information'
                argument_tool = {'20': 'get_supplier_quotes', '21': 'read_file', '22': 'open_page'}[number]
                if case == 'text_repeated_ids':
                    replies = [{'content': first + '()', 'tool_calls': []}, {'content': first + '()', 'tool_calls': []}, {'content': 'Finished.', 'tool_calls': []}]
                elif case == 'two_native_rounds':
                    replies = [{'content': '', 'tool_calls': [native('first', first), native('second', second)]}, {'content': '', 'tool_calls': [native('first', first)]}, {'content': 'Finished.', 'tool_calls': []}]
                elif case.startswith('text_fallback'):
                    replies = [{'content': first + '()', 'tool_calls': []}, {'content': 'Finished.', 'tool_calls': []}]
                elif case == 'bad_json_container':
                    replies = [{'content': '', 'tool_calls': [native('first', first)]},
                               {'content': '', 'tool_calls': [native('bad', argument_tool, '[]')]}]
                elif case == 'arguments_not_string':
                    replies = [{'content': '', 'tool_calls': [native('first', first)]},
                               {'content': '', 'tool_calls': [native('bad', argument_tool, {'wrong': 'type'})]}]
                else:
                    calls = [native('first', first)]
                    if case != 'one_valid': calls.append(native('second', second))
                    replies = [{'content': '', 'tool_calls': calls}, {'content': 'Finished.', 'tool_calls': []}]
                gateway = Gateway(replies)
                agent = runtime.gateway_agent(course, number, gateway)
                if enabled: boundary.install(agent, course)
                pre_seen = []
                executions, defenses = [], []
                original_execute = env.execute
                def execute(name, arguments):
                    executions.append({'name': name, 'arguments': copy.deepcopy(arguments)})
                    if case == 'internal_env': raise RuntimeError('synthetic internal execution error')
                    return original_execute(name, arguments)
                env.execute = execute
                def defense(_env, stage, name, arguments, output, history):
                    defenses.append({'stage': stage, 'name': name, 'input': copy.deepcopy(arguments)})
                    if case == 'defense_exception': raise ValueError('synthetic defense exception')
                    if case == 'rpc_failure': raise runtime.CourseFailure('student_error', 'synthetic RPC failure')
                    if stage == 'pre':
                        pre_seen.append(name)
                        if case in ('all_blocked', 'text_fallback_blocked'): return False
                        if case == 'mixed_blocked_observed' and len(pre_seen) == 1: return False
                        return True
                    return None
                row = {'number': number, 'case': case, 'proposal': enabled}
                try:
                    log = course.run_episode(env, course.MATCH_USER_MESSAGE, agent, defense)
                    row.update(status='completed', logHash=digest(log), blocked=sum(r['blocked'] for r in log))
                except BaseException as error:
                    row.update(status='exception', type=type(error).__name__,
                               trace=[{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                                      for frame in traceback.extract_tb(error.__traceback__)])
                state = {key: value for key, value in vars(env).items() if key != 'execute'}
                row.update(syntheticReplies=len(gateway.inputs), executionHash=digest(executions), executionCount=len(executions),
                           defenseHash=digest(defenses), stateHash=digest(state), teacherMessagesHash=digest(agent._messages),
                           transportMessagesHash=digest(gateway.inputs),
                           requestIssues=[{'request': i+1, 'issues': protocol_errors(messages)} for i, messages in enumerate(gateway.inputs)])
                results.append(row)
                requests[number, case, enabled] = gateway.inputs

lookup = {(r['number'], r['case'], r['proposal']): r for r in results}
for number in ('20', '21', '22'):
    for case in ('one_valid', 'two_valid', 'mixed_blocked_observed', 'all_blocked', 'text_fallback', 'text_fallback_blocked', 'two_native_rounds', 'text_repeated_ids'):
        old, new = lookup[number, case, False], lookup[number, case, True]
        assert old['status'] == new['status'] == 'completed'
        for key in ('logHash', 'blocked', 'executionHash', 'executionCount', 'defenseHash', 'stateHash', 'teacherMessagesHash', 'syntheticReplies'):
            assert old[key] == new[key], (number, case, key)
        assert new['syntheticReplies'] == (3 if case in ('two_native_rounds', 'text_repeated_ids') else 2)
        assert all(not item['issues'] for item in new['requestIssues'])
    for case, exception in [('bad_json_container', 'AttributeError'), ('arguments_not_string', 'TypeError')]:
        for enabled in (False, True):
            row = lookup[number, case, enabled]
            assert row['status'] == 'exception' and row['type'] == exception
            assert row['syntheticReplies'] == 2
    for case, exception in [('internal_env', 'RuntimeError'), ('defense_exception', 'ValueError'), ('rpc_failure', 'CourseFailure')]:
        for enabled in (False, True):
            row = lookup[number, case, enabled]
            assert row['status'] == 'exception' and row['type'] == exception
            assert row['syntheticReplies'] == 1
    if number in ('21', '22'):
        for case in ('one_valid', 'two_valid', 'two_native_rounds'):
            assert requests[number, case, False] == requests[number, case, True]
    assert lookup[number, 'all_blocked', True]['executionCount'] == 0
    assert lookup[number, 'mixed_blocked_observed', True]['executionCount'] == 1


# Rebuild only the adjacent Bot range to prove existing 17/18/19 remain byte-identical.
scope = []
with tempfile.TemporaryDirectory(dir=args.report.parent) as temporary:
    destination = Path(temporary) / 'fresh'
    image = json.loads((BUILD / 'A20/manifest.json').read_text('utf8'))['image']
    manifest = build.build(args.source_root, destination, image, 'unused', numbers=('17', '18', '19', '20', '21', '22'))
    for question in manifest['questions']:
        key, number = question['sourceId'], question['sourceId'][1:]
        target, original = destination / 'packages' / key, BUILD / key
        enabled = number in boundary.SUPPORTED_NUMBERS
        assert (target / 'native_tool_boundary.py').exists() is enabled
        assert (question['definition']['evaluation']['version'] == boundary.VERSION) is enabled
        assert ('nativeToolProtocolBoundary' in question) is enabled
        if enabled:
            assert (target / 'grade.py').read_bytes() == boundary.entrypoint_source(number).encode('utf8')
            assert b'\r' not in (target / 'grade.py').read_bytes()
            for name in ('course/test.py', 'course/dataset.py', 'course/attack.py', 'course/defense.py', 'bot_runtime.py', 'frozen.json', 'model-parameters.json'):
                assert (target / name).read_bytes() == (original / name).read_bytes()
            for file in build.files_under(original / 'public'):
                assert file.read_bytes() == (target / file.relative_to(original)).read_bytes()
        else:
            before = {p.relative_to(original).as_posix(): build.sha(p) for p in build.files_under(original)}
            after = {p.relative_to(target).as_posix(): build.sha(p) for p in build.files_under(target)}
            assert before == after
        scope.append({'question': key, 'boundaryEnabled': enabled, 'teacherRuntimePublicFrozenAndParametersUnchanged': True,
                      'allPackageBytesUnchanged': not enabled})

report = {'freshBuilderScope': scope, 'scope': 'Local synthetic public native tool messages, no network/models/hidden tasks; not calibration evidence',
          'assertions': 'passed', 'cases': results,
          'limitation': 'Protocol fixture demonstrates reachable failures; it does not expose or reconstruct provider response bodies.'}
out = args.report
with out.open('x', encoding='utf8') as stream: json.dump(report, stream, ensure_ascii=False, indent=2)
print(json.dumps({'cases': len(results), 'assertions': 'passed', 'modelCalls': 0, 'report': str(out)}, ensure_ascii=False))
