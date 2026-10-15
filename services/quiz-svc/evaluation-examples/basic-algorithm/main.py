"""Real algorithm checks: implement solve(values) -> sum, including empty/negative inputs."""
import json
import pathlib
import sys
from platform_student import invoke, EvaluationInfrastructureError, EvaluationTimeoutError

context = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf8"))
result = {key: context[key] for key in ("submissionId", "attemptId", "questionVersion", "evaluationVersion", "phase")}
try:
    cases = [[], [1, 2, 3], [-5, 2], [0, 0], [100000, -1]]
    correct = sum(invoke(context["student"], "solve", [values]) == sum(values) for values in cases)
    maximum = float(context.get("parameters", {}).get("maxScore", 100))
    result.update(status="completed", score=maximum * correct / len(cases), maxScore=maximum, metrics={"correct": correct, "total": len(cases)}, publicMessage="数组求和评测完成")
except EvaluationTimeoutError:
    result.update(status="timeout", publicMessage="评测超时，本次不计分")
except EvaluationInfrastructureError:
    result.update(status="system_error", publicMessage="评测服务通信异常，本次不计分")
except Exception:
    result.update(status="student_error", publicMessage="代码接口或运行错误，本次不计分")
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf8")
