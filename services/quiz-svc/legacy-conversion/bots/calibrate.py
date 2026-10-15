"""Freeze official reference results after isolated, real-model acceptance runs.

Input records are produced by the deployment runner, never by student code.
Every question needs completed baseline and opponent runs. Zero qualification
is retained. Only an exactly-zero Bot reference win rate uses the user-approved
one-win threshold (1 / frozen sample count); original measurements stay intact.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import math
import pathlib

BOT_SCENARIOS = ("chatops", "agendabot", "supportbot", "webbot")
ZERO_REFERENCE_POLICY = "user_approved_bot_zero_reference_one_win"


def metric(record, key):
    result = record.get("result", {})
    value = result.get("metrics", {}).get(key)
    if result.get("status") != "completed" or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError("Reference evaluation missing, failed, unqualified or non-finite")
    return value


def apply_calibration(metadata, records):
    output = copy.deepcopy(metadata)
    indexed = {}
    for record in records:
        key = (record["questionId"], record["phase"])
        if key in indexed:
            raise ValueError("Duplicate reference calibration record")
        indexed[key] = record
    for question in output:
        provenance, definition = question["provenance"], question["definition"]
        if question.get("scenarioId") not in BOT_SCENARIOS or question.get("calibration") != {"baseline": "reference", "opponent": "reference"}:
            raise ValueError("This calibrator accepts only original Bot reference policies")
        samples = definition["evaluation"].get("samples")
        if type(samples) is not int or not 1 <= samples <= 100 or provenance.get("samples") != samples or type(provenance.get("samples")) is not int:
            raise ValueError("Bot frozen sample count must be a matching positive integer")
        nested_samples = definition["evaluation"].get("parameters", {}).get("samples", samples)
        if type(nested_samples) is not int or nested_samples != samples:
            raise ValueError("Bot evaluation sampling parameters mismatch")
        phases = []
        for phase in ("baseline", "opponent"):
            record = indexed.get((question["questionId"], phase))
            if not record:
                raise ValueError("Missing " + phase + " reference for " + question["questionId"])
            for key in ("sourceDigest", "seed", "samples"):
                if record.get(key) != provenance[key]:
                    raise ValueError("Reference calibration source or sampling mismatch")
            measured_samples = record.get("result", {}).get("metrics", {}).get("samples")
            if type(record.get("samples")) is not int or type(measured_samples) is not int or measured_samples != samples:
                raise ValueError("Reference measurement sample count mismatch")
            if definition["llm"]["enabled"]:
                if record.get("modelPoolId") != definition["llm"]["poolId"] or type(record.get("modelPoolRevision")) is not int or record["modelPoolRevision"] < 1 or not record.get("model") or not record.get("modelVersion"):
                    raise ValueError("Real-model reference must identify the frozen pool revision/model")
                if record.get("result", {}).get("metrics", {}).get("modelCalls", 0) < 1:
                    raise ValueError("Real-model calibration cannot use a mock/no-model result")
            value = metric(record, "qualificationMetric" if phase == "baseline" else "successMetric")
            threshold = value
            if phase == "opponent":
                one_win = value == 0
                threshold = 1 / samples if one_win else value
                opponent_evidence = {"policy": ZERO_REFERENCE_POLICY if one_win else "reference",
                                     "metric": "successMetric", "observed": value,
                                     "threshold": threshold, "samples": samples}
                if one_win:
                    opponent_evidence["decision"] = "用户批准：仅参考对抗胜率为0的Bot题，至少成功1个固定样本；非0原值和基线不变"
            if phase == "baseline" and question["role"] == "defense":
                fpr = record["result"]["metrics"].get("falsePositiveRate")
                if not isinstance(fpr, (float, int)) or not math.isfinite(fpr) or not 0 <= fpr <= 0.10:
                    raise ValueError("Reference defense failed the published 10% collateral gate")
            definition["evaluation"]["baselineThreshold" if phase == "baseline" else "successThreshold"] = threshold
            phases.append(copy.deepcopy(record))
        if definition["llm"]["enabled"]:
            for key in ("modelPoolId", "modelPoolRevision", "model", "modelVersion"):
                if phases[0].get(key) != phases[1].get(key):
                    raise ValueError("Model binding changed between calibration phases")
        definition["evaluation"].pop("calibrationMode", None)
        question["calibrationRequired"] = False
        question["calibrationEvidence"] = {"opponentThreshold": opponent_evidence}
        question["calibration"] = {"comparison": ">=", "records": phases,
                                   "zeroMetricPolicy": "User approved: exactly-zero Bot reference win rate uses 1/frozen samples; baseline and nonzero rates stay unchanged.",
                                   "calibratedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        question["content"] += (f"\n\n本版本对抗胜率门槛为 {opponent_evidence['threshold']}（大于等于）。"
                                f"仅官方参考胜率恰为0时采用 1/{samples}，即至少成功1个固定样本；"
                                "非零原值和基线不变，正常失败仍计入分母。")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--results", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data = apply_calibration(json.loads(pathlib.Path(args.metadata).read_text(encoding="utf8")),
                             json.loads(pathlib.Path(args.results).read_text(encoding="utf8")))
    pathlib.Path(args.output).write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf8")
