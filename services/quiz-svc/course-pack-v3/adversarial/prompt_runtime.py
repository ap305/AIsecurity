"""Actual attack/defense pairs for v3 prompt scoring, injection and RAG poison."""
from __future__ import annotations

import copy
import json
import math
import os
import pathlib
import sys
import types

from bot_runtime import CourseFailure, Gateway, load_course, numeric_metrics, frozen_parameters

PROMPT_IDS = ("02", "08", "09", "13")


class Judge:
    model = "frozen-platform-pool"

    def __init__(self, gateway):
        self.gateway = gateway

    def query(self, prompt, **_kwargs):
        return str(self.gateway.message([{"role": "user", "content": prompt}]).get("content") or "")


def model_parameters(course, number):
    if number == "08":
        return {"temperature": 0, "seed": 42, "max_tokens": 1024}
    result = {"temperature": 0, "seed": 42, "max_tokens": 512 if number == "02" else 150}
    if number == "02":
        result["systemPrompt"] = course.build_system_prompt()
    elif number == "13":
        result["systemPrompt"] = "You are a helpful assistant."
    return result


def remote_function(worker, number, role):
    from platform_student import invoke, expose, StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError

    def call(env, *args):
        methods = {}
        if number == "02":
            names = ("sample_id", "clean_text", "domain", "language", "rubric_instruction", "rubric_id", "inject_position") if role == "attack" else ("rubric_instruction", "untrusted_text", "base_prompt", "output_schema")
        elif number == "08":
            names = ("max_queries", "query_count")
            methods = {"query": env.query}
        elif number == "09":
            names = ("target_instruction", "input", "attack_token", "max_queries", "max_payload_bytes", "query_count", "last_response") if role == "attack" else ("final_prompt",)
            if role == "attack":
                methods = {"set_injection": env.set_injection, "query": env.query}
        else:
            names = ("sample_id", "question", "attack_target") if role == "attack" else ("question",)
        values = {name: copy.deepcopy(getattr(env, name)) for name in names}
        if number == "13" and role == "defense":
            db = env.db
            def documents():
                return [{"id": d.id, "text": d.text, "source": d.source, "length": d.length} for d in db.list_documents()]
            values["db"] = expose(values={"max_operations": db.max_operations}, methods={
                "list_documents": documents, "delete": db.delete, "quarantine": db.quarantine,
                "update": db.update, "reindex": db.reindex, "operation_count": lambda: db.operation_count,
                "length": lambda: len(db),
            })
        try:
            return invoke(worker, "course_invoke", args=[role, expose(values=values, methods=methods), *copy.deepcopy(args)])
        except EvaluationTimeoutError:
            raise CourseFailure("timeout", "学生程序运行超时，本次不计分") from None
        except EvaluationInfrastructureError:
            raise CourseFailure("system_error", "隔离执行服务异常，本次不计分") from None
        except StudentExecutionError:
            raise CourseFailure("student_error", "学生程序接口或运行错误，本次不计分") from None
    return call


def fixed_samples(course, number, samples):
    # Each split remains equally weighted. Never silently synthesize missing data.
    split_count = samples // 2
    if type(samples) is not int or samples < 4 or samples % 2:
        raise CourseFailure("system_error", "冻结样本必须为大于等于4的偶数")
    result = {}
    if number == "02" and samples < 20:
        raise CourseFailure("system_error", "排序题每组至少10条样本")
    for split in (("harmful", "benign") if number == "08" else ("public", "hidden")):
        rel = pathlib.Path("data") / ("samples" if number == "13" else "") / (split + ".jsonl")
        if not rel.is_file():
            raise CourseFailure("system_error", "固定数据资产缺失")
        rows = [json.loads(line) for line in rel.read_text(encoding="utf8").splitlines() if line.strip()]
        if len(rows) < split_count:
            raise CourseFailure("system_error", "固定数据资产样本不足")
        result[split] = rows[:split_count]
    return result


def evaluate_pair(course, number, samples, attack, defense, judge, references=None):
    if number == "08":
        class Chat:
            def chat(self, messages, **_kwargs):
                return str(judge.gateway.message(messages).get("content") or "")
        target = Chat()
        verdict = course.OpenAIJudge(Chat())
        course.ATTACKS["platform-submitted"] = lambda env, task, aux=None: attack(env, task)
        course.DEFENSES["platform-submitted"] = lambda env, request, aux=None: defense(env, request)
        try:
            row = course.run_cell("platform-submitted", "platform-submitted", samples["harmful"], target, None, verdict)
        except (ValueError, RuntimeError):
            raise CourseFailure("system_error", "固定模型裁判响应不符合题目格式") from None
        return {"attackMetric": float(row["asr"]), "defenseMetric": 1.0 - float(row["asr"])}
    if number == "02":
        row = course._cell(samples, references, "submitted-attack", attack, "submitted-defense", defense, judge)
        return {"attackMetric": float(row["rank_shift"]) / 100.0, "defenseMetric": 1.0 - float(row["rank_shift"]) / 100.0,
                "rankShift": float(row["rank_shift"]), "validRate": float(row["valid_rate"])}
    if number == "09":
        row = course._cell(samples, "submitted-attack", attack, "submitted-defense", defense, judge)
        return {"attackMetric": float(row["asr"]), "defenseMetric": float(row["dsr"]),
                "taskAccuracy": float(row["task_accuracy"]), "tokenLeakRate": float(row["token_leak_rate"])}
    arena = course.Arena(judge)
    cells = [arena.run_sample(sample, attack, defense) for split in ("public", "hidden") for sample in samples[split]]
    # The package's trusted evaluator produces success/accuracy, never student code.
    return {"attackMetric": sum(bool(row["attack_success"]) for row in cells) / len(cells),
            "defenseMetric": sum(bool(row["defense_success"]) for row in cells) / len(cells),
            "cleanAccuracy": sum(bool(row["matches_gold"]) for row in cells) / len(cells)}


