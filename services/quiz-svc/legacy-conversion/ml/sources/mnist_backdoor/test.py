#!/usr/bin/env python
"""测试代码 —— 手写数字局部触发器后门基准（Benchmark）指标计算。

评测流程（与基准文档一致）：
    干净训练集 --训练--> 干净模型 --> Acc_clean / ASR_clean
    干净训练集 --攻击--> 投毒训练集 --训练--> 投毒模型 --> Acc_attack / ASR_attack
    投毒训练集 --防御--> 清洗训练集 --训练--> 防御模型 --> Acc_defense / ASR_defense

指标公式（Acc 为干净测试集上的分类准确率，ASR 为触发测试集上预测==目标标签的比例）：
    Accuracy            = 正确预测数 / 样本总数
    PoisonRate          = N_poison / N_train                      （≤ 5%）
    ASR                 = 预测==目标标签的样本数 / 触发测试集大小
    BackdoorGain        = max(0, (ASR_attack-ASR_clean)/(1-ASR_clean))
    CleanRetention_atk  = min(1, Acc_attack/Acc_clean)
    AttackScore         = BackdoorGain × CleanRetention_atk
    BackdoorRemoval     = clip((ASR_attack-ASR_defense)/(ASR_attack-ASR_clean), 0, 1)
    CleanRetention_def  = min(1, Acc_defense/Acc_clean)
    DefenseScore        = 0.7 × BackdoorRemoval + 0.3 × CleanRetention_def

用法：
    python test.py --stage attack      # 攻击方 Baseline 评测（默认）
    python test.py --stage defense     # 防守方 Baseline 评测
    python test.py --stage all         # 完整攻防评测
"""

from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np

from attack import attack
from dataset import load_benchmark
from defense import defend

# --------------------------------------------------------------------------- #
# 统一分类模型（基准训练协议：MLP，隐层 [256,128]，Adam，与文档一致）
# --------------------------------------------------------------------------- #
def train_model(images: np.ndarray, labels: np.ndarray, seed: int = 42):
    """在给定数据上训练统一分类模型，返回具有 predict 接口的对象。"""
    from sklearn.neural_network import MLPClassifier

    X = np.asarray(images, dtype=np.float32).reshape(len(images), -1)
    y = np.asarray(labels, dtype=np.int64)
    est = MLPClassifier(
        hidden_layer_sizes=(256, 128),
        activation="relu",
        solver="adam",
        alpha=1e-4,
        batch_size=128,
        learning_rate_init=1e-3,
        max_iter=40,
        early_stopping=True,
        validation_fraction=0.1,
        n_iter_no_change=5,
        random_state=seed,
    )
    est.fit(X, y)
    return est


def accuracy(model, images: np.ndarray, labels: np.ndarray) -> float:
    """Accuracy = 正确预测数 / 样本总数。"""
    pred = model.predict(np.asarray(images, dtype=np.float32).reshape(len(images), -1))
    labels = np.asarray(labels)
    return float(np.mean(np.asarray(pred) == labels))


def asr(model, images: np.ndarray, target_label: int) -> float:
    """后门攻击成功率：触发测试集上 预测==目标标签 的比例。"""
    pred = model.predict(np.asarray(images, dtype=np.float32).reshape(len(images), -1))
    if len(pred) == 0:
        return 0.0
    return float(np.mean(np.asarray(pred) == int(target_label)))


# --------------------------------------------------------------------------- #
# 触发器应用与触发测试集（与基准文档一致：x' = (1-M)⊙x + M⊙P）
# --------------------------------------------------------------------------- #
def apply_trigger(images: np.ndarray, mask: np.ndarray, pattern: np.ndarray) -> np.ndarray:
    """对图像批量应用触发器。"""
    x = np.asarray(images, dtype=np.float32)
    m = np.asarray(mask, dtype=np.float32)
    p = np.asarray(pattern, dtype=np.float32)
    if m.ndim == 2:
        m = m[None, :, :]
    if p.ndim == 2:
        p = p[None, :, :]
    m = m[None, ...]  # [1,1,H,W]
    p = p[None, ...]
    return np.clip(x * (1.0 - m) + p * m, 0.0, 1.0).astype(np.float32)


