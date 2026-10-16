from __future__ import annotations

import importlib.util
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import bot_runtime as runtime


class BotContractTests(unittest.TestCase):
    def test_opponent_is_executed_and_failure_is_zero(self):
        course = types.SimpleNamespace(make_matches=lambda n, seed: list(range(n)))
        student, opponent = object(), object()
        calls = []
        def pair(_course, _number, attack, defense, _gateway, match):
            calls.append((attack, defense, match))
            return False
        with patch.object(runtime, "run_pair", pair):
            result = runtime.evaluate(course, "20", "attack", "opponent", student, opponent, {"samples": 3, "seed": 42}, None)
        self.assertEqual(result["successMetric"], 0)
        self.assertEqual(calls, [(student, opponent, n) for n in range(3)])

    def test_defense_role_reverses_roles_not_metric_source(self):
        course = types.SimpleNamespace(make_matches=lambda n, seed: list(range(n)))
        student, opponent = object(), object()
        def pair(_course, _number, attack, defense, _gateway, match):
            self.assertIs(attack, opponent)
            self.assertIs(defense, student)
            return match == 0
        with patch.object(runtime, "run_pair", pair):
            result = runtime.evaluate(course, "20", "defense", "opponent", student, opponent, {"samples": 4, "seed": 42}, None)
        self.assertEqual(result["successMetric"], .75)

    def test_baseline_does_not_use_an_opponent(self):
        course = types.SimpleNamespace(make_matches=lambda n, seed: list(range(n)), reference_defense=object())
        with patch.object(runtime, "run_pair", return_value=True) as call:
            metrics = runtime.evaluate(course, "20", "attack", "baseline", object(), None, {"samples": 2, "seed": 42}, None)
        self.assertEqual(metrics["qualificationMetric"], 100)
        self.assertEqual(call.call_count, 4)
        self.assertIs(call.call_args_list[0].args[3], course.reference_defense)

    def test_illegal_defense_cannot_qualify_even_if_it_wins(self):
        course = types.SimpleNamespace(make_matches=lambda n, seed: list(range(n)), reference_attack=object())
        with patch.object(runtime, "run_pair", return_value=False), patch.object(runtime, "defense_false_positive", return_value=.11):
            result = runtime.evaluate(course, "20", "defense", "baseline", object(), None, {"samples": 2, "seed": 42}, None)
        self.assertEqual(result["qualificationMetric"], -1)

    def test_zero_reference_needs_one_real_success(self):
        self.assertEqual(runtime.calibrated_success_threshold(0, 20), .05)
        self.assertEqual(runtime.calibrated_success_threshold(.25, 20), .25)
        for rate in (float("nan"), float("inf"), -1, 2, True):
            with self.assertRaises(ValueError):
                runtime.calibrated_success_threshold(rate, 20)

    def test_private_environment_fields_are_not_exposed(self):
        env = types.SimpleNamespace(attacker_account="secret", user_message="visible", _orders={"a": 1}, payouts=["hidden"], history=["hidden"])
        values, methods = runtime.environment_exposure("18", "defense", env)
        self.assertEqual(set(values), {"user_message", "_orders"})
        self.assertEqual(methods, {})
        values["_orders"]["a"] = 999
        self.assertEqual(env._orders["a"], 1)

    def test_worker_outage_is_not_swallowed_by_legacy_exception(self):
        class StudentError(Exception): pass
        class InfrastructureError(Exception): pass
        class TimeoutError(Exception): pass
        def invoke(*_args, **_kwargs): raise InfrastructureError("secret raw error")
        module = types.SimpleNamespace(invoke=invoke, expose=lambda **kwargs: kwargs, StudentExecutionError=StudentError,
                                       EvaluationInfrastructureError=InfrastructureError, EvaluationTimeoutError=TimeoutError)
        with patch.dict(sys.modules, platform_student=module):
            function = runtime.remote_function({}, "14", "attack")
            try:
                try:
                    function(types.SimpleNamespace(attacker_iban="sample", set_file=lambda *_: None))
                except Exception:
                    self.fail("Legacy catch swallowed a worker outage")
            except runtime.CourseFailure as error:
                self.assertEqual(error.status, "system_error")
                self.assertNotIn("secret", error.message)

    def test_gateway_never_forwards_system_prompt_or_credentials(self):
        gateway = runtime.Gateway({"url": "http://example.invalid/v1", "token": "scoped-token"})
        with patch.object(runtime.urllib.request, "urlopen", side_effect=OSError("api key private")) as call:
            with self.assertRaises(runtime.CourseFailure) as raised:
                gateway.message([{"role": "system", "content": "hidden"}, {"role": "user", "content": "public"}])
        self.assertEqual(call.call_args.args[0].data, b'{"messages": [{"role": "user", "content": "public"}]}')
        self.assertNotIn("private", raised.exception.message)


if __name__ == "__main__":
    unittest.main()
