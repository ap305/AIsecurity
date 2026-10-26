"""A28 qualification is the original unprotected experiment; no model calls."""
from __future__ import annotations

from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import class_runtime as runtime
from bot_runtime import numeric_metrics


class RagAttackQualificationTests(unittest.TestCase):
    def setUp(self):
        self.student, self.opponent, self.remote_guard, self.reference_guard = (object() for _ in range(4))
        self.reference = Mock(return_value=self.reference_guard)
        self.course = types.SimpleNamespace(
            reference_modules={"defense": types.SimpleNamespace(
                SecretSpanRetrievalFilter=self.reference,
                GuardedPromptWithLeakFilter=self.reference)},
            QUALIFY_COVERAGE=.4, QUALIFY_LEAK_COVERAGE=.5,
            REFERENCE_COVERAGE=.1, REFERENCE_LEAK_COVERAGE=.1,
            REFERENCE_UTILITY_DROP_PP=5,
            dataset=types.SimpleNamespace(normal_qa=lambda: ["public question"],
                                          normal_tasks=lambda: ["public question"]),
            evaluate_utility=Mock(side_effect=[{"utility_acc": 1}, {"utility_acc": .96}]))
        self.parameters = {"budget": 20, "seed": 42}
        self.calls = []

    def evaluate(self, number="28", role="attack", phase="baseline", unprotected=.4, guarded=0):
        def extraction(course, actual_number, worker, guard, models, parameters):
            self.assertIs(course, self.course)
            self.assertEqual(actual_number, number)
            self.assertIs(parameters, self.parameters)
            self.calls.append((worker, guard))
            coverage = unprotected if guard is None else guarded
            return {"attackMetric": coverage, "defenseMetric": 1 - coverage,
                    "leakedSpans": round(30 * coverage), "queries": 7 if guard is None else 20,
                    "samples": 30}
        with patch.object(runtime, "RemoteGuard", return_value=self.remote_guard) as guard, \
             patch.object(runtime, "extraction_run", side_effect=extraction), \
             patch("urllib.request.urlopen", side_effect=AssertionError("No model/network calls permitted")):
            result = runtime.evaluate_extraction(self.course, number, role, phase,
                self.student, self.opponent, self.parameters, object())
        return result, guard

    def test_a28_original_boundary_is_inclusive(self):
        for coverage, expected in ((.1667, -1), (.3999, -1), (.4, 40), (.6, 60)):
            with self.subTest(coverage=coverage):
                self.calls.clear()
                result, guard = self.evaluate(unprotected=coverage)
                self.assertEqual(result["qualificationMetric"], expected)
                self.assertEqual(result["cleanGatePassed"], expected != -1)
                self.assertEqual(result["unprotectedCoverage"], coverage)
                self.assertEqual(self.calls, [(self.student, None)])
                guard.assert_not_called()

    def test_a28_all_baseline_metrics_describe_the_same_unprotected_run(self):
        result, _ = self.evaluate(unprotected=.6)
        self.assertEqual(result, {"attackMetric": .6, "defenseMetric": .4,
            "leakedSpans": 18, "queries": 7, "samples": 30,
            "unprotectedCoverage": .6, "cleanGatePassed": True,
            "qualificationMetric": 60, "successMetric": .6})
        self.reference.assert_not_called()
        self.assertEqual(numeric_metrics(result)["cleanGatePassed"], 1)

    def test_unbreakable_or_unavailable_reference_defense_cannot_block_a28(self):
        self.reference.side_effect = AssertionError("Qualification must never construct a reference defense")
        result, _ = self.evaluate(unprotected=.4, guarded=0)
        self.assertEqual(result["qualificationMetric"], 40)
        self.assertEqual(self.calls, [(self.student, None)])

    def test_a28_real_opponent_is_used_for_both_roles(self):
        for role in ("attack", "defense"):
            with self.subTest(role=role):
                self.calls.clear()
                result, guard = self.evaluate(role=role, phase="opponent", guarded=.2)
                expected_worker = self.student if role == "attack" else self.opponent
                expected_guard_worker = self.opponent if role == "attack" else self.student
                self.assertEqual(self.calls, [(expected_worker, self.remote_guard)])
                guard.assert_called_once_with(expected_guard_worker, "28", self.course)
                self.assertEqual(result["successMetric"], .2 if role == "attack" else .8)
                self.assertNotIn("unprotectedCoverage", result)
                self.reference.assert_not_called()

    def test_a27_qualification_remains_two_original_runs(self):
        result, _ = self.evaluate(number="27", unprotected=.6, guarded=.2)
        self.assertEqual(self.calls, [(self.student, self.reference_guard), (self.student, None)])
        self.assertEqual(result["attackMetric"], .2)
        self.assertEqual(result["successMetric"], .2)
        self.assertEqual(result["unprotectedCoverage"], .6)
        self.assertEqual(result["qualificationMetric"], 60)
        self.reference.assert_called_once_with()

    def test_d28_baseline_retains_reference_attack_and_utility_gate(self):
        result, guard = self.evaluate(role="defense", guarded=0)
        self.assertEqual(self.calls, [(None, self.remote_guard)])
        guard.assert_called_once_with(self.student, "28", self.course)
        self.assertEqual(self.course.evaluate_utility.call_count, 2)
        self.assertTrue(result["cleanGatePassed"])
        self.assertAlmostEqual(result["utilityDrop"], 4)
        self.assertEqual(result["qualificationMetric"], 100)
        self.assertNotIn("unprotectedCoverage", result)


if __name__ == "__main__":
    unittest.main()
