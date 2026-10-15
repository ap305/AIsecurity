#!/usr/bin/env python
"""防御代码 —— Baseline：数据增强（Data Augmentation）。

原理：对可能被投毒的训练集做鲁棒训练类防御。为每个样本生成 1 份随机平移
      副本（水平/垂直方向 ±2 像素，np.roll 实现），将训练集扩充为 2 倍
      规模后统一训练。通过引入平移不变性先验、扩大有效样本量，提升模型
      泛化能力、降低对个别投毒样本的敏感度，从而恢复模型在干净测试集上
      的性能。实现简单、模型无关，对 MLP/CNN 均有效。

接口：
    defend(images, labels, seed=42, max_shift=2, copies=1)
        -> {"images": [2N,1,28,28], "labels": [2N]}

用法：
    python defense.py                  # 读取投毒数据，输出 data/defended.npz
"""

from __future__ import annotations

import argparse
import os

import numpy as np

from dataset import load_npz, save_npz


def defend(
    images: np.ndarray,
    labels: np.ndarray,
    seed: int = 42,
    max_shift: int = 2,
    copies: int = 1,
) -> dict:
    """数据增强防御：每个样本附加 copies 份随机平移副本。

    参数
    ----
    images    : [N, 1, 28, 28] float32 可能被投毒的训练图像
    labels    : [N] int64 可能被投毒的训练标签
    seed      : 随机种子（默认 42）
    max_shift : 随机平移的最大像素数（默认 ±2）
    copies    : 每个样本生成的副本数（默认 1，即训练集扩充为 2 倍）

    返回
    ----
    {"images": 扩充后的图像, "labels": 对应的标签}
    """
    images = np.asarray(images, dtype=np.float32)
    labels = np.asarray(labels, dtype=np.int64)

    rng = np.random.default_rng(seed)
    n = images.shape[0]

    new_imgs = [images]
    new_lbls = [labels]
    for _ in range(copies):
        aug = images.copy()
        sh = rng.integers(-max_shift, max_shift + 1, size=(n, 2))
        for i in range(n):
            dy, dx = int(sh[i, 0]), int(sh[i, 1])
            aug[i] = np.roll(aug[i], shift=(dy, dx), axis=(1, 2))
        new_imgs.append(aug)
        new_lbls.append(labels.copy())

    out_images = np.concatenate(new_imgs, axis=0).astype(np.float32)
    out_labels = np.concatenate(new_lbls, axis=0).astype(np.int64)
    return {"images": out_images, "labels": out_labels, "n_augmented": n * copies}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="数据增强防御（Baseline）")
    parser.add_argument("--input", default="data/poisoned.npz", help="输入投毒数据")
    parser.add_argument("--output", default="data/defended.npz", help="输出路径")
    parser.add_argument("--max-shift", type=int, default=2, help="随机平移最大像素数")
    parser.add_argument("--copies", type=int, default=1, help="每样本副本数")
    parser.add_argument("--seed", type=int, default=42, help="随机种子")
    args = parser.parse_args()

    poisoned = load_npz(args.input)
    out = defend(poisoned["images"], poisoned["labels"],
                 seed=args.seed, max_shift=args.max_shift, copies=args.copies)
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    save_npz(args.output, out["images"], out["labels"])
    print(f"[defense] 数据增强完成：{len(poisoned['labels'])} -> {len(out['labels'])} 个样本")
