from __future__ import annotations
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import bot_runtime
import prompt_runtime
import class_runtime


class ResultContractTests(unittest.TestCase):
    def context(self, threshold=.25):
        return {"submissionId": "s", "attemptId": "a", "questionVersion": 1,
                "evaluationVersion": "v", "phase": "opponent", "role": "attack",
                "opponent": {"submissionId": "o"}, "parameters": {"successThreshold": threshold}}

    def invoke(self, runtime, context, metrics=None, error=None):
        test_root = pathlib.Path(__file__).resolve().parents[5] / ".test-artifacts"
        test_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="api-contract-", dir=test_root) as temporary:
            root = pathlib.Path(temporary)
            (root / "context.json").write_text(json.dumps(context), encoding="utf8")
            with patch.object(runtime, "run_context", return_value=metrics, side_effect=error):
                runtime.main(root / "context.json", root / "result.json")
            return json.loads((root / "result.json").read_text(encoding="utf8"))

    def test_equal_threshold_wins_and_gate_flags_are_numeric(self):
        for runtime in (bot_runtime, prompt_runtime, class_runtime):
            with self.subTest(runtime=runtime.__name__):
                result = self.invoke(runtime, self.context(), {"qualificationMetric": 25, "successMetric": .25, "cleanGatePassed": True})
                self.assertTrue(result["success"])
                self.assertEqual(type(result["metrics"]["cleanGatePassed"]), int)
                self.assertEqual(result["opponentSubmissionId"], "o")
                self.assertNotIn("score", result)

    def test_normal_zero_remains_completed_failure(self):
        for runtime in (bot_runtime, prompt_runtime, class_runtime):
            result = self.invoke(runtime, self.context(.05), {"qualificationMetric": 0, "successMetric": 0})
            self.assertEqual(result["status"], "completed")
            self.assertFalse(result["success"])

    def test_error_and_uncalibrated_threshold_have_no_score(self):
        for runtime in (bot_runtime, prompt_runtime, class_runtime):
            cases = [(self.context(), bot_runtime.CourseFailure("student_error", "safe error")), (self.context(0), None)]
            for context, error in cases:
                result = self.invoke(runtime, context, {"qualificationMetric": 100, "successMetric": 1}, error)
                self.assertNotEqual(result["status"], "completed")
                self.assertNotIn("metrics", result)
                self.assertNotIn("success", result)

    def test_nonfinite_metrics_cannot_complete(self):
        for runtime in (bot_runtime, prompt_runtime, class_runtime):
            result = self.invoke(runtime, self.context(), {"successMetric": float("nan")})
            self.assertEqual(result["status"], "system_error")
            self.assertNotIn("metrics", result)

    def test_continuous_positive_reference_is_not_raised(self):
        self.assertEqual(bot_runtime.calibrated_success_threshold(.001, 20), .001)
        self.assertEqual(bot_runtime.calibrated_success_threshold(0, 20), .05)


if __name__ == "__main__":
    unittest.main()
