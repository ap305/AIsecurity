"""Platform entrypoint. All candidate and opponent execution is delegated to isolated workers."""
from __future__ import annotations

import json
import math
import pathlib
import sys
from contracts import MaterialContractError, finite_metrics
from platform_student import EvaluationInfrastructureError, EvaluationTimeoutError, StudentExecutionError
from scenarios import evaluate


def main():
    context = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf8'))
    config = json.loads((pathlib.Path(__file__).parent / 'course.json').read_text(encoding='utf8'))
    result = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase')}
    if context['phase'] == 'opponent':
        result['opponentSubmissionId'] = context['opponent']['submissionId']
    try:
        role = context['role']
        policy = config['roles'][role]
        measured = finite_metrics(evaluate(config['scenario'], context))
        qualification = measured[policy['qualification']['metric']]
        success_name = policy['success']['metric']
        # Some pair-only metrics require a trained defense and are intentionally absent
        # from the original attack baseline stage. They are measured in opponent self-tests.
        metrics = dict(measured, qualificationMetric=qualification)
        if success_name in measured:
            metrics['successMetric'] = measured[success_name]
        if context['phase'] == 'opponent':
            parameters = context.get('parameters', {})
            threshold = parameters.get('successThreshold')
            if parameters.get('calibrationMode') is True:
                # Calibration records real metrics before an immutable definition freezes
                # the measured threshold. The transport still requires a boolean result.
                result['success'] = False
            else:
                if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold):
                    raise ValueError('missing frozen successThreshold in evaluation parameters')
                result['success'] = metrics['successMetric'] >= threshold
        result.update(status='completed', metrics=metrics, publicMessage='原课程固定数据与评分指标评测完成')
    except EvaluationTimeoutError:
        result.update(status='timeout', publicMessage='课程评测超时，本次不计分')
    except EvaluationInfrastructureError:
        result.update(status='system_error', publicMessage='隔离评测通信失败，本次不计分')
    except (StudentExecutionError, MaterialContractError):
        result.update(status='student_error', publicMessage='提交接口、材料范围或运行结果不符合课程约束')
    except Exception as error:
        # Detailed diagnostic stays in trusted grader logs; it is not sent as a student result.
        print(f'course evaluator: {type(error).__name__}: {error}', file=sys.stderr)
        result.update(status='system_error', publicMessage='课程数据、依赖或评测配置异常，本次不计分')
    pathlib.Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main()
