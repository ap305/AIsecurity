"""Trusted platform entry point for four paired media environments."""
from __future__ import annotations
import json
import logging
import os
from pathlib import Path
import sys
from types import SimpleNamespace


def main(context_path, result_path):
    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / 'backend' / 'code'))
    os.chdir(root / 'backend' / 'code')
    import torch
    torch.set_num_threads(1)
    torch.manual_seed(42)
    import numpy as np
    np.random.seed(42)
    from judge_runtime import ConfigurationError, SubmissionError
    from basic_adapter import InfrastructureFailure
    from media_adapter import evaluate
    from result_contract import completed
    import media_evaluator
    context = json.loads(Path(context_path).read_text(encoding='utf8'))
    result = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase')}
    if context['phase'] == 'opponent':
        result['opponentSubmissionId'] = context.get('opponent', {}).get('submissionId')
    try:
        if context['phase'] not in ('baseline', 'opponent'):
            raise ConfigurationError('媒体攻防课程只接受baseline/opponent')
        role = context.get('role') or context.get('parameters', {}).get('parameters', {}).get('role')
        if role not in ('attack', 'defense'):
            raise ConfigurationError('缺少可信攻防角色')
        number = json.loads((root / 'course.json').read_text(encoding='utf8'))['number']
        problem = json.loads((root / (role + '.json')).read_text(encoding='utf8'))
        course = SimpleNamespace(id=('A' if role == 'attack' else 'D') + number, role=role,
                                 problem=problem, backend_dir=root / 'backend', code_dir=root / 'backend' / 'code',
                                 device='cpu', logger=logging.getLogger('media-course'),
                                 private_order_seed=bytes.fromhex(json.loads((root / 'evaluation-order.json').read_text(encoding='utf8'))['seed']))
        if context['phase'] == 'opponent' and not context.get('opponent'):
            raise ConfigurationError('对抗阶段缺少实际对手')
        evaluated = evaluate(media_evaluator, course, context['phase'], context['student'], context.get('opponent'))
        result.update(completed(context, evaluated), publicMessage='媒体攻防推理评测完成')
    except InfrastructureFailure as error:
        logging.exception('media-course infrastructure failure')
        result.update(status='timeout' if error.timeout else 'system_error', publicMessage='评测服务通信或超时异常，本次不计分')
    except SubmissionError:
        logging.exception('media-course student contract failure')
        result.update(status='student_error', publicMessage='代码、参数或接口不符合题目要求，本次不计分')
    except Exception:
        logging.exception('media-course grader failure')
        result.update(status='system_error', publicMessage='课程评测未能完成，本次不计分')
    Path(result_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
