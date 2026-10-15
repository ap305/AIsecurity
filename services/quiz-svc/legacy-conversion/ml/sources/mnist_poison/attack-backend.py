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


# [IMPORTANT] Replace this line with real attack/defense code.

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