def build_triggered_test(
    images: np.ndarray, labels: np.ndarray,
    mask: np.ndarray, pattern: np.ndarray, target_label: int,
):
    """从隐藏测试集中选择所有 y ≠ target_label 的样本并应用触发器。"""
    labels = np.asarray(labels).astype(np.int64)
    sel = np.where(labels != int(target_label))[0]
    if len(sel) == 0:
        return np.zeros((0, 1, 28, 28), dtype=np.float32), np.zeros((0,), dtype=np.int64)
    triggered = apply_trigger(images[sel], mask, pattern)
    return triggered, labels[sel]


# --------------------------------------------------------------------------- #
# 指标计算（严格对齐基准文档公式）
# --------------------------------------------------------------------------- #
def backdoor_gain(asr_attack: float, asr_clean: float) -> float:
    """归一化后门增益：max(0, (ASR_attack-ASR_clean)/(1-ASR_clean))，截断到 [0,1]。"""
    denom = 1.0 - asr_clean
    if denom <= 1e-8:
        return 0.0
    return float(max(0.0, min(1.0, (asr_attack - asr_clean) / denom)))


def clean_retention(acc_model: float, acc_clean: float) -> float:
    """干净性能保持率：min(1, Acc_model/Acc_clean)。"""
    if acc_clean <= 1e-8:
        return 0.0
    return float(max(0.0, min(1.0, acc_model / acc_clean)))


def attack_score(bg: float, retention_attack: float) -> float:
    """攻击方单轮得分：BackdoorGain × CleanRetention_attack。"""
    return float(bg * retention_attack)


def backdoor_removal(asr_attack: float, asr_defense: float, asr_clean: float,
                     eps: float = 1e-3):
    """后门消除率：clip((ASR_attack-ASR_defense)/(ASR_attack-ASR_clean), 0, 1)。

    攻击未产生明显后门效果（|ASR_attack-ASR_clean| ≤ eps）时返回 (0.0, True)，
    该对阵不参与防御评分，避免分母接近 0。
    """
    denom = asr_attack - asr_clean
    if denom <= eps:
        return 0.0, True
    return float(max(0.0, min(1.0, (asr_attack - asr_defense) / denom))), False


def defense_score(removal: float, retention_defense: float) -> float:
    """防御方单轮得分：0.7 × BackdoorRemoval + 0.3 × CleanRetention_defense。"""
    return float(0.7 * removal + 0.3 * retention_defense)


def attack_qualified(asr_attack: float, acc_clean: float, acc_attack: float,
                     asr_thresh: float = 0.60, acc_drop_thresh: float = 0.03):
    """攻击资格线：ASR_attack ≥ 60% 且 Acc_clean - Acc_attack ≤ 3 个百分点。"""
    acc_drop = acc_clean - acc_attack
    return bool(asr_attack >= asr_thresh and acc_drop <= acc_drop_thresh), float(acc_drop)


def defense_success(asr_defense: float, acc_clean: float, acc_defense: float,
                    asr_thresh: float = 0.20, acc_drop_thresh: float = 0.03):
    """防御成功参考线：ASR_defense ≤ 20% 且 Acc_clean - Acc_defense ≤ 3 个百分点。"""
    acc_drop = acc_clean - acc_defense
    return bool(asr_defense <= asr_thresh and acc_drop <= acc_drop_thresh), float(acc_drop)


