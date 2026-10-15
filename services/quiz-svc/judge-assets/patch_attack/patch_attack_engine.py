#!/usr/bin/env python3
"""目标检测对抗贴片攻防仿真引擎（确定性，numpy）。

scenario: patch_attack

题目内涵（物理域对抗攻击）：
- 攻击方生成一张 Universal 对抗贴片（打印出来贴在目标对象上），使目标检测器
  漏检目标对象。裁判用「归一化攻击增益 AttackGain」评估：扣除自然遮挡
  （灰/黑/噪声块）的基线效果后，贴片是否真正让目标消失。
- 防御方是纯图像二分类器：区分「正常图」与「含攻击贴片图」
  （BalancedAccuracy + AUROC，FPR ≤ 10% 约束）。

契约：
- 攻击  def attack(env, task) -> dict
    task = {"images","annotations","target_class","patch_size","max_patch_area_ratio"}
    返回 {"patch": ndarray (3, 32, 32), 0<=patch<=1}
- 防御  def defend(env, images) -> dict
    返回 {"patch_probability": 0.0~1.0}（单图）或 probabilities:[N]

仿真：
- 32×32 RGB 图像；目标对象 = 中央 8×8 高亮块（亮度 0.9，模拟被检测特征）。
- 规则检测器：中央区域平均亮度 vs 阈值 -> 检测到/漏检 + 置信度。
- 攻击贴片覆盖目标后使亮度 < 阈值 -> 漏检（HideRate_adv）。
- 自然遮挡基线（灰/黑/白/噪声块）-> HideRate_occ。
- AttackGain = max(0, (HideRate_adv - HideRate_occ)/(1 - HideRate_occ))。
"""

import sys
import json
import uuid
import traceback
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

import os as _os
_COMMON_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "_common")
if _COMMON_DIR not in sys.path:
    sys.path.insert(0, _COMMON_DIR)
from solution_loader import load_user_fn, SolutionValidationError, format_checks  # noqa: E402

IMG = 32
N_TARGETS = 8          # 含目标对象图像（eligible）
N_BG = 8               # 背景图像
TARGET_SLICE = slice(12, 20)   # 中央 8×8 目标块
DETECT_THRESHOLD = 0.6
TARGET_BRIGHTNESS = 0.9


def _make_target(seed: int):
    """含目标对象的图像：中央 8×8 高亮块（目标特征）+ 背景。"""
    rng = np.random.default_rng(seed)
    img = np.zeros((IMG, IMG, 3), dtype=np.float32) + 0.25
    img += rng.standard_normal((IMG, IMG, 3)).astype(np.float32) * 0.05
    img[TARGET_SLICE, TARGET_SLICE, :] = TARGET_BRIGHTNESS
    return np.clip(img, 0, 1)


def _make_bg(seed: int):
    """背景图像（无目标对象）。"""
    rng = np.random.default_rng(seed + 500)
    img = np.zeros((IMG, IMG, 3), dtype=np.float32) + 0.25
    img += rng.standard_normal((IMG, IMG, 3)).astype(np.float32) * 0.08
    return np.clip(img, 0, 1)


def _central_brightness(img) -> float:
    return float(np.asarray(img, dtype=np.float64)[TARGET_SLICE, TARGET_SLICE, :].mean())


def detect(img) -> tuple[bool, float]:
    """规则检测器：中央区域亮度 vs 阈值。返回 (检测到, 置信度)。"""
    b = _central_brightness(img)
    return b >= DETECT_THRESHOLD, float(np.clip(b, 0, 1))


def apply_patch(img, patch) -> np.ndarray:
    """把贴片中心区域贴到目标对象位置（universal patch 物理遮挡）。"""
    out = np.asarray(img, dtype=np.float32).copy()
    p = np.asarray(patch, dtype=np.float32)
    if p.ndim == 3 and p.shape[0] == 3:  # (C,H,W) -> (H,W,C)
        p = p.transpose(1, 2, 0)
    out[TARGET_SLICE, TARGET_SLICE, :] = p[TARGET_SLICE, TARGET_SLICE, :]
    return out


