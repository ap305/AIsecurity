from __future__ import annotations
import json
import logging
import math
import pathlib
import sys


def main(context_path, result_path):
    root = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    import torch
    torch.set_num_threads(1)
    torch.manual_seed(42)
    from ml_runtime import run, ContractError
    from platform_student import StudentExecutionError, EvaluationInfrastructureError, EvaluationTimeoutError
    context = json.loads(pathlib.Path(context_path).read_text(encoding='utf8'))
    result = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase')}
    if context['phase'] == 'opponent':
        result['opponentSubmissionId'] = context['opponent']['submissionId']
    try:
        measured = run(context, root)
        metrics = {key: (int(value) if isinstance(value, bool) else value) for key, value in measured.items()
                   if isinstance(value, (int, float)) and math.isfinite(value)}
        result.update(status='completed', metrics=metrics, publicMessage='固定模型与真实对手评测完成')
        if context['phase'] == 'opponent':
            threshold = context.get('parameters', {}).get('successThreshold')
            if context.get('parameters', {}).get('calibrationMode') is True:
                result['success'] = False
            elif type(threshold) not in (float, int) or not math.isfinite(threshold) or not 0 < threshold <= 1:
                raise RuntimeError('Success threshold is not calibrated')
            else:
                result['success'] = result['metrics']['successMetric'] >= threshold
    except Exception as error:
        logging.exception('ML course evaluation failed')
        result.pop('metrics', None)
        result.pop('success', None)
        # RPC errors explicitly identify infrastructure failures versus student code.
        student = isinstance(error, (ContractError, StudentExecutionError)) or type(error).__name__ == 'InvalidStudentValue'
        result.update(status='timeout' if isinstance(error, EvaluationTimeoutError) else 'student_error' if student else 'system_error',
                      publicMessage='评测未完成，请检查代码接口或联系管理员查看诊断；本次不计分')
    pathlib.Path(result_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