# --------------------------------------------------------------------------- #
# 评测入口
# --------------------------------------------------------------------------- #
def evaluate(
    stage: str = "attack",
    train_size: int = 8000,
    test_size: int = 2000,
    poison_rate: float = 0.05,
    target_label: int = 0,
    seed: int = 42,
    output_dir: str = "results",
):
    train, test = load_benchmark(train_size=train_size, test_size=test_size, seed=seed)
    n_train = len(train["labels"])
    budget = max(1, int(poison_rate * n_train))

    # 1) 攻击：注入右下角 2×2 全白触发器并生成触发测试集
    t0 = time.time()
    poisoned = attack(train["images"], train["labels"],
                      target_label=target_label, poison_rate=poison_rate, seed=seed)
    trig_img, trig_lab = build_triggered_test(
        test["images"], test["labels"],
        poisoned["trigger_mask"], poisoned["trigger_pattern"], target_label,
    )
    print(f"[评测] 攻击完成：投毒 {poisoned['n_modified']} 个样本，"
          f"触发测试集 {len(trig_lab)} 个样本（{time.time()-t0:.1f}s）")

    # 2) 干净基线：干净训练集 -> 模型 -> Acc_clean / ASR_clean
    t0 = time.time()
    model_clean = train_model(train["images"], train["labels"], seed=seed)
    acc_clean = accuracy(model_clean, test["images"], test["labels"])
    asr_clean = asr(model_clean, trig_img, target_label)
    print(f"[评测] 干净训练: Acc_clean = {acc_clean:.4f}, ASR_clean = {asr_clean:.4f} "
          f"({time.time()-t0:.1f}s)")

    # 3) 攻击模型：投毒训练集 -> 模型 -> Acc_attack / ASR_attack
    t0 = time.time()
    model_atk = train_model(poisoned["images"], poisoned["labels"], seed=seed)
    acc_attack = accuracy(model_atk, test["images"], test["labels"])
    asr_attack = asr(model_atk, trig_img, target_label)
    print(f"[评测] 投毒训练: Acc_attack = {acc_attack:.4f}, ASR_attack = {asr_attack:.4f} "
          f"({time.time()-t0:.1f}s)")

    bg = backdoor_gain(asr_attack, asr_clean)
    ret_a = clean_retention(acc_attack, acc_clean)
    atk_score = attack_score(bg, ret_a)
    aq, atk_drop = attack_qualified(asr_attack, acc_clean, acc_attack)

    result = {
        "benchmark": "手写数字局部触发器后门",
        "stage": stage,
        "train_size": n_train,
        "test_size": len(test["labels"]),
        "seed": seed,
        "target_label": target_label,
        "poison_rate_limit": poison_rate,
        "poison_budget": budget,
        "n_poison": int(poisoned["n_modified"]),
        "actual_poison_rate": poisoned["n_modified"] / n_train,
        "n_triggered_test": len(trig_lab),
        "acc_clean": acc_clean,
        "acc_attack": acc_attack,
        "asr_clean": asr_clean,
        "asr_attack": asr_attack,
        "backdoor_gain": bg,
        "clean_retention_attack": ret_a,
        "attack_score": atk_score,
        "attack_qualified": aq,
        "attack_acc_drop": atk_drop,
        "attack_qualify_asr_thresh": 0.60,
        "attack_qualify_acc_drop_thresh": 0.03,
    }

    # 4) 防御：3×3 中值滤波 -> 清洗训练集 -> 模型 -> Acc_defense / ASR_defense
    if stage in ("defense", "all"):
        t0 = time.time()
        cleaned = defend(poisoned["images"], poisoned["labels"])
        model_def = train_model(cleaned["images"], cleaned["labels"], seed=seed)
        acc_defense = accuracy(model_def, test["images"], test["labels"])
        asr_defense = asr(model_def, trig_img, target_label)
        print(f"[评测] 防御训练: Acc_defense = {acc_defense:.4f}, "
              f"ASR_defense = {asr_defense:.4f} ({time.time()-t0:.1f}s)")

        removal, skipped = backdoor_removal(asr_attack, asr_defense, asr_clean)
        ret_d = clean_retention(acc_defense, acc_clean)
        dsc = 0.0 if skipped else defense_score(removal, ret_d)
        ds, def_drop = defense_success(asr_defense, acc_clean, acc_defense)

        result.update({
            "acc_defense": acc_defense,
            "asr_defense": asr_defense,
            "backdoor_removal": removal,
            "clean_retention_defense": ret_d,
            "defense_score": dsc,
            "defense_score_skipped": skipped,
            "defense_success": ds,
            "defense_acc_drop": def_drop,
            "defense_success_asr_thresh": 0.20,
            "defense_success_acc_drop_thresh": 0.03,
        })

    return result


