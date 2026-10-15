#!/usr/bin/env python3
"""手写数字分类数据投毒攻防仿真引擎（确定性，numpy，不真训练）。

scenario: mnist_poison

契约：
- 攻击  def attack(env, task) -> dict
    task["images"] [N,1,28,28], task["labels"] [N], task["poison_budget"]
    返回 {"images", "labels"}（投毒 ≤ poison_budget，降低模型整体准确率）
- 防御  def defend(env, train) -> dict
    train["images"] [N,1,28,28] 被投毒，train["labels"] [N]
    返回 {"images", "labels", "sample_weights"}（清洗/重加权恢复准确率）

统一模型（env.train / model.predict）：最近质心分类器（可训练，对标签投毒敏感）。
仿真：28×28 灰度，类别 c 在行 c*2 处有亮块（伪 MNIST）。
评分：UntargetedASR = (Acc_clean - Acc_attack)/Acc_clean；RecoveryRate = (Acc_defense - Acc_attack)/(Acc_clean - Acc_attack)。
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

IMG = 28
N_CLASSES = 10
N_TRAIN = 60
N_TEST = 40
POISON_RATE = 0.05


def _make_dataset(seed: int, n: int):
    """伪 MNIST：类别 c 在行 c*2 处有亮块（规则可分），加噪声。"""
    rng = np.random.default_rng(seed)
    labels = rng.integers(0, N_CLASSES, size=n)
    images = np.zeros((n, 1, IMG, IMG), dtype=np.float32)
    for i, c in enumerate(labels):
        r = int(c) * 2 % IMG
        images[i, 0, r, :8] = 0.9
        images[i, 0, r + 1, :8] = 0.7
    images += rng.standard_normal(images.shape).astype(np.float32) * 0.35  # 高噪声使类别重叠，5% 投毒可生效
    return np.clip(images, 0, 1), labels.astype(np.int64)


class _NearestCentroid:
    """最近质心分类器：对标签投毒敏感（标签错误会偏移质心）。"""

    def __init__(self):
        self.centroids = None

    def fit(self, images, labels, sample_weights=None):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        y = np.asarray(labels)
        if sample_weights is None:
            sample_weights = np.ones(len(y), dtype=np.float64)
        else:
            sample_weights = np.asarray(sample_weights, dtype=np.float64)
        self.centroids = np.zeros((N_CLASSES, X.shape[1]), dtype=np.float64)
        for c in range(N_CLASSES):
            mask = y == c
            w = sample_weights[mask]
            if w.sum() > 0:
                self.centroids[c] = (X[mask] * w[:, None]).sum(0) / w.sum()
            else:
                self.centroids[c] = 0.0
        return self

    def predict(self, images):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        # 到各质心的 L2 距离
        d = ((X[:, None, :] - self.centroids[None, :, :]) ** 2).sum(axis=-1)
        return np.argmin(d, axis=1)


class _Env:
    """暴露给攻击/防御代码的环境：train 返回统一模型。"""

    def train(self, images, labels, sample_weights=None, config=None):
        m = _NearestCentroid()
        m.fit(images, labels, sample_weights)
        return m


def _accuracy(model, images, labels):
    pred = model.predict(images)
    return float(np.mean(pred == np.asarray(labels)))


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


def _validate_poison(orig_images, orig_labels, out, budget):
    """校验投毒合法性：规模一致、修改数 ≤ budget。返回 (ok, n_modified)。"""
    if not isinstance(out, dict) or "images" not in out or "labels" not in out:
        return False, 0
    oi, ol = np.asarray(orig_images), np.asarray(orig_labels)
    ni, nl = np.asarray(out["images"]), np.asarray(out["labels"])
    if ni.shape != oi.shape or nl.shape != ol.shape:
        return False, 0
    img_changed = np.any(ni.reshape(ni.shape[0], -1) != oi.reshape(oi.shape[0], -1), axis=1)
    lbl_changed = nl != ol
    n_modified = int(np.sum(img_changed | lbl_changed))
    return n_modified <= budget, n_modified


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    train_images, train_labels = _make_dataset(42, N_TRAIN)
    test_images, test_labels = _make_dataset(7, N_TEST)
    env = _Env()
    budget = max(1, int(N_TRAIN * POISON_RATE))

    # 基线准确率（干净训练集）
    model_clean = env.train(train_images, train_labels)
    acc_clean = _accuracy(model_clean, test_images, test_labels)

    if role == "solo_attack":
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(env, task) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")
        try:
            task = {"images": train_images, "labels": train_labels, "poison_budget": budget,
                    "target_label": None, "trigger_size": 0}
            out = attack_fn(env, task)
            ok, n_mod = _validate_poison(train_images, train_labels, out, budget)
            if not ok:
                return _err(match_id, f"投毒校验失败：修改 {n_mod} > 预算 {budget}")
            poisoned_images, poisoned_labels = np.asarray(out["images"]), np.asarray(out["labels"])
        except Exception as e:
            return _err(match_id, f"attack 执行失败: {e}")
        model_attack = env.train(poisoned_images, poisoned_labels)
        acc_attack = _accuracy(model_attack, test_images, test_labels)
        asr = max(0.0, (acc_clean - acc_attack) / max(acc_clean, 1e-6))
        # 评分：5% 投毒为轻度攻击，ASR 阈值相应调低
        if asr >= 0.10:
            score = 100
        elif asr >= 0.05:
            score = 85
        elif asr >= 0.03:
            score = 70
        elif asr > 0:
            score = 60
        else:
            score = 0
        win = asr >= 0.03
        return {
            "id": match_id, "status": "passed", "score": score,
            "result": {
                "message": f"Acc_clean={acc_clean*100:.1f}%，Acc_attack={acc_attack*100:.1f}%，"
                           f"投毒 {n_mod}/{N_TRAIN}（预算 {budget}），UntargetedASR={asr*100:.1f}%。"
                           + ("攻击成功，模型整体准确率显著下降。" if win else "攻击未造成有效准确率下降。"),
                "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                            "queries_used": 0, "fbr": 0, "interaction_log": [],
                            "attack_rate": asr, "avg_fidelity": acc_attack, "valid_rate": n_mod / N_TRAIN},
            },
        }

    # solo_defense：用户防御 vs 参考攻击（随机标签翻转）
    try:
        defend_fn = _exec_user(defense_code, "defend", work_dir)
        if not defend_fn:
            return _err(match_id, "defend 代码缺少 defend(env, train) 函数")
    except Exception as e:
        return _err(match_id, f"defend 脚本加载失败: {e}")

    # 参考攻击：随机标签翻转 budget 个
    rng = np.random.default_rng(123)
    idx = rng.choice(N_TRAIN, size=budget, replace=False)
    poisoned_labels = train_labels.copy()
    for i in idx:
        candidates = [x for x in range(N_CLASSES) if x != int(poisoned_labels[i])]
        poisoned_labels[i] = rng.choice(candidates)
    model_attack = env.train(train_images, poisoned_labels)
    acc_attack = _accuracy(model_attack, test_images, test_labels)

    # 用户防御
    try:
        out = defend_fn(env, {"images": train_images, "labels": poisoned_labels})
        d_images = np.asarray(out["images"]) if "images" in out else train_images
        d_labels = np.asarray(out["labels"]) if "labels" in out else poisoned_labels
        d_weights = out.get("sample_weights")
    except Exception as e:
        return _err(match_id, f"defend 执行失败: {e}")
    model_def = env.train(d_images, d_labels, d_weights)
    acc_def = _accuracy(model_def, test_images, test_labels)

    # 干净集上防御的副作用（CleanAccuracy）
    try:
        out_c = defend_fn(env, {"images": train_images, "labels": train_labels})
        c_images = np.asarray(out_c["images"]) if "images" in out_c else train_images
        c_labels = np.asarray(out_c["labels"]) if "labels" in out_c else train_labels
        c_weights = out_c.get("sample_weights")
    except Exception:
        c_images, c_labels, c_weights = train_images, train_labels, None
    model_def_clean = env.train(c_images, c_labels, c_weights)
    acc_def_clean = _accuracy(model_def_clean, test_images, test_labels)

    recovery = (acc_def - acc_attack) / max(acc_clean - acc_attack, 1e-6) if acc_clean > acc_attack else 1.0
    recovery = float(np.clip(recovery, 0, 1))
    defense_score = 0.5 * recovery + 0.5 * (acc_def_clean / max(acc_clean, 1e-6))
    if defense_score >= 0.85:
        score = 100
    elif defense_score >= 0.70:
        score = 85
    elif defense_score >= 0.50:
        score = 70
    else:
        score = 0
    win = defense_score >= 0.50
    return {
        "id": match_id, "status": "passed", "score": score,
        "result": {
            "message": f"Acc_clean={acc_clean*100:.1f}%，Acc_attack={acc_attack*100:.1f}%，"
                       f"Acc_defense={acc_def*100:.1f}%，Recovery={recovery*100:.0f}%，"
                       f"CleanAcc={acc_def_clean*100:.1f}%，DefenseScore={defense_score:.2f}。"
                       + ("防御成功，恢复模型准确率。" if win else "防御未有效恢复。"),
            "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                        "queries_used": 0, "fbr": 1 - recovery, "interaction_log": [],
                        "attack_rate": recovery, "avg_fidelity": acc_def_clean, "valid_rate": acc_def},
        },
    }


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
