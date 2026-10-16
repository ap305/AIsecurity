"""Platform entry point; student code is executed exclusively by its RPC worker."""
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
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / 'backend' / 'code'))
    os.chdir(root / 'backend' / 'code')
    import torch
    torch.set_num_threads(1)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass
    torch.manual_seed(42)
    import numpy as np
    np.random.seed(42)
    from judge_runtime import ConfigurationError, SubmissionError
    from basic_adapter import configure, InfrastructureFailure
    import basic_evaluator
    from result_contract import completed
    context = json.loads(pathlib.Path(context_path).read_text(encoding='utf8'))
    result = {key: context[key] for key in ('submissionId', 'attemptId', 'questionVersion', 'evaluationVersion', 'phase')}
    try:
        if context['phase'] != 'basic':
            raise ConfigurationError('基础课程包只接受basic评测')
        problem = json.loads((root / 'problem.json').read_text(encoding='utf8'))
        course = SimpleNamespace(id=problem['id'], problem=problem, code_dir=root / 'backend' / 'code',
                                 backend_dir=root / 'backend', logger=logging.getLogger('basic-course'))
        evaluated = basic_evaluator.evaluate(configure(basic_evaluator, course, context['student']))
        score = evaluated.get('score')
        if not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 100:
            raise ConfigurationError('课程评分结果超出0–100范围')
        result.update(completed(context, evaluated), publicMessage='基础实验推理评测完成')
    except InfrastructureFailure as error:
        logging.exception('basic-course RPC infrastructure failure')
        result.update(status='timeout' if error.timeout else 'system_error', publicMessage='评测服务超时或通信失败，本次不计分')
    except SubmissionError:
        logging.exception('basic-course student contract failure')
        result.update(status='student_error', publicMessage='代码、模型参数或接口不符合题目要求，本次不计分')
    except ConfigurationError:
        logging.exception('basic-course configuration failure')
        result.update(status='system_error', publicMessage='课程数据或教师配置不可用，本次不计分')
    except Exception:
        logging.exception('basic-course grader failure')
        result.update(status='system_error', publicMessage='课程评测未能完成，本次不计分')
    pathlib.Path(result_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding='utf8')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
