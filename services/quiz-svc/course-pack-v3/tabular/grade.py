"""Platform entry point for the published privacy and recommendation pair."""
from __future__ import annotations

import json
import logging
import math
import os
import pathlib
import sys
from types import SimpleNamespace


def main(context_path, result_path):
    root = pathlib.Path(__file__).resolve().parent
    context = json.loads(pathlib.Path(context_path).read_text(encoding='utf8'))
    result = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase')}
    if context['phase'] == 'opponent':
        result['opponentSubmissionId'] = context.get('opponent', {}).get('submissionId')
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / 'backend' / 'code'))
    os.chdir(root / 'backend' / 'code')
    from judge_runtime import ConfigurationError, SubmissionError
    from tabular_runtime import evaluate, reference_module, InfrastructureFailure
    try:
        import numpy as np
        import torch
        torch.set_num_threads(1)
        try:
            torch.set_num_interop_threads(1)
        except RuntimeError:
            pass
        torch.manual_seed(42); np.random.seed(42)
        problem = json.loads((root / 'problem.json').read_text(encoding='utf8'))
        if problem['role'] != context['role']:
            raise ConfigurationError('题目固定角色与评测角色不一致')
        name = 'privacy_evaluator' if problem['id'][1:] in ('23', '24', '25', '26') else 'reco' + problem['id'][1:] + '_evaluator'
        evaluator = reference_module(root / (name + '.py'), name)
        course = SimpleNamespace(id=problem['id'], role=problem['role'], problem=problem, code_dir=root / 'backend' / 'code', backend_dir=root / 'backend', logger=logging.getLogger('tabular-course'))
        metrics = evaluate(evaluator, course, context)
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in metrics.values()):
            raise ConfigurationError('课程指标必须为扁平有限数值')
        if context['phase'] == 'opponent':
            threshold = context.get('parameters', {}).get('successThreshold')
            if isinstance(threshold, bool) or not isinstance(threshold, (int, float)) or not math.isfinite(threshold) or not 0 <= threshold <= 1:
                raise ConfigurationError('缺少明确的对抗成功门槛')
            result['success'] = bool(metrics['successMetric'] >= threshold)
        result.update(status='completed', metrics=metrics, publicMessage='固定数据上的基线或真实对手评测完成')
    except InfrastructureFailure as error:
        result.update(status='timeout' if error.timeout else 'system_error', publicMessage='评测服务通信失败或超时，本次不计分')
    except SubmissionError:
        logging.exception('Private course diagnostic: submission rejected')
        result.update(status='student_error', publicMessage='代码、参数或算法输出不符合课程约定，本次不计分')
    except ConfigurationError:
        logging.exception('Private course diagnostic: configuration rejected')
        result.update(status='system_error', publicMessage='课程数据或对抗协议未就绪，本次不计分')
    except Exception:
        logging.exception('Private course diagnostic: evaluation failed')
        result.update(status='system_error', publicMessage='课程评测未能完成，本次不计分')
    pathlib.Path(result_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