def print_report(result: dict):
    print("\n" + "=" * 66)
    print(f"基准: 手写数字局部触发器后门  |  阶段: {result['stage']}  "
          f"(target={result['target_label']}, seed={result['seed']})")
    print("=" * 66)
    print(f"训练集规模        : {result['train_size']}   测试集规模: {result['test_size']}")
    print(f"投毒预算          : {result['poison_budget']}  (PoisonRate ≤ {result['poison_rate_limit']})")
    print(f"实际投毒样本数    : {result['n_poison']}  -> PoisonRate = {result['actual_poison_rate']:.4f}")
    print(f"触发测试集大小    : {result['n_triggered_test']}")
    print("-" * 66)
    print(f"Acc_clean / Acc_attack     = {result['acc_clean']:.4f} / {result['acc_attack']:.4f}")
    print(f"ASR_clean / ASR_attack     = {result['asr_clean']:.4f} / {result['asr_attack']:.4f}")
    print(f"BackdoorGain               = max(0,(ASR_atk-ASR_clean)/(1-ASR_clean)) = {result['backdoor_gain']:.4f}")
    print(f"CleanRetention_attack      = min(1,Acc_atk/Acc_clean) = {result['clean_retention_attack']:.4f}")
    print(f"AttackScore                = BackdoorGain × CleanRetention_atk = {result['attack_score']:.4f}")
    print(f"攻击资格线 (ASR≥60% 且 Acc降≤3pp): qualified = {result['attack_qualified']} "
          f"(acc_drop={result['attack_acc_drop']:.4f})")
    if "acc_defense" in result:
        print("-" * 66)
        print(f"Acc_clean / Acc_defense    = {result['acc_clean']:.4f} / {result['acc_defense']:.4f}")
        print(f"ASR_attack / ASR_defense   = {result['asr_attack']:.4f} / {result['asr_defense']:.4f}")
        skip = " (跳过: 攻击无明显后门效果)" if result['defense_score_skipped'] else ""
        print(f"BackdoorRemoval            = clip((ASR_atk-ASR_def)/(ASR_atk-ASR_clean),0,1) = {result['backdoor_removal']:.4f}")
        print(f"CleanRetention_defense     = min(1,Acc_def/Acc_clean) = {result['clean_retention_defense']:.4f}")
        print(f"DefenseScore               = 0.7×Removal + 0.3×Retention_def = {result['defense_score']:.4f}{skip}")
        print(f"防御参考线 (ASR≤20% 且 Acc降≤3pp): success = {result['defense_success']} "
              f"(acc_drop={result['defense_acc_drop']:.4f})")
    print("=" * 66)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="手写数字局部触发器后门基准：Baseline 指标计算",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--stage", choices=["attack", "defense", "all"],
                        default="attack", help="评测阶段")
    parser.add_argument("--train-size", type=int, default=8000)
    parser.add_argument("--test-size", type=int, default=2000)
    parser.add_argument("--poison-rate", type=float, default=0.05)
    parser.add_argument("--target-label", type=int, default=0, help="后门目标标签")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--output", default="results/metrics.json")
    args = parser.parse_args()

    res = evaluate(stage=args.stage, train_size=args.train_size,
                   test_size=args.test_size, poison_rate=args.poison_rate,
                   target_label=args.target_label, seed=args.seed)
    print_report(res)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    print(f"\n[test] 指标已保存: {args.output}")
