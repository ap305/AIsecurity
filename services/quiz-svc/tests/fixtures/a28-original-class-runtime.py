"""Isolated class adapters for watermark and confidential-text extraction courses."""
from __future__ import annotations
import copy
import json
import math
import os
import pathlib
import random
import sys
import types

from bot_runtime import CourseFailure, Gateway, load_course, numeric_metrics, frozen_parameters


def rpc(function, *args, **kwargs):
    from platform_student import StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError
    try:
        return function(*args, **kwargs)
    except EvaluationTimeoutError:
        raise CourseFailure("timeout", "学生程序运行超时，本次不计分") from None
    except EvaluationInfrastructureError:
        raise CourseFailure("system_error", "隔离执行服务异常，本次不计分") from None
    except StudentExecutionError:
        raise CourseFailure("student_error", "学生程序接口或运行错误，本次不计分") from None


class Chat:
    model = "frozen-platform-pool"

    def __init__(self, gateway):
        self.gateway = gateway

    def chat(self, messages, **_kwargs):
        return str(self.gateway.message(messages).get("content") or "")


def _finite(value, low=0.0, high=1.0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise CourseFailure("student_error", "学生返回的数值指标不合法，本次不计分")
    return float(value)


def _text(value):
    if not isinstance(value, str) or len(value) > 262144:
        raise CourseFailure("student_error", "学生返回的文本格式不合法，本次不计分")
    return value


def create(worker, role, name, kwargs=None, data=None):
    from platform_student import invoke, RemoteObject
    result = rpc(invoke, worker, "course_create", args=[role, name, kwargs or {}, data or {}])
    if not isinstance(result, RemoteObject):
        raise CourseFailure("student_error", "学生入口没有返回有效对象")
    return result


class RemoteGuard:
    def __init__(self, worker, number, course):
        self.number, self.course = number, course
        ds = course.dataset
        data = {"spans": ds.secret_spans(), "systemPrompt": ds.build_system_prompt() if number == "27" else ds.KBOT_SYSTEM_PROMPT}
        if number == "28":
            data["publicDocs"] = ds.all_docs(include_secret=False)
        name = "GuardedPromptWithLeakFilter" if number == "27" else "SecretSpanRetrievalFilter"
        self.object = create(worker, "defense", name, data=data)

    def _call(self, method, *args):
        from platform_student import call_method
        return rpc(call_method, self.object, method, args=list(args))

    def system_prompt(self, original):
        return _text(self._call("system_prompt", original))

    def guard_response(self, raw):
        result = self._call("guard_response", raw)
        if not isinstance(result, dict) or type(result.get("filtered")) is not bool or result.get("mode") not in (None, "refuse", "redact"):
            raise CourseFailure("student_error", "防御输出接口不符合题目要求")
        answer = {"response": _text(result.get("response")), "filtered": result["filtered"], "mode": result["mode"]}
        if self.number == "27":
            # Student-provided leak counts never enter trusted metrics.
            answer["leak"] = self.course.dataset.leak_report(raw)
        else:
            answer["ngram_hits"] = int(bool(result["filtered"]))
        return answer

    def guard_retrieval(self, hits):
        result = self._call("guard_retrieval", hits)
        if not isinstance(result, (list, tuple)) or len(result) != 2 or not isinstance(result[0], list) or not isinstance(result[1], list):
            raise CourseFailure("student_error", "防御检索接口不符合题目要求")
        guarded, masked = result
        if len(guarded) != len(hits) or any(not isinstance(i, str) for i in masked):
            raise CourseFailure("student_error", "防御检索结果改变了固定结果数量")
        for original, current in zip(hits, guarded):
            if not isinstance(current, dict) or not isinstance(current.get("doc"), dict):
                raise CourseFailure("student_error", "防御检索结果格式无效")
            if current.get("rank") != original["rank"] or current.get("score") != original["score"] or current["doc"].get("id") != original["doc"]["id"]:
                raise CourseFailure("student_error", "防御检索结果改变了固定排序或文档编号")
            _text(current["doc"].get("text"))
            _text(current["doc"].get("title"))
        return guarded, masked


def extraction_run(course, number, worker, guard, models, parameters):
    from platform_student import invoke, expose
    env = course.make_env(models, guard, budget=parameters["budget"], tag="platform-pair")
    if worker is None:
        name = "AdaptiveRolePlayExtraction" if number == "27" else "EnumerativeCitationProbe"
        getattr(course.reference_modules["attack"], name)(budget=parameters["budget"], seed=parameters["seed"]).run(env, verbose=False)
    else:
        name = "AdaptiveRolePlayExtraction" if number == "27" else "EnumerativeCitationProbe"
        data, diagnostics = {}, None
        if number == "27":
            spans = course.dataset.secret_spans()
            data["spans"] = [{"id": span["id"], "title": span["title"], "text": ""} for span in spans]
            def report(_claimed_text):
                # Only actual visible replies count. Arbitrary student text cannot
                # turn the diagnostic helper into an oracle for secret strings.
                visible = "\n".join(row["response"] for row in env.records)
                real = course.dataset.leak_report(visible, spans)
                observed = {span["id"]: span["text"] for span in spans if span["text"] in visible}
                return {"report": real, "observed": observed}
            diagnostics = expose(methods={"report": report})
        rpc(invoke, worker, "course_attack_run", args=[name, {"budget": parameters["budget"], "seed": parameters["seed"]},
            expose(methods={"query": env.query}), data, diagnostics])
    # The submitted runner's return value, counters and self-reported score are ignored.
    visible = "\n".join(row["response"] for row in env.records)
    report = course.dataset.leak_report(visible)
    coverage = report["leak_coverage" if number == "27" else "coverage"]
    return {"attackMetric": _finite(coverage), "defenseMetric": 1.0 - _finite(coverage),
            "leakedSpans": int(report["n_leaked"]), "queries": env.n_queries, "samples": int(report["n_spans"])}


def evaluate_extraction(course, number, role, phase, student, opponent, parameters, gateway):
    models = {"target": Chat(gateway), "judge": Chat(gateway), "aux": Chat(gateway)}
    reference_name = "GuardedPromptWithLeakFilter" if number == "27" else "SecretSpanRetrievalFilter"
    if role == "attack":
        guard = (RemoteGuard(opponent, number, course) if phase == "opponent" else
                 getattr(course.reference_modules["defense"], reference_name)())
        attack_worker = student
    else:
        guard = RemoteGuard(student, number, course)
        attack_worker = opponent if phase == "opponent" else None
    row = extraction_run(course, number, attack_worker, guard, models, parameters)
    own = row["attackMetric"] if role == "attack" else row["defenseMetric"]
    qualification = own * 100.0
    if phase == "baseline" and role == "attack":
        naked = extraction_run(course, number, student, None, models, parameters)
        gate = getattr(course, "QUALIFY_LEAK_COVERAGE" if number == "27" else "QUALIFY_COVERAGE")
        row["unprotectedCoverage"] = naked["attackMetric"]
        row["cleanGatePassed"] = naked["attackMetric"] >= gate
        qualification = naked["attackMetric"] * 100.0 if row["cleanGatePassed"] else -1.0
    elif phase == "baseline":
        tasks = course.dataset.normal_tasks() if number == "27" else course.dataset.normal_qa()
        baseline = course.evaluate_utility(models, None, tasks, tag="clean-reference", quiet=True)
        defended = course.evaluate_utility(models, guard, tasks, tag="submitted-defense", quiet=True)
        if baseline.get("judge_failures", 0) or defended.get("judge_failures", 0):
            raise CourseFailure("system_error", "固定模型效用裁判响应不符合题目格式")
        drop = 100.0 * (baseline["utility_acc"] - defended["utility_acc"])
        limit = getattr(course, "REFERENCE_LEAK_COVERAGE" if number == "27" else "REFERENCE_COVERAGE")
        passed = row["attackMetric"] <= limit and drop <= course.REFERENCE_UTILITY_DROP_PP
        row.update(cleanGatePassed=passed, utilityDrop=drop, utilityAccuracy=defended["utility_acc"])
        if not passed:
            qualification = -1.0
    row.update(qualificationMetric=qualification, successMetric=own)
    return row


class RemoteWatermark:
    def __init__(self, worker):
        self.generator = create(worker, "defense", "WatermarkDefense")
        self.detector = create(worker, "defense", "WatermarkDetector")

    def generate(self, request):
        from platform_student import call_method, expose
        result = rpc(call_method, self.generator, "generate", args=[expose(), request])
        if not isinstance(result, dict):
            raise CourseFailure("student_error", "水印生成接口必须返回text字段")
        return _text(result.get("text"))

    def detect(self, text):
        from platform_student import call_method
        result = rpc(call_method, self.detector, "detect", args=[text])
        if not isinstance(result, dict) or type(result.get("is_watermarked")) is not bool:
            raise CourseFailure("student_error", "水印检测接口返回格式无效")
        score = result.get("score")
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score):
            raise CourseFailure("student_error", "水印检测分数必须为有限数值")
        return {"is_watermarked": result["is_watermarked"], "score": float(score)}


