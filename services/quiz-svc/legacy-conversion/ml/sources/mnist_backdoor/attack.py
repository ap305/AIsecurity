#!/usr/bin/env python
"""攻击代码 —— Baseline：右下角 2×2 全白触发器（Bottom Right White Trigger）。

原理（后门注入，BadNets 风格）：
    在投毒预算内（PoisonRate ≤ 5%），从训练集中选取若干标签 ≠ 目标标签的样本，
    在每个样本的右下角（与边界保留 1 像素间距）粘贴统一的 2×2 全白局部触发器，
    并把其标签改为目标标签 target_label。训练出的模型在干净测试集上保持较高
    准确率，而一旦输入图像出现该触发器，就会被预测为目标类别（后门）。

触发器规格（与基准文档一致）：
    trigger_mask:    [1, 28, 28] float32，仅右下角 2×2 区域为 1，其余为 0
    trigger_pattern: [1, 28, 28] float32，掩码区域内全部为 1.0（全白）

接口：
    attack(images, labels, target_label=0, poison_rate=0.05, seed=42)
        -> {"images", "labels", "trigger_mask", "trigger_pattern",
            "target_label", "poison_indices", "n_modified"}

用法：
    python attack.py                          # 读取基准训练集，输出 data/poisoned.npz
    python attack.py --target-label 0 --poison-rate 0.05 --seed 42
"""

from __future__ import annotations

import argparse
import os

import numpy as np

from dataset import load_benchmark, save_npz

NUM_CLASSES = 10


def attack(
    images: np.ndarray,
    labels: np.ndarray,
    target_label: int = 0,
    poison_rate: float = 0.05,
    seed: int = 42,
    trigger_size: int = 2,
) -> dict:
    """右下角 2×2 全白触发器后门攻击。

    参数
    ----
    images       : [N, 1, 28, 28] float32 干净训练图像（取值 [0,1]）
    labels       : [N] int64 干净训练标签（取值 {0,...,9}）
    target_label : 后门目标标签（默认 0，公开调试阶段约定）
    poison_rate  : 投毒预算比例（默认 0.05，即最多修改 5% 的样本）
    seed         : 随机种子（默认 42，保证可复现）
    trigger_size : 触发器边长（固定 2）

    返回
    ----
    {"images": 投毒图像, "labels": 投毒标签,
     "trigger_mask": [1,28,28], "trigger_pattern": [1,28,28],
     "target_label": 目标标签, "poison_indices": [n_poison], "n_modified": int}
    """
    images = np.asarray(images, dtype=np.float32).copy()
    labels = np.asarray(labels, dtype=np.int64).copy()
    target_label = int(target_label)

    n_train = len(labels)
    budget = max(1, int(poison_rate * n_train))  # 投毒预算 N_modified
    budget = min(budget, n_train)

    _, _, h, w = images.shape

    # 1) 构造触发器：右下角 2×2 全白，与图像边界保留 1 像素间距
    top, left = h - trigger_size - 1, w - trigger_size - 1
    mask = np.zeros((1, h, w), dtype=np.float32)
    pattern = np.zeros((1, h, w), dtype=np.float32)
    mask[0, top:top + trigger_size, left:left + trigger_size] = 1.0
    pattern[0, top:top + trigger_size, left:left + trigger_size] = 1.0

    # 2) 候选样本：标签 ≠ 目标标签 且 应用触发器后图像确实发生变化
    #    （若图像未变而标签被改，将违反“未被投毒样本标签不得修改”的约束）
    non_target = np.where(labels != target_label)[0]
    m = mask[None, ...]  # [1,1,H,W]
    applied = images[non_target] * (1.0 - m) + pattern[None, ...] * m
    would_change = np.any(applied != images[non_target], axis=(1, 2, 3))
    candidates = non_target[would_change]

    # 3) 用固定随机种子无放回抽取投毒样本（保证结果可复现）
    rng = np.random.default_rng(seed)
    n = min(budget, len(candidates))
    poison_idx = rng.choice(candidates, size=n, replace=False)

    # 4) 贴片 + 改标签：x' = (1-M)⊙x + M⊙P
    if n > 0:
        images[poison_idx] = images[poison_idx] * (1.0 - m) + pattern[None, ...] * m
        labels[poison_idx] = target_label

    return {
        "images": images,
        "labels": labels,
        "trigger_mask": mask,
        "trigger_pattern": pattern,
        "target_label": target_label,
        "poison_indices": poison_idx.astype(np.int64),
        "n_modified": n,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="右下角 2×2 全白触发器后门攻击（Baseline）")
    parser.add_argument("--target-label", type=int, default=0, help="后门目标标签，默认 0")
    parser.add_argument("--poison-rate", type=float, default=0.05,
                        help="投毒预算比例，默认 0.05")
    parser.add_argument("--seed", type=int, default=42, help="随机种子，默认 42")
    parser.add_argument("--output", default="data/poisoned.npz", help="输出路径")
    args = parser.parse_args()

    train, _ = load_benchmark()
    out = attack(train["images"], train["labels"],
                 target_label=args.target_label,
                 poison_rate=args.poison_rate, seed=args.seed)
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    save_npz(args.output, out["images"], out["labels"])
    print(f"[attack] 右下角 2×2 全白触发器投毒完成：修改 {out['n_modified']}/"
          f"{len(train['labels'])} 个样本（目标标签 {out['target_label']}）")
