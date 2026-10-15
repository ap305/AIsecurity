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


# [IMPORTANT] Replace this line with real attack/defense code.

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
