#!/usr/bin/env python3
"""MNIST 黑盒模型蒸馏攻防仿真引擎（确定性，numpy，不真训练）。

scenario: mnist_distill

题目内涵（黑盒模型蒸馏/模型窃取）：
- 裁判构造随机标签置换 π 的手写数字分类任务，训练 Victim 模型。
- 攻击方只能有限次数黑盒查询 env.query(images) 获得预测标签与概率，
  训练统一 Student 模型尽可能复现 Victim 行为。
- 防御方在 API 输出端扰动标签/概率（LabelErrorRate ≤ 10%），
  降低攻击方蒸馏效果，同时不显著破坏正常服务。

契约：
- 攻击  def attack(env, task) -> dict
    env.query(images) -> {"labels","probabilities"}   # 黑盒查询（≤ query_budget）
    env.create_student_model() -> 统一学生模型
    返回 {"student_state_dict": ...}
- 防御  def defend(query) -> dict
    query = {"images","raw_labels","raw_probabilities","query_count","query_budget"}
    返回 {"labels","probabilities"}  # 扰动后输出（LabelErrorRate ≤ 10%）

仿真：
- 伪 MNIST：28×28，类别 c 在行 c*2 有亮块。
- Victim 与学生模型均为最近质心分类器（标签置换后训练）。
- 评分：攻击 = 学生与 Victim 在隐藏测试集预测一致率（Agreement）；
  防御 = 扰动后攻击方 Agreement 下降，同时 LabelErrorRate ≤ 10%。
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
N_POOL = 240        # 公开查询池（无标签）
N_HIDDEN = 120      # 隐藏测试集
QUERY_BUDGET = 160  # 查询预算
LABEL_ERROR_LIMIT = 0.10


def _make_images(seed: int, n: int) -> np.ndarray:
    """伪 MNIST：类别 c 在行 c*2 有亮块（规则可分）。"""
    rng = np.random.default_rng(seed)
    labels = rng.integers(0, N_CLASSES, size=n)
    images = np.zeros((n, 1, IMG, IMG), dtype=np.float32)
    for i, c in enumerate(labels):
        r = int(c) * 2 % IMG
        images[i, 0, r, :8] = 0.9
        images[i, 0, r + 1, :8] = 0.7
    images += rng.standard_normal(images.shape).astype(np.float32) * 0.08
    return np.clip(images, 0, 1)


class _Centroid:
    """最近质心分类器（Victim 与 Student 共用）。"""

    def __init__(self, dim: int = IMG * IMG):
        self.centroids = np.zeros((N_CLASSES, dim), dtype=np.float64)

    def fit(self, images, labels):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        y = np.asarray(labels)
        for c in range(N_CLASSES):
            m = y == c
            if m.sum() > 0:
                self.centroids[c] = X[m].mean(0)
        return self

    def predict(self, images):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        d = ((X[:, None, :] - self.centroids[None, :, :]) ** 2).sum(-1)
        return np.argmin(d, axis=1)

    def predict_proba(self, images):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        d = ((X[:, None, :] - self.centroids[None, :, :]) ** 2).sum(-1)
        inv = 1.0 / (d + 1e-6)
        return inv / inv.sum(-1, keepdims=True)

    def state_dict(self):
        return {"centroids": self.centroids.copy()}

    def load_state_dict(self, sd):
        self.centroids = np.asarray(sd["centroids"], dtype=np.float64).copy()


class _StudentKNN:
    """统一学生模型：1-NN 记忆查询样本（对防御标签扰动敏感，符合蒸馏行为复制本质）。"""

    def __init__(self, k: int = 1):
        self.X = None
        self.y = None
        self.k = k

    def fit(self, images, labels):
        self.X = images.reshape(images.shape[0], -1).astype(np.float64)
        self.y = np.asarray(labels)
        return self

    def predict(self, images):
        X = images.reshape(images.shape[0], -1).astype(np.float64)
        d = ((X[:, None, :] - self.X[None, :, :]) ** 2).sum(-1)
        idx = np.argsort(d, axis=1)[:, : self.k]
        return np.array([np.bincount(self.y[i], minlength=N_CLASSES).argmax() for i in idx])

    def state_dict(self):
        return {"X": self.X, "y": self.y, "k": self.k}

    def load_state_dict(self, sd):
        self.X = np.asarray(sd["X"], dtype=np.float64).copy()
        self.y = np.asarray(sd["y"]).copy()
        self.k = int(sd.get("k", 1))


class _VictimEnv:
    """攻击方可用的黑盒环境：query 返回 Victim 预测标签与概率。"""

    def __init__(self, victim: _Centroid, permutation: np.ndarray, defend_fn=None):
        self._victim = victim
        self._perm = permutation            # 原始标签 -> 置换标签
        self._defend_fn = defend_fn or (lambda q: {"labels": q["raw_labels"], "probabilities": q["raw_probabilities"]})
        self.query_count = 0
        self.budget = QUERY_BUDGET

    def create_student_model(self):
        return _StudentKNN()

    def query(self, images):
        self.query_count += len(images)
        # Victim 预测（内部在置换标签空间；对外暴露置换后的标签）
        raw_labels = self._victim.predict(images)
        raw_probabilities = self._victim.predict_proba(images)
        out = self._defend_fn({
            "images": images,
            "raw_labels": raw_labels,
            "raw_probabilities": raw_probabilities,
            "query_count": self.query_count,
            "query_budget": self.budget,
        })
        return {
            "labels": np.asarray(out["labels"]),
            "probabilities": np.asarray(out["probabilities"]),
        }


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


def _build_world(seed: int = 42):
    """构造 Victim（标签置换）与数据集。"""
    rng = np.random.default_rng(seed)
    perm = np.array(rng.permutation(N_CLASSES), dtype=np.int64)  # 原始 -> 置换
    # Victim 训练集：伪标签 -> 置换标签
    tr_images = _make_images(seed, 200)
    tr_labels = np.arange(200) % N_CLASSES
    perm_labels = perm[tr_labels]
    victim = _Centroid().fit(tr_images, perm_labels)
    # 隐藏测试集（原标签已知，裁判用它算 Agreement）
    hidden = _make_images(seed + 1000, N_HIDDEN)
    hidden_true = np.arange(N_HIDDEN) % N_CLASSES
    # 公开查询池（无标签）
    pool = _make_images(seed + 2000, N_POOL)
    return victim, perm, hidden, hidden_true, pool


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    victim, perm, hidden, hidden_true, pool = _build_world()

    if role == "solo_attack":
        # 无防御 Victim API（干净查询）
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(env, task) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")
        env = _VictimEnv(victim, perm)
        task = {
            "query_images": pool,
            "query_budget": QUERY_BUDGET,
            "num_classes": N_CLASSES,
            "image_shape": (1, IMG, IMG),
        }
        try:
            result = attack_fn(env, task)
            sd = (result or {}).get("student_state_dict") if isinstance(result, dict) else None
            if sd is None:
                return _err(match_id, "attack 未返回 student_state_dict")
        except Exception as e:
            return _err(match_id, f"attack 执行错误: {e}")
        if env.query_count > QUERY_BUDGET:
            return _err(match_id, f"查询超预算：{env.query_count} > {QUERY_BUDGET}")

        student = _StudentKNN()
        try:
            student.load_state_dict(sd)
        except Exception as e:
            return _err(match_id, f"student_state_dict 无法加载到统一模型: {e}")
        # 一致性：学生预测 vs Victim 预测（隐藏集）
        stu_pred = student.predict(hidden)
        vic_pred = victim.predict(hidden)
        agreement = float(np.mean(stu_pred == vic_pred))
        # 学生自身的「复现正确率」：学生预测 vs 置换真值（辅助）
        repro = float(np.mean(stu_pred == perm[hidden_true]))
        if agreement >= 0.85:
            score = 100
        elif agreement >= 0.70:
            score = 85
        elif agreement >= 0.50:
            score = 70
        elif agreement >= 0.30:
            score = 60
        else:
            score = 0
        win = agreement >= 0.50
        return {
            "id": match_id, "status": "passed", "score": score,
            "result": {
                "message": f"行为一致性 Agreement={agreement*100:.1f}%（学生 vs Victim），"
                           f"复现正确率 {repro*100:.1f}%，查询 {env.query_count}/{QUERY_BUDGET}。"
                           + ("攻击成功：学生模型有效复制了 Victim 行为。" if win else "蒸馏效果不足。"),
                "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                            "queries_used": env.query_count, "fbr": 0, "interaction_log": [],
                            "attack_rate": agreement, "avg_fidelity": repro, "valid_rate": env.query_count / QUERY_BUDGET},
            },
        }

    # solo_defense：用户防御 vs 参考攻击（查询训练学生模型）
    try:
        defend_fn = _exec_user(defense_code, "defend", work_dir)
        if not defend_fn:
            return _err(match_id, "defend 代码缺少 defend(query) 函数")
    except Exception as e:
        return _err(match_id, f"defend 脚本加载失败: {e}")

    # 参考攻击：随机选 budget 张查询 -> 训练学生模型
    def ref_attack(env):
        idx = np.random.default_rng(7).choice(N_POOL, size=QUERY_BUDGET, replace=False)
        imgs = pool[idx]
        res = env.query(imgs)
        labels = np.asarray(res["labels"])
        student = env.create_student_model()
        student.fit(imgs, labels)
        return student

    # 1) 防御下攻击方 Agreement（防御成功 = 降低）
    def_env = _VictimEnv(victim, perm, defend_fn=defend_fn)
    student_def = ref_attack(def_env)
    def_agreement = float(np.mean(student_def.predict(hidden) == victim.predict(hidden)))

    # 2) LabelErrorRate：防御输出相对 Victim 原始标签的错误率（服务质量约束）
    probe = pool[:60]
    raw = victim.predict(probe)
    defended = defend_fn({
        "images": probe, "raw_labels": raw,
        "raw_probabilities": victim.predict_proba(probe),
        "query_count": 60, "query_budget": QUERY_BUDGET,
    })
    d_labels = np.asarray(defended["labels"])
    label_error = float(np.mean(d_labels != raw))

    # 3) 无防御基线 Agreement（对照）
    clean_env = _VictimEnv(victim, perm)
    student_clean = ref_attack(clean_env)
    clean_agreement = float(np.mean(student_clean.predict(hidden) == victim.predict(hidden)))

    # 评分：Agreement 降幅越大越好；LabelErrorRate ≤ 10% 为硬约束（服务质量）
    drop = max(0.0, clean_agreement - def_agreement)
    quality_ok = label_error <= LABEL_ERROR_LIMIT
    if not quality_ok:
        score = 0
        win = False
        msg = (f"防御无效：LabelErrorRate={label_error*100:.1f}% 超过 10% 约束，"
               f"显著破坏了 API 服务质量。Agreement 降幅 {drop*100:.1f}%。")
    else:
        if drop >= 0.20:
            score = 100
        elif drop >= 0.10:
            score = 85
        elif drop >= 0.05:
            score = 70
        elif drop > 0:
            score = 60
        else:
            score = 50
        win = drop >= 0.05
        msg = (f"防御后 Agreement={def_agreement*100:.1f}%（基线 {clean_agreement*100:.1f}%，"
               f"降幅 {drop*100:.1f}%），LabelErrorRate={label_error*100:.1f}% ≤ 10%。"
               + ("防御成功：有效降低蒸馏复制效果且保持服务质量。" if win else "防御效果不足。"))
    return {
        "id": match_id, "status": "passed", "score": score,
        "result": {
            "message": msg,
            "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                        "queries_used": QUERY_BUDGET, "fbr": label_error, "interaction_log": [],
                        "attack_rate": def_agreement, "avg_fidelity": clean_agreement, "valid_rate": 1 - label_error},
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