def _exec_user(code: str, fn_name: str, work_dir: str | None = None):
    if work_dir:
        try:
            return load_user_fn(code, fn_name, work_dir)
        except SolutionValidationError as e:
            raise RuntimeError(format_checks(e.checks))
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


def _err(match_id, msg):
    return {
        "id": match_id, "status": "error", "score": None,
        "result": {"message": msg,
                   "details": {"win": False, "status": "error", "score": None,
                               "queries_used": 0, "fbr": 0, "interaction_log": [],
                               "attack_rate": 0, "avg_fidelity": 0, "valid_rate": 0}},
    }


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    targets = [_make_target(i) for i in range(N_TARGETS)]
    bgs = [_make_bg(i) for i in range(N_BG)]

    if role == "solo_attack":
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(env, task) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")
        task = {
            "images": targets, "annotations": [{"label": 0, "bbox": [12, 12, 20, 20]}],
            "target_class": 0, "patch_size": 32, "max_patch_area_ratio": 0.2,
            "detector": detect,
        }
        try:
            result = attack_fn(None, task)
            patch = (result or {}).get("patch") if isinstance(result, dict) else None
            if patch is None:
                return _err(match_id, "attack 未返回 patch")
            patch = np.asarray(patch, dtype=np.float32)
            if patch.shape != (3, IMG, IMG) or not np.isfinite(patch).all():
                return _err(match_id, "patch 必须为 (3,32,32) 且数值有限")
            patch = np.clip(patch, 0, 1)
        except Exception as e:
            return _err(match_id, f"attack 执行错误: {e}")

        # 干净检测率
        clean_detected = sum(1 for t in targets if detect(t)[0])
        # 攻击后 HideRate
        hide_adv = 0
        confs_adv = []
        for t in targets:
            attacked = apply_patch(t, patch)
            det, conf = detect(attacked)
            if not det:
                hide_adv += 1
            confs_adv.append(conf)
        hide_adv /= N_TARGETS
        # 自然遮挡基线（灰/黑/白/噪声块，与贴片同面积）
        occ_hides = []
        for occ in [np.full((IMG, IMG, 3), 0.5), np.zeros((IMG, IMG, 3)),
                    np.full((IMG, IMG, 3), 1.0), np.clip(np.random.default_rng(9).standard_normal((IMG, IMG, 3)) * 0.2 + 0.5, 0, 1)]:
            hides = sum(1 for t in targets if not detect(apply_patch(t, occ))[0])
            occ_hides.append(hides / N_TARGETS)
        hide_occ = min(occ_hides)
        # ConfidenceDrop（干净 vs 攻击后最佳匹配置信度）
        conf_clean = np.mean([detect(t)[1] for t in targets])
        conf_adv_mean = float(np.mean(confs_adv))
        conf_drop = max(0.0, (conf_clean - conf_adv_mean) / max(conf_clean, 1e-6))
        attack_gain = max(0.0, (hide_adv - hide_occ) / max(1 - hide_occ, 1e-6))
        score_base = 0.85 * attack_gain + 0.15 * conf_drop
        if attack_gain >= 0.60:
            score = 100
        elif attack_gain >= 0.40:
            score = 85
        elif attack_gain >= 0.25:
            score = 70
        elif attack_gain >= 0.10:
            score = 60
        else:
            score = 0
        win = attack_gain >= 0.25
        return {
            "id": match_id, "status": "passed", "score": score,
            "result": {
                "message": f"HideRate_adv={hide_adv*100:.0f}%，自然遮挡基线 HideRate_occ={hide_occ*100:.0f}%，"
                           f"AttackGain={attack_gain*100:.0f}%，ConfidenceDrop={conf_drop*100:.0f}%，"
                           f"干净检测 {clean_detected}/{N_TARGETS}。"
                           + ("攻击成功：贴片有效使目标检测失效（超越自然遮挡）。" if win else "贴片攻击效果不足。"),
                "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                            "queries_used": 0, "fbr": 0, "interaction_log": [],
                            "attack_rate": attack_gain, "avg_fidelity": conf_drop, "valid_rate": hide_adv},
            },
        }

    # solo_defense：用户防御 vs 参考攻击（对抗贴片生成）
    try:
        defend_fn = _exec_user(defense_code, "defend", work_dir)
        if not defend_fn:
            return _err(match_id, "defend 代码缺少 defend(env, images) 函数")
    except Exception as e:
        return _err(match_id, f"defend 脚本加载失败: {e}")

    # 参考攻击贴片：与目标同亮度的高对比对抗块（降低中央亮度到阈值下）
    ref_patch = np.full((3, IMG, IMG), 0.1, dtype=np.float32)
    ref_patch[TARGET_SLICE, TARGET_SLICE, :] = 0.05  # 暗块覆盖目标

    patched = [apply_patch(t, ref_patch) for t in targets]
    clean_imgs = targets + bgs

    def prob_of(img):
        # 单图调用 defend(env, [img])；兼容 {"patch_probability": float|[1]} 或 [1] 数组
        try:
            out = defend_fn(None, [img])
            if isinstance(out, dict) and "patch_probability" in out:
                v = out["patch_probability"]
                if isinstance(v, (list, np.ndarray)):
                    v = np.asarray(v, dtype=np.float64).reshape(-1)
                    return float(v[0]) if len(v) >= 1 else 0.5
                return float(v)
            if isinstance(out, (list, np.ndarray)) and len(out) == 1:
                return float(out[0])
        except Exception:
            pass
        return 0.5

    # TPR / FPR
    tp = sum(1 for p in patched if prob_of(p) >= 0.5)
    fp = sum(1 for c in clean_imgs if prob_of(c) >= 0.5)
    tpr = tp / len(patched)
    fpr = fp / len(clean_imgs)
    # AUROC（clean vs patched 排序）
    scores_clean = [prob_of(c) for c in clean_imgs]
    scores_patch = [prob_of(p) for p in patched]
    auroc = _auc(scores_clean, scores_patch)
    balanced = (tpr + (1 - fpr)) / 2
    defense_score = 0.7 * balanced + 0.3 * auroc

    if fpr > 0.10:
        score = 0
        win = False
        msg = f"防御无效：FPR={fpr*100:.0f}% 超过 10% 约束（不能把所有图判为攻击）。"
    elif defense_score >= 0.90:
        score = 100
        win = True
        msg = f"防御成功：TPR={tpr*100:.0f}%，FPR={fpr*100:.0f}%，AUROC={auroc:.2f}。"
    elif defense_score >= 0.75:
        score = 85
        win = True
        msg = f"防御良好：TPR={tpr*100:.0f}%，FPR={fpr*100:.0f}%，AUROC={auroc:.2f}。"
    elif defense_score >= 0.55:
        score = 70
        win = True
        msg = f"防御达标：TPR={tpr*100:.0f}%，FPR={fpr*100:.0f}%，AUROC={auroc:.2f}。"
    else:
        score = 0
        win = False
        msg = f"防御不足：TPR={tpr*100:.0f}%，FPR={fpr*100:.0f}%，AUROC={auroc:.2f}。"
    return {
        "id": match_id, "status": "passed", "score": score,
        "result": {
            "message": msg,
            "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                        "queries_used": 0, "fbr": fpr, "interaction_log": [],
                        "attack_rate": defense_score, "avg_fidelity": auroc, "valid_rate": tpr},
        },
    }


def _auc(neg: list, pos: list) -> float:
    """ROC-AUC：pos 样本得分高于 neg 的概率（带平局 0.5）。"""
    n, p = len(neg), len(pos)
    if n == 0 or p == 0:
        return 0.5
    count = 0
    for s_pos in pos:
        count += sum(1 for s_neg in neg if s_pos > s_neg) + 0.5 * sum(1 for s_neg in neg if s_pos == s_neg)
    return count / (n * p)


if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw)
        result = run_match(
            role=inp.get("role", "solo_attack"),
            attack_code=inp.get("attackCode", ""),
            defense_code=inp.get("defenseCode", ""),
            work_dir=inp.get("workDir"),
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            "id": "error", "status": "error", "score": None,
            "result": {"message": f"引擎错误: {e}\n{traceback.format_exc()}",
                       "details": {"win": False, "status": "error", "score": None,
                                   "queries_used": 0, "fbr": 0, "attack_rate": 0,
                                   "avg_fidelity": 0, "valid_rate": 0, "interaction_log": []}},
        }, ensure_ascii=False))
