"""Student worker loads its own uploaded JSON model; trusted grader only checks predictions."""
import json
import math
import pathlib
import sys
from platform_student import invoke, EvaluationInfrastructureError, EvaluationTimeoutError

context = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf8"))
result = {key: context[key] for key in ("submissionId", "attemptId", "questionVersion", "evaluationVersion", "phase")}
try:
    inputs = [-2, 0, 1, 3, 5]
    correct = sum(math.isclose(invoke(context["student"], "predict", [x]), 2 * x + 1, abs_tol=1e-6) for x in inputs)
    maximum = float(context.get("parameters", {}).get("maxScore", 100))
    result.update(status="completed", score=maximum * correct / len(inputs), maxScore=maximum, metrics={"correct": correct, "total": len(inputs)}, publicMessage="模型参数推理评测完成")
except EvaluationTimeoutError:
    result.update(status="timeout", publicMessage="评测超时，本次不计分")
except EvaluationInfrastructureError:
    result.update(status="system_error", publicMessage="评测服务通信异常，本次不计分")
except Exception:
    result.update(status="student_error", publicMessage="参数结构或推理代码错误，本次不计分")
pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf8")
