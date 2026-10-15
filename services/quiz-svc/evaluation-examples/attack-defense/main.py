"""Evaluate a real attacker/defender pair. Qualification and final pool scoring belong to the platform."""
import importlib.util
import json
import pathlib
import sys
from platform_student import invoke, EvaluationInfrastructureError, EvaluationTimeoutError

context = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf8"))
result = {key: context[key] for key in ("submissionId", "attemptId", "questionVersion", "evaluationVersion", "phase")}
if context["phase"] == "opponent":
    result["opponentSubmissionId"] = context["opponent"]["submissionId"]
def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
try:
    role = context["role"]
    if role not in ("attack", "defense"):
        raise ValueError("missing role")
    if context["phase"] == "opponent":
        opponent = None
        result["opponentSubmissionId"] = context["opponent"]["submissionId"]
    else:
        baseline = context.get("baseline", {})
        fixture = baseline.get("codePath") or baseline.get("fixturePath")
        if not fixture:
            fixture = str(pathlib.Path(__file__).parent / "baselines" / ("defense.py" if role == "attack" else "attack.py"))
        opponent = load("baseline", fixture)
    repetitions = int(context.get("parameters", {}).get("repetitions", 1))
    if repetitions < 1 or repetitions > 100:
        raise ValueError("invalid repetitions")
    successes = 0
    for _ in range(repetitions):
        if role == "attack":
            payload = invoke(context["student"], "attack")
            response = invoke(context["opponent"], "defend", [payload]) if context["phase"] == "opponent" else opponent.defend(payload)
        else:
            payload = invoke(context["opponent"], "attack") if context["phase"] == "opponent" else opponent.attack()
            response = invoke(context["student"], "defend", [payload])
        if not isinstance(response, str):
            raise ValueError("invalid defense result")
        attack_success = "secret" in response.lower()
        successes += int(attack_success if role == "attack" else not attack_success)
    ratio = successes / repetitions
    result.update(status="completed", metrics={"qualificationMetric": ratio, "successRatio": ratio, "successMetric": ratio})
    if context["phase"] == "opponent":
        threshold = float(context.get("parameters", {}).get("successThreshold", 0.5))
        result["success"] = ratio >= threshold
    result["publicMessage"] = "固定参数下的攻防评测完成"
except EvaluationTimeoutError:
    result.update(status="timeout", publicMessage="评测超时，本次不计分")
except EvaluationInfrastructureError:
    result.update(status="system_error", publicMessage="评测服务通信异常，本次不计分")
except Exception:
    result.update(status="student_error", publicMessage="攻防接口或运行错误，本次不计分")
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf8")