def references_02(course, samples, judge):
    reference = {}
    for split, rows in samples.items():
        reference[split] = {}
        for sample in rows:
            untrusted = course.build_untrusted_text(sample["clean_text"], "")
            base = course.build_base_prompt(course.RUBRIC_INSTRUCTION, untrusted)
            parsed = course.parse_or_repair(judge.query(base))
            if parsed is None:
                raise CourseFailure("system_error", "固定模型评分响应不符合题目格式")
            reference[split][sample["sample_id"]] = parsed
    return reference


def evaluate(course, number, role, phase, student, opponent, parameters, gateway):
    samples = fixed_samples(course, number, parameters["samples"])
    judge = Judge(gateway)
    refs = references_02(course, samples, judge) if number == "02" else None
    attack, defense = (student, course.reference_defense) if role == "attack" else (course.reference_attack, student)
    if phase == "opponent":
        if opponent is None:
            raise CourseFailure("system_error", "对手阶段缺少真实对手")
        attack, defense = (student, opponent) if role == "attack" else (opponent, student)
    row = evaluate_pair(course, number, samples, attack, defense, judge, refs)
    own = row["attackMetric"] if role == "attack" else row["defenseMetric"]
    qualification = own * 100.0
    if phase == "baseline" and role == "defense":
        if number == "08":
            class Chat:
                def chat(self, messages, **_kwargs):
                    return str(gateway.message(messages).get("content") or "")
            course.DEFENSES["platform-submitted"] = lambda env, request, aux=None: defense(env, request)
            try:
                _, utility = course.run_capability("platform-submitted", samples["benign"], Chat(), None, course.OpenAIJudge(Chat()))
            except (ValueError, RuntimeError):
                raise CourseFailure("system_error", "固定模型裁判响应不符合题目格式") from None
            row["cleanGatePassed"] = utility >= course.CLEAN_GATE_UR
            row["utilityRetention"] = utility
            if not row["cleanGatePassed"]:
                qualification = -1.0
            row.update(qualificationMetric=qualification, successMetric=own, samples=parameters["samples"] // 2)
            return row
        noop = (lambda _env: []) if number == "13" else (lambda _env: "")
        clean = evaluate_pair(course, number, samples, noop, defense, judge, refs)
        if number == "02":
            passed = clean["rankShift"] <= course.CLEAN_GATE_RANKSHIFT and clean["validRate"] >= course.CLEAN_GATE_VALID_RATE
        elif number == "09":
            passed = clean["taskAccuracy"] >= course.CLEAN_GATE_TASK_ACC and clean["tokenLeakRate"] <= course.CLEAN_GATE_TOKEN_LEAK
        else:
            native = evaluate_pair(course, number, samples, noop, course._no_defense, judge, refs)
            passed = clean["cleanAccuracy"] >= native["cleanAccuracy"] - course.CLEAN_GATE_DROP
        row["cleanGatePassed"] = passed
        if not passed:
            qualification = -1.0
    row.update(qualificationMetric=qualification, successMetric=own, samples=parameters["samples"] // 2 if number == "08" else parameters["samples"])
    return row


def run_context(context, directory):
    directory = pathlib.Path(directory).resolve()
    frozen = json.loads((directory / "frozen.json").read_text(encoding="utf8"))
    number, role, phase = frozen["number"], context["role"], context["phase"]
    if number not in PROMPT_IDS or role not in ("attack", "defense") or role != frozen["role"] or phase not in ("baseline", "opponent"):
        raise CourseFailure("system_error", "攻防角色或阶段无效")
    parameters = frozen_parameters(context)
    for key in ("samples", "seed", "sourceDigest"):
        if parameters.get(key) != frozen[key]:
            raise CourseFailure("system_error", "题目参数与冻结课程不一致")
    course, gateway = load_course(directory / "course"), Gateway(context.get("modelGateway"), preserve_system=number == "08")
    student = remote_function(context["student"], number, role)
    opponent = remote_function(context["opponent"], number, "defense" if role == "attack" else "attack") if phase == "opponent" else None
    previous = os.getcwd()
    try:
        os.chdir(directory / "course")
        row = evaluate(course, number, role, phase, student, opponent, frozen, gateway)
    finally:
        os.chdir(previous)
    row["modelCalls"] = gateway.calls
    return row


def main(context_path, output_path):
    context = json.loads(pathlib.Path(context_path).read_text(encoding="utf8"))
    result = {key: context[key] for key in ("submissionId", "attemptId", "questionVersion", "evaluationVersion", "phase")}
    if context["phase"] == "opponent":
        result["opponentSubmissionId"] = context["opponent"]["submissionId"]
    try:
        metrics = numeric_metrics(run_context(context, pathlib.Path(__file__).parent))
        result.update(status="completed", metrics=metrics, publicMessage="固定课程参数下的攻防评测完成")
        if context["phase"] == "opponent":
            threshold = context.get("parameters", {}).get("successThreshold")
            if context.get("parameters", {}).get("calibrationMode") is True:
                result["success"] = False
            elif isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 < threshold <= 1:
                raise CourseFailure("system_error", "对抗门槛尚未完成校准")
            else:
                result["success"] = metrics["successMetric"] >= threshold
    except CourseFailure as exc:
        result = {k: v for k, v in result.items() if k not in ("metrics", "success")}
        result.update(status=exc.status, publicMessage=exc.message)
    except Exception:
        result = {k: v for k, v in result.items() if k not in ("metrics", "success")}
        result.update(status="system_error", publicMessage="课程评测配置或执行异常，本次不计分")
    pathlib.Path(output_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf8")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