def blinded_detection(detect, groups, private_order_key):
    """Expose no positive/negative group or predictable call-order labels."""
    if len(private_order_key) != 64 or any(c not in '0123456789abcdef' for c in private_order_key):
        raise CourseFailure('system_error', '水印检测私有固定顺序未准备好')
    entries = [(group_index, index, text) for group_index, group in enumerate(groups)
               for index, text in enumerate(group)]
    random.Random(int(private_order_key, 16)).shuffle(entries)
    results = [[None] * len(group) for group in groups]
    for group_index, index, text in entries:
        results[group_index][index] = detect(text)
    return results


def evaluate_watermark(course, directory, role, phase, student, opponent, parameters, gateway):
    from platform_student import invoke, expose
    ds = course.dataset
    model = object.__new__(ds.BigramLM)
    model.__dict__.update(json.loads((directory / "public" / "bigram.json").read_text(encoding="utf8")))
    for module in (ds, course, *course.reference_modules.values()):
        module.load_bigram = lambda: model
    teacher = course.reference_modules["defense"].WatermarkDefense()
    teacher_detector = course.reference_modules["defense"].WatermarkDetector()
    worker_defense = student if role == "defense" else opponent if phase == "opponent" else None
    remote = RemoteWatermark(worker_defense) if worker_defense is not None else None
    detect = remote.detect if remote else teacher_detector.detect
    attack_worker = student if role == "attack" else opponent if phase == "opponent" else None
    judge = object.__new__(course.LLMQualityJudge)
    judge.model, judge._system, judge._quality_system = "frozen-platform-pool", course._JUDGE_SYSTEM, course._JUDGE_QUALITY_SYSTEM
    judge._chat = lambda system, user, _key: str(gateway.message([{"role": "system", "content": system}, {"role": "user", "content": user}]).get("content") or "")
    def strict_judge_number(raw, key):
        value = judge._json_object(raw).get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
            raise CourseFailure("system_error", "固定模型质量裁判返回了无效数值")
        return float(value)
    judge._parse_json_float = strict_judge_number
    natural_path = directory / "course" / "data" / "natural_texts.jsonl"
    natural = [json.loads(line)["text"] for line in natural_path.read_text(encoding="utf8").splitlines() if line.strip()]
    split_samples, human = ds.build_samples(natural)
    count = parameters["samples"]
    if type(count) is not int or count < 4 or count % 2 or any(len(v) < count // 2 for v in split_samples.values()):
        raise CourseFailure("system_error", "冻结水印样本配置无效")
    samples = split_samples["public"][:count // 2] + split_samples["hidden"][:count // 2]
    watermarked, unwatermarked, attacked, similarities = [], [], [], []
    for i, sample in enumerate(samples):
        request = {"sample_id": sample["sample_id"], "prompt": sample["prompt"], "generation_config": {"seed": parameters["seed"] + i}}
        wm = remote.generate(request) if remote else teacher.generate(None, request)["text"]
        nw = teacher.watermark.generate(sample["prompt"], watermarked=False, seed=parameters["seed"] + i)
        task = {"sample_id": sample["sample_id"], "watermarked_text": wm, "language": sample["language"]}
        if attack_worker is None:
            result = course.reference_attack(types.SimpleNamespace(), task)
        else:
            result = rpc(invoke, attack_worker, "course_invoke", args=["attack", expose(), task])
        if not isinstance(result, dict):
            raise CourseFailure("student_error", "水印攻击接口必须返回text字段")
        transformed = _text(result.get("text"))
        watermarked.append(wm)
        unwatermarked.append(nw)
        attacked.append(transformed)
        try:
            similarities.append(_finite(judge.similarity(wm, transformed)))
        except (ValueError, RuntimeError):
            raise CourseFailure("system_error", "固定模型质量裁判响应不符合题目格式") from None
    # Every phase uses the same mixed protocol, including negative controls.
    # The private key is only in the grader package, never the public tree or
    # evaluation parameters. Restore original indices only after all detections.
    before, after, negative_results = blinded_detection(detect,
        [watermarked, attacked, unwatermarked + human],
        (directory / 'detection-order.key').read_text(encoding='ascii'))
    eligible = [i for i, result in enumerate(before) if result["is_watermarked"]]
    asr = sum(not after[i]["is_watermarked"] for i in eligible) / len(eligible) if eligible else 0.0
    sim = sum(similarities) / len(similarities)
    valid_ratio = sum(v > 0.1 for v in similarities) / len(similarities)
    quality_ok = sim >= course.SIM_THRESHOLD and valid_ratio >= course.VALID_TEXT_RATIO
    # A destructive text replacement is an ordinary attack failure, not a win.
    effective_asr = asr if quality_ok else 0.0
    own = effective_asr if role == "attack" else 1.0 - effective_asr
    qualification = own * 100.0
    row = {"attackMetric": effective_asr, "rawAttackMetric": asr, "semanticSimilarity": sim,
           "validTextRatio": valid_ratio, "qualityGatePassed": quality_ok, "samples": count}
    if phase == "baseline" and role == "attack" and not quality_ok:
        qualification = -1.0
    elif phase == "baseline" and role == "defense":
        negatives = [result['score'] for result in negative_results]
        auc = course.roc_auc([result["score"] for result in before], negatives)
        try:
            retention = course.quality_retention(judge, watermarked, unwatermarked)
        except (ValueError, RuntimeError):
            raise CourseFailure("system_error", "固定模型质量裁判响应不符合题目格式") from None
        passed = auc >= course.AUC_THRESHOLD and retention >= course.QUALITY_THRESHOLD
        row.update(auc=float(auc), qualityRetention=float(retention), cleanGatePassed=passed)
        if not passed:
            qualification = -1.0
    row.update(qualificationMetric=qualification, successMetric=own)
    return row


def run_context(context, directory):
    directory = pathlib.Path(directory).resolve()
    frozen = json.loads((directory / "frozen.json").read_text(encoding="utf8"))
    number, role, phase = frozen["number"], context["role"], context["phase"]
    if number not in ("03", "27", "28") or role not in ("attack", "defense") or role != frozen["role"] or phase not in ("baseline", "opponent"):
        raise CourseFailure("system_error", "攻防角色或阶段无效")
    parameters = frozen_parameters(context)
    for key in ("samples", "seed", "budget", "sourceDigest"):
        if parameters.get(key) != frozen[key]:
            raise CourseFailure("system_error", "题目参数与冻结课程不一致")
    course = load_course(directory / "course")
    gateway = Gateway(context.get("modelGateway"), preserve_system=True)
    previous = os.getcwd()
    try:
        os.chdir(directory / "course")
        if number == "03":
            result = evaluate_watermark(course, directory, role, phase, context["student"], context.get("opponent"), frozen, gateway)
        else:
            result = evaluate_extraction(course, number, role, phase, context["student"], context.get("opponent"), frozen, gateway)
    finally:
        os.chdir(previous)
    result["modelCalls"] = gateway.calls
    return result


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
