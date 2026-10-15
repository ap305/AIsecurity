#!/usr/bin/env python
"""攻击代码 —— Baseline：随机标签翻转（Random Label Flip）。

原理：在投毒预算内（PoisonRate ≤ 5%），从训练集中均匀随机选取
      N_modified = floor(PoisonRate * N_train) 个样本，把每个样本的标签
      随机翻转为与其原标签不同的任意一个类别。被翻转样本携带错误监督信号，
      使模型学习到混乱映射，导致干净测试集上的整体准确率下降。

接口：
    attack(images, labels, poison_rate=0.05, seed=42) -> {"images", "labels"}

用法：
    python attack.py                   # 读取基准训练集，输出 data/poisoned.npz
    python attack.py --poison-rate 0.05 --seed 42
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
    poison_rate: float = 0.05,
    seed: int = 42,
    num_classes: int = NUM_CLASSES,
) -> dict:
    """随机标签翻转攻击。

    参数
    ----
    images      : [N, 1, 28, 28] float32 干净训练图像
    labels      : [N] int64 干净训练标签（取值 {0,...,9}）
    poison_rate : 投毒预算比例（默认 0.05，即最多修改 5% 的样本）
    seed        : 随机种子（默认 42，保证可复现）

    返回
    ----
    {"images": 与原规模一致的投毒图像, "labels": 投毒标签}
    """
    images = np.asarray(images, dtype=np.float32).copy()
    labels = np.asarray(labels, dtype=np.int64).copy()

    n_train = len(labels)
    budget = max(1, int(poison_rate * n_train))  # 投毒预算 N_modified
    budget = min(budget, n_train)

    rng = np.random.default_rng(seed)
    idx = rng.choice(n_train, size=budget, replace=False)  # 无放回抽取

    for i in idx:
        old = int(labels[i])
        candidates = [c for c in range(num_classes) if c != old]
        labels[i] = rng.choice(candidates)

    return {"images": images, "labels": labels, "n_modified": budget}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="随机标签翻转攻击（Baseline）")
    parser.add_argument("--poison-rate", type=float, default=0.05,
                        help="投毒预算比例，默认 0.05")
    parser.add_argument("--seed", type=int, default=42, help="随机种子，默认 42")
    parser.add_argument("--output", default="data/poisoned.npz", help="输出路径")
    args = parser.parse_args()

    train, _ = load_benchmark()
    out = attack(train["images"], train["labels"],
                 poison_rate=args.poison_rate, seed=args.seed)
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    save_npz(args.output, out["images"], out["labels"])
    n_modified = int((out["labels"] != train["labels"]).sum())
    print(f"[attack] 随机标签翻转完成：修改 {n_modified}/{len(train['labels'])} "
          f"个样本（预算 {out['n_modified']}）")
