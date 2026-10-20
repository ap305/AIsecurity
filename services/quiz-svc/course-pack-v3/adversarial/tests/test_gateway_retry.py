"""Loopback HTTP tests for bounded transport recovery, with no provider calls."""
from __future__ import annotations
import contextlib
import http.server
import json
import pathlib
import sys
import threading
import types
import unittest
from unittest.mock import call, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import bot_runtime as runtime


def response(message=None):
    return json.dumps({'choices': [{'message': message or {'content': 'normal failure: score 0'}}]}).encode()


@contextlib.contextmanager
def fixture(plans, budget=1000):
    ledger = types.SimpleNamespace(requests=[], reserved=0, plans=list(plans), budget=budget)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args): pass
        def do_POST(self):
            raw = self.rfile.read(int(self.headers['Content-Length']))
            ledger.requests.append(raw)
            # Match the relay/server admission rule: each admitted POST spends
            # one unit before calling a model, including failed 503 attempts.
            if ledger.reserved >= ledger.budget:
                status, body = 429, b'budget exhausted'
            else:
                ledger.reserved += 1
                status, body = ledger.plans.pop(0) if ledger.plans else (500, b'unexpected extra request')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield runtime.Gateway({'url': f'http://127.0.0.1:{server.server_port}/v1', 'token': 'local-fixture'}), ledger
    finally:
        server.shutdown(); server.server_close(); thread.join()


class GatewayRetryTests(unittest.TestCase):
    messages = [{'role': 'system', 'content': 'pool-owned'}, {'role': 'user', 'content': 'fixed input'}]

    def test_two_503_then_success_charges_all_attempts_and_caches_only_success(self):
        original_urlopen = runtime.urllib.request.urlopen
        with fixture([(503, b'timeout'), (503, b'timeout'), (200, response())]) as (gateway, ledger), \
             patch.object(runtime.time, 'sleep') as sleep, \
             patch.object(runtime.urllib.request, 'urlopen', wraps=original_urlopen) as post:
            first = gateway.message(self.messages)
            first['content'] = 'caller mutation'
            second = gateway.message(self.messages)
        self.assertEqual(second['content'], 'normal failure: score 0')
        self.assertEqual(gateway.calls, 3)
        self.assertEqual(ledger.reserved, 3)
        self.assertEqual(len(ledger.requests), 3)
        self.assertEqual(len(set(ledger.requests)), 1)
        self.assertEqual(json.loads(ledger.requests[0]), {'messages': self.messages[1:]})
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])
        self.assertEqual([c.kwargs['timeout'] for c in post.call_args_list], [90, 90, 90])

    def test_three_503_stop_without_a_fourth_attempt_or_cached_failure(self):
        with fixture([(503, b'timeout')] * 4) as (gateway, ledger), patch.object(runtime.time, 'sleep') as sleep:
            with self.assertRaises(runtime.CourseFailure): gateway.message(self.messages)
        self.assertEqual((gateway.calls, ledger.reserved, len(ledger.requests)), (3, 3, 3))
        self.assertEqual(gateway.cache, {})
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    def test_non_503_statuses_do_not_retry(self):
        for status in (400, 401, 403, 408, 409, 429, 500, 502, 504):
            with self.subTest(status=status), fixture([(status, b'rejected'), (200, response())]) as (gateway, ledger), \
                 patch.object(runtime.time, 'sleep') as sleep:
                with self.assertRaises(runtime.CourseFailure): gateway.message(self.messages)
                self.assertEqual((gateway.calls, ledger.reserved, len(ledger.requests)), (1, 1, 1))
                sleep.assert_not_called()

    def test_429_budget_exhaustion_cannot_be_bypassed_by_retry(self):
        with fixture([(503, b'timeout')] * 3, budget=2) as (gateway, ledger), patch.object(runtime.time, 'sleep') as sleep:
            with self.assertRaises(runtime.CourseFailure): gateway.message(self.messages)
        self.assertEqual((gateway.calls, ledger.reserved, len(ledger.requests)), (3, 2, 3))
        self.assertEqual(sleep.call_args_list, [call(1), call(2)])

    def test_unknown_transport_outcomes_do_not_retry(self):
        for error in (OSError('transport interrupted'), TimeoutError('90 second client deadline')):
            gateway = runtime.Gateway({'url': 'http://unused.invalid/v1', 'token': 'fixture'})
            with self.subTest(error=type(error).__name__), patch.object(runtime.urllib.request, 'urlopen', side_effect=error) as post, \
                 patch.object(runtime.time, 'sleep') as sleep:
                with self.assertRaises(runtime.CourseFailure): gateway.message(self.messages)
                self.assertEqual(gateway.calls, 1)
                post.assert_called_once(); sleep.assert_not_called()

    def test_malformed_success_and_normal_score_failure_do_not_retry(self):
        invalid = [b'{not json', b'{}', b'{"choices": []}', response({'content': ''})]
        for body in invalid:
            with self.subTest(body=body), fixture([(200, body), (200, response())]) as (gateway, ledger), \
                 patch.object(runtime.time, 'sleep') as sleep:
                with self.assertRaises(runtime.CourseFailure): gateway.message(self.messages)
                self.assertEqual((gateway.calls, len(ledger.requests)), (1, 1)); sleep.assert_not_called()
        with fixture([(200, response()), (503, b'should not be requested')]) as (gateway, ledger):
            self.assertEqual(gateway.message(self.messages)['content'], 'normal failure: score 0')
        self.assertEqual((gateway.calls, len(ledger.requests)), (1, 1))

    def test_tool_format_parse_failure_does_not_request_a_replacement(self):
        with fixture([(200, response({'tool_calls': [{'unexpected': 'invalid tool'}]}))]) as (gateway, ledger), \
             patch.object(runtime.time, 'sleep') as sleep:
            with self.assertRaises(runtime.CourseFailure): runtime._compat_response(gateway.message(self.messages))
            self.assertEqual((gateway.calls, len(ledger.requests)), (1, 1)); sleep.assert_not_called()

    def test_retry_replays_only_model_post_not_student_or_tool_actions(self):
        actions = []
        class Env:
            def __init__(self, *_args, **_kwargs): pass
            def attack_won(self): return False
            def execute(self, name, arguments): actions.append(('tool', name, arguments))
        class Agent:
            def reset(self): pass
        def student_attack(_env): actions.append(('student-attack',))
        def student_defense(*_args): actions.append(('student-defense',)); return True
        def episode(env, user, agent, defense):
            result = agent._chat([{'role': 'user', 'content': user}])
            for tool in result['tool_calls']:
                if defense(env, 'pre', tool['name'], tool['arguments'], None, []):
                    env.execute(tool['name'], tool['arguments'])
        course = types.SimpleNamespace(VendorEnv=Env, OpenAIAgent=Agent, TOOLS=[], SYSTEM_PROMPT='fixed',
            build_match_env=lambda: {}, MATCH_USER_MESSAGE='same input', run_episode=episode)
        message = {'tool_calls': [{'id': 'one', 'function': {'name': 'pay', 'arguments': '{"amount":1}'}}]}
        with fixture([(503, b'timeout'), (503, b'timeout'), (200, response(message))]) as (gateway, ledger), \
             patch.object(runtime.time, 'sleep'):
            self.assertFalse(runtime.run_pair(course, '20', student_attack, student_defense, gateway, {'attacker_iban': 'fixture'}))
        self.assertEqual(actions, [('student-attack',), ('student-defense',), ('tool', 'pay', '{"amount":1}')])
        self.assertEqual((gateway.calls, ledger.reserved), (3, 3))


if __name__ == '__main__': unittest.main()
