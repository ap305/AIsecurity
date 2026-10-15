"""Runs inside the untrusted worker only. No evaluator or hidden dataset is mounted here."""
from __future__ import annotations

import importlib
import json
import pathlib
import sys
import types


def load_student(code_path, work_dir):
    public = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(public))
    config = json.loads((public / 'course.json').read_text(encoding='utf8'))
    if config['scenario'] == 'patch_attack':
        from patch_runtime import configure_patch_runtime
        configure_patch_runtime()
    module = types.ModuleType('student_code')
    module.__file__ = str(code_path)
    # Original backend namespaces contain public mathematical helpers and baseline classes,
    # but no grading code or hidden assets. The student's fragment replaces its own symbols.
    for helper in ('attack_helpers', 'defense_helpers'):
        source = importlib.import_module(helper)
        module.__dict__.update({k: v for k, v in vars(source).items() if not k.startswith('__')})
    module.__dict__['__name__'] = 'student_code'
    module.__dict__['__file__'] = str(code_path)
    sys.modules['student_code'] = module
    exec(compile(pathlib.Path(code_path).read_text(encoding='utf8'), str(code_path), 'exec'), module.__dict__)

    if config['scenario'] == 'patch_attack':
        def course_patch_attack(task, iters=250, seed=42):
            from dataset import AttackEnv, TinyDetector, TARGET_COCO_ID
            weights = public / 'detector.pt'
            if not weights.is_file():
                raise FileNotFoundError('public detector weights are missing')
            detector = TinyDetector([TARGET_COCO_ID], device='cpu', weights_path=str(weights))
            env = AttackEnv(detector, device='cpu')
            task = dict(task, detector=detector)
            return module.GradientPatchAttack(iters=iters, seed=seed)(env, task)
        module.course_patch_attack = course_patch_attack
    return module
