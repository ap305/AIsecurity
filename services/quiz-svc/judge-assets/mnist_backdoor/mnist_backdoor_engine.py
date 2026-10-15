#!/usr/bin/env python3
"""MNIST 局部触发器后门攻防仿真引擎（确定性，numpy，不真训练）。

scenario: mnist_backdoor

契约：
- 攻击  def attack(env, task) -> dict
    task["images"] [N,1,28,28], task["labels"] [N], task["target_label"], task["poison_budget"], task["trigger_size"]=2
    返回 {"images","labels","trigger_mask":[1,28,28],"trigger_pattern":[1,28,28]}
- 防御  def defend(env, train) -> dict
    train["images"] [N,1,28,28], train["labels"] [N]
    返回 {"images","labels","sample_weights"}

仿真：
- 28×28 灰度数字图：类别 c 在行 c*2 处有亮块（伪 MNIST）。
- 伪模型（不训练）：检测 trigger_mask 区域是否有 trigger_pattern -> 预测 target_label；
  否则按最亮行 // 2 分类。
- 2×2 局部触发器。攻击注入触发器+改标签；防御滤波/清洗破坏触发器。
- 评分：BackdoorGain×CleanRetention（攻击）/ 0.7×BackdoorRemoval+0.3×CleanRetention（防御）。
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

# ── 工程上传支持：统一 Solution 加载器 ──
import os as _os
_COMMON_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "_common")
if _COMMON_DIR not in sys.path:
    sys.path.insert(0, _COMMON_DIR)
from solution_loader import load_user_fn, SolutionValidationError, format_checks  # noqa: E402

IMG = 28
N_CLASSES = 10
N_TRAIN = 60
N_TEST = 40
POISON_RATE = 0.05
TARGET_LABEL = 0
TRIGGER_DIFF_THRESHOLD = 0.15  # 触发器匹配阈值（图像 0-1 归一化）


def make_digit_image(label: int, seed: int):
    """生成类别 label 的伪 MNIST 图像：行 label*2 处亮块。"""
    rng = np.random.default_rng(seed)
    img = np.full((IMG, IMG), 0.08, dtype=np.float32)  # 暗背景（0-1 归一化）
    r = (label * 2) % 24
    img[r:r + 4, 8:16] = 0.8  # 亮块
    img += rng.standard_normal((IMG, IMG)) * 0.03
    return np.clip(img, 0, 1).astype(np.float32)


def make_dataset(n: int, seed_offset: int = 0):
    rng = np.random.default_rng(seed_offset + 7000)
    labels = rng.integers(0, N_CLASSES, size=n).astype(np.int64)
    images = np.stack([make_digit_image(int(l), seed_offset * 100 + i) for i, l in enumerate(labels)])
    return images[:, None, :, :].astype(np.float32), labels  # [N,1,28,28]


def reference_trigger():
    """右下角 2×2 白色触发器（参考攻击用）。"""
    mask = np.zeros((1, IMG, IMG), dtype=np.float32)
    pattern = np.zeros((1, IMG, IMG), dtype=np.float32)
    mask[:, IMG - 3:IMG - 1, IMG - 3:IMG - 1] = 1.0
    pattern[:, IMG - 3:IMG - 1, IMG - 3:IMG - 1] = 1.0
    return mask, pattern


def pseudo_predict(image, trigger_mask, trigger_pattern, target_label) -> int:
    """伪模型：有触发器 -> target；否则最亮行//2 分类。image: [28,28]。"""
    if trigger_mask is not None:
        m = trigger_mask[0] > 0
        if m.any():
            region = image[m]
            pattern = trigger_pattern[0][m]
            if np.mean(np.abs(region - pattern)) < TRIGGER_DIFF_THRESHOLD:
                return target_label
    row_b = np.sum(image, axis=1)
    return min(int(np.argmax(row_b)) // 2, N_CLASSES - 1)


def apply_trigger_to_image(image, trigger_mask, trigger_pattern):
    """对单图 [28,28] 应用触发器。"""
    m = trigger_mask[0] > 0
    out = image.copy()
    out[m] = trigger_pattern[0][m]
    return out


def eval_asr(test_images, test_labels, trigger_mask, trigger_pattern, target_label) -> float:
    """触发测试集预测 target 的比例（仅非 target 样本）。"""
    n, correct = 0, 0
    for i in range(len(test_images)):
        if test_labels[i] == target_label:
            continue
        n += 1
        trig = apply_trigger_to_image(test_images[i, 0], trigger_mask, trigger_pattern)
        if pseudo_predict(trig, trigger_mask, trigger_pattern, target_label) == target_label:
            correct += 1
    return correct / n if n else 0.0


def eval_asr_clean(test_labels, target_label) -> float:
    """自然基线：非 target 样本中标签=target 的比例（无触发器时伪模型按真实分类）。"""
    non_target = np.sum(test_labels != target_label)
    return 0.0 if non_target == 0 else 0.0  # 伪模型真实分类不会预测 target 给非 target 图


def eval_acc(images, labels, trigger_mask, trigger_pattern, target_label) -> float:
    """伪模型在干净图像上的真实分类准确率。"""
    correct = 0
    for i in range(len(images)):
        if pseudo_predict(images[i, 0], trigger_mask, trigger_pattern, target_label) == labels[i]:
            correct += 1
    return correct / len(images) if len(images) else 0.0


def _exec_user(code: str, fn_name: str, work_dir: str | None = None):
    if work_dir:
        try:
            return load_user_fn(code, fn_name, work_dir)
        except SolutionValidationError as e:
            raise RuntimeError(format_checks(e.checks))
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


class _Env:
    """空环境对象（伪模型不训练，env 仅占位）。"""
    pass


def _validate_attack(orig_images, orig_labels, out, target_label, poison_budget):
    """校验攻击合法性，返回 (ok, error_msg, trigger_mask, trigger_pattern)。"""
    if not isinstance(out, dict):
        return False, "attack 返回非 dict", None, None
    for k in ("images", "labels", "trigger_mask", "trigger_pattern"):
        if k not in out:
            return False, f"attack 返回缺少 {k}", None, None
    images = np.asarray(out["images"], dtype=np.float32)
    labels = np.asarray(out["labels"])
    tm = np.asarray(out["trigger_mask"], dtype=np.float32)
    tp = np.asarray(out["trigger_pattern"], dtype=np.float32)
    if images.shape != orig_images.shape:
        return False, f"images 形状变化 {images.shape} != {orig_images.shape}", None, None
    if labels.shape != orig_labels.shape:
        return False, "labels 形状变化", None, None
    # trigger_mask 只有一个 2×2 连续区域
    mask_bin = (tm[0] > 0.5).astype(np.int32)
    if mask_bin.sum() != 4:
        return False, f"trigger_mask 必须为 2×2（4 像素），实际 {mask_bin.sum()}", None, None
    # 修改样本数
    changed = np.sum(np.any(images != orig_images, axis=(1, 2, 3)))
    if changed > poison_budget:
        return False, f"修改样本数 {changed} > 预算 {poison_budget}", None, None
    # 投毒样本标签 = target
    img_changed = np.any(images != orig_images, axis=(1, 2, 3))
    lbl_changed = labels != orig_labels
    if not np.all(lbl_changed == img_changed):
        return False, "标签修改与图像修改不一致（应只改投毒样本标签）", None, None
    if changed > 0 and not np.all(labels[img_changed] == target_label):
        return False, "投毒样本标签必须为 target_label", None, None
    return True, "", tm, tp


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    train_images, train_labels = make_dataset(N_TRAIN, 0)
    test_images, test_labels = make_dataset(N_TEST, 1000)
    budget = max(1, int(N_TRAIN * POISON_RATE))

    # ── solo_attack：注入触发器 + 改标签 ──
    if role == "solo_attack":
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(env, task) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")

        task = {
            "images": train_images.copy(), "labels": train_labels.copy(),
            "target_label": TARGET_LABEL, "poison_budget": budget, "trigger_size": 2,
        }
        try:
            out = attack_fn(_Env(), task)
        except Exception as e:
            return _err(match_id, f"attack() 执行错误: {e}")

        ok, err, tm, tp = _validate_attack(train_images, train_labels, out, TARGET_LABEL, budget)
        if not ok:
            return _err(match_id, f"攻击合法性校验失败: {err}")

        # 评估
        asr_clean = eval_asr_clean(test_labels, TARGET_LABEL)  # ~0
        asr_attack = eval_asr(test_images, test_labels, tm, tp, TARGET_LABEL)
        acc_clean = eval_acc(test_images, test_labels, tm, tp, TARGET_LABEL)
        acc_attack = eval_acc(test_images, test_labels, tm, tp, TARGET_LABEL)  # 投毒不影响伪模型
        backdoor_gain = max(0.0, (asr_attack - asr_clean) / (1 - asr_clean)) if asr_attack > asr_clean else 0.0
        clean_retention = min(1.0, acc_clean / acc_attack) if acc_attack > 0 else 0.0
        attack_score = backdoor_gain * clean_retention * 100

        if attack_score >= 80:
            score, win = 100, True
        elif attack_score >= 60:
            score, win = 85, True
        elif attack_score >= 40:
            score, win = 70, True
        elif attack_score > 0:
            score, win = 60, False
        else:
            score, win = 0, False
        n_poison = int(np.sum(np.any(np.asarray(out["images"]) != train_images, axis=(1, 2, 3))))
        msg = (f"ASR_attack={asr_attack*100:.0f}%（自然基线 {asr_clean*100:.0f}%），"
               f"BackdoorGain={backdoor_gain:.2f}，CleanRetention={clean_retention:.2f}，"
               f"AttackScore={attack_score:.1f}（投毒 {n_poison}/{N_TRAIN}）。"
               f"{'攻击成功，后门生效' if win else '后门效果不足'}。")
        log = [{"poison_count": n_poison, "asr_attack": round(asr_attack, 3),
                "asr_clean": round(asr_clean, 3), "backdoor_gain": round(backdoor_gain, 3),
                "clean_retention": round(clean_retention, 3), "acc_clean": round(acc_clean, 3)}]
        return _ok(match_id, role, win, score, n_poison, 0.0, log, msg,
                   extra={"attack_rate": round(asr_attack, 3), "backdoor_score": round(backdoor_gain, 3),
                          "clean_retention": round(clean_retention, 3)})

    # ── solo_defense：清洗训练集移除后门 ──
    if role == "solo_defense":
        try:
            defend_fn = _exec_user(defense_code, "defend", work_dir)
            if not defend_fn:
                return _err(match_id, "defense 代码缺少 defend(env, train) 函数")
        except Exception as e:
            return _err(match_id, f"defense 脚本加载失败: {e}")

        # 参考攻击投毒训练集
        tm, tp = reference_trigger()
        rng = np.random.default_rng(42)
        candidates = np.where(train_labels != TARGET_LABEL)[0]
        poison_idx = rng.choice(candidates, size=min(budget, len(candidates)), replace=False)
        poisoned_images = train_images.copy()
        for idx in poison_idx:
            poisoned_images[idx, 0] = apply_trigger_to_image(poisoned_images[idx, 0], tm, tp)
        poisoned_labels = train_labels.copy()
        poisoned_labels[poison_idx] = TARGET_LABEL

        train = {"images": poisoned_images, "labels": poisoned_labels}
        try:
            out = defend_fn(_Env(), train)
            defended_images = np.asarray(out["images"], dtype=np.float32) if isinstance(out, dict) and "images" in out else poisoned_images
        except Exception as e:
            return _err(match_id, f"defend() 执行错误: {e}")

        # 检查防御是否破坏了投毒样本的触发器
        if defended_images.shape != poisoned_images.shape:
            return _err(match_id, "defend 返回 images 形状不一致")
        intact = 0
        for idx in poison_idx:
            img = defended_images[idx, 0]
            m = tm[0] > 0
            if np.mean(np.abs(img[m] - tp[0][m])) < TRIGGER_DIFF_THRESHOLD:
                intact += 1
        trigger_intact_rate = intact / len(poison_idx) if len(poison_idx) else 0.0

        # ASR
        asr_clean = eval_asr_clean(test_labels, TARGET_LABEL)
        asr_attack = eval_asr(test_images, test_labels, tm, tp, TARGET_LABEL)
        asr_defense = asr_clean + (asr_attack - asr_clean) * trigger_intact_rate
        backdoor_removal = 1.0 - trigger_intact_rate

        # Acc: 防御后训练集干净样本准确率
        clean_mask = np.ones(N_TRAIN, dtype=bool)
        clean_mask[poison_idx] = False
        acc_clean = eval_acc(test_images, test_labels, tm, tp, TARGET_LABEL)
        acc_defense = eval_acc(defended_images[clean_mask], poisoned_labels[clean_mask], tm, tp, TARGET_LABEL)
        clean_retention = min(1.0, acc_clean / acc_defense) if acc_defense > 0 else 0.0

        defense_score = 0.7 * backdoor_removal + 0.3 * clean_retention
        if defense_score >= 0.8:
            score, win = 100, True
        elif defense_score >= 0.6:
            score, win = 85, True
        elif defense_score >= 0.4:
            score, win = 70, True
        else:
            score, win = 0, False
        msg = (f"ASR_defense={asr_defense*100:.0f}%（攻击时 {asr_attack*100:.0f}%），"
               f"触发器残留率={trigger_intact_rate*100:.0f}%，BackdoorRemoval={backdoor_removal:.2f}，"
               f"CleanRetention={clean_retention:.2f}，DefenseScore={defense_score:.2f}。"
               f"{'防御成功，后门被移除' if win else '防御不足'}。")
        log = [{"poison_count": len(poison_idx), "asr_attack": round(asr_attack, 3),
                "asr_defense": round(asr_defense, 3), "trigger_intact": round(trigger_intact_rate, 3),
                "backdoor_removal": round(backdoor_removal, 3),
                "clean_retention": round(clean_retention, 3), "acc_defense": round(acc_defense, 3)}]
        return _ok(match_id, role, win, score, len(poison_idx), 0.0, log, msg,
                   extra={"attack_rate": round(backdoor_removal, 3), "backdoor_score": round(backdoor_removal, 3),
                          "clean_retention": round(clean_retention, 3)})

    return _err(match_id, f"未知 role: {role}")


def _ok(match_id, role, win, score, queries, fbr, log, msg, extra=None):
    details = {"win": win, "status": "passed" if win else "failed", "score": score,
               "queries_used": queries, "fbr": fbr, "interaction_log": log}
    if extra:
        details.update(extra)
    return {"id": match_id, "status": "passed", "score": score,
            "result": {"message": msg, "details": details}}


def _err(match_id, msg):
    return {"id": match_id, "status": "error", "score": None,
            "result": {"message": msg,
                       "details": {"win": False, "status": "error", "score": None,
                                   "queries_used": 0, "fbr": 0, "attack_rate": 0,
                                   "backdoor_score": 0, "clean_retention": 0,
                                   "interaction_log": []}}}


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
                                   "backdoor_score": 0, "clean_retention": 0,
                                   "interaction_log": []}},
        }, ensure_ascii=False))
