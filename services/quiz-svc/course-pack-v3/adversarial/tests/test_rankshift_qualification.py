"""Offline routing/metric tests; these do not replace real 8B calibration."""
from __future__ import annotations

from contextlib import ExitStack
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prompt_runtime as runtime
from bot_runtime import CourseFailure, numeric_metrics


class RankShiftQualificationTests(unittest.TestCase):
    def setUp(self):
        self.course = types.SimpleNamespace(reference_attack=object(), reference_defense=object(),
            _prompt_nodefense=object(), _scoremin_payload=object(), _noop_payload=object(),
            CLEAN_GATE_RANKSHIFT=5.0, CLEAN_GATE_VALID_RATE=.99)
        self.student, self.opponent = object(), object()
        self.samples, self.references, self.calls = object(), object(), []

    def evaluate(self, role, phase, shifts, number="02", valid=None):
        values = iter(zip(shifts, valid or [1.0] * len(shifts)))
        def pair(course, actual_number, samples, attack, defense, judge, references=None):
            self.assertIs(course, self.course)
            self.assertEqual(actual_number, number)
            self.assertIs(samples, self.samples)
            self.calls.append((attack, defense, references))
            shift, rate = next(values)
            return {"attackMetric": shift / 100, "defenseMetric": 1 - shift / 100,
                    "rankShift": shift, "validRate": rate, "taskAccuracy": 1, "tokenLeakRate": 0}
        with ExitStack() as stack:
            stack.enter_context(patch.object(runtime, "fixed_samples", return_value=self.samples))
            reference = stack.enter_context(patch.object(runtime, "references_02", return_value=self.references))
            stack.enter_context(patch.object(runtime, "evaluate_pair", side_effect=pair))
            result = runtime.evaluate(self.course, number, role, phase, self.student,
                                      self.opponent, {"samples": 20}, None)
            self.assertEqual(reference.call_count, int(number == "02"))
        return result

    def test_attack_qualification_uses_no_defense_and_exact_rank_shift(self):
        result = self.evaluate("attack", "baseline", [67.1234])
        self.assertEqual(self.calls, [(self.student, self.course._prompt_nodefense, self.references)])
        self.assertEqual(result["qualificationMetric"], 67.1234)
        self.assertEqual(result["successMetric"], .671234)

    def test_defense_qualification_averages_both_anchors_but_not_clean(self):
        result = self.evaluate("defense", "baseline", [10.1234, 80.4321, 4.9])
        self.assertEqual(self.calls, [(attack, self.student, self.references) for attack in
            (self.course.reference_attack, self.course._scoremin_payload, self.course._noop_payload)])
        mean = round(.5 * 10.1234 + .5 * 80.4321, 4)
        self.assertEqual(result["qualificationMetric"], 100 - mean)
        self.assertEqual(result["rankShift"], mean)
        self.assertEqual(result["successMetric"], 1 - mean / 100)
        self.assertEqual(result["rankShiftScoreMax"], 10.1234)
        self.assertEqual(result["rankShiftScoreMin"], 80.4321)
        self.assertEqual(result["cleanRankShift"], 4.9)
        self.assertEqual(result["samples"], 20)

    def test_equal_clean_thresholds_pass(self):
        result = self.evaluate("defense", "baseline", [20, 40, 5], valid=[1, 1, .99])
        self.assertTrue(result["cleanGatePassed"])
        self.assertEqual(result["qualificationMetric"], 70)
        self.assertEqual(result["cleanValidRate"], .99)

    def test_clean_rank_shift_failure_is_negative_even_with_perfect_defense(self):
        result = self.evaluate("defense", "baseline", [0, 0, 5.0001])
        self.assertFalse(result["cleanGatePassed"])
        self.assertEqual(result["qualificationMetric"], -1)
        self.assertEqual(result["successMetric"], 1)
        self.assertEqual(result["cleanRankShift"], 5.0001)

    def test_clean_validity_failure_is_negative(self):
        result = self.evaluate("defense", "baseline", [0, 0, 0], valid=[1, 1, .9899])
        self.assertFalse(result["cleanGatePassed"])
        self.assertEqual(result["qualificationMetric"], -1)

    def test_real_opponent_path_never_runs_qualification_anchors(self):
        for role in ("attack", "defense"):
            self.calls.clear()
            result = self.evaluate(role, "opponent", [100])
            expected = (self.student, self.opponent) if role == "attack" else (self.opponent, self.student)
            self.assertEqual(self.calls, [(*expected, self.references)])
            self.assertEqual(result["successMetric"], 1 if role == "attack" else 0)
            self.assertNotIn("cleanGatePassed", result)

    def test_missing_real_opponent_remains_infrastructure_error(self):
        self.opponent = None
        with self.assertRaises(CourseFailure) as raised:
            self.evaluate("attack", "opponent", [])
        self.assertEqual(raised.exception.status, "system_error")

    def test_clean_diagnostics_are_finite_numeric_result_contract(self):
        result = numeric_metrics(self.evaluate("defense", "baseline", [20, 40, 5]))
        self.assertEqual(type(result["cleanGatePassed"]), int)
        self.assertTrue(all(type(value) in (int, float) for value in result.values()))

    def test_other_prompt_course_qualification_path_unchanged(self):
        self.course.CLEAN_GATE_TASK_ACC, self.course.CLEAN_GATE_TOKEN_LEAK = .95, .05
        result = self.evaluate("defense", "baseline", [20, 0], number="09")
        self.assertEqual(self.calls[0], (self.course.reference_attack, self.student, None))
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(result["qualificationMetric"], 80)
        self.assertNotIn("rankShiftScoreMin", result)


if __name__ == "__main__":
    unittest.main()
