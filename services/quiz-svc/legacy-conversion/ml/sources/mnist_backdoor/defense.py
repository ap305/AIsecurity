#!/usr/bin/env python
"""防御代码 —— Baseline：3×3 中值滤波（Median Filter Defense）。

原理（输入预处理类防御）：
    对可能被投毒的训练集逐样本做 3×3 中值滤波。2×2 局部触发器仅占据 4 个像素，
    中值滤波用 3×3 邻域的中值替换中心像素，单个像素/小块异常（如角落的全白
    小方块）会被邻域中的多数像素“摊平”而显著削弱，同时不改变标签、不删除样本，
    满足防御约束 N_sanitized ≥ 0.9 N_train。该方法不需要知道触发器位置、图案或
    目标标签，是赛题材料提供的最小防御方示例，适合作为入门基线。

接口：
    defend(images, labels, kernel_size=3)
        -> {"images": 滤波后图像, "labels": 原标签, "sample_weights": None}

用法：
    python defense.py                 # 读取投毒数据，输出 data/defended.npz
"""

from __future__ import annotations

import argparse
import os

import numpy as np

from dataset import load_npz, save_npz


def median_filter_3x3(images: np.ndarray) -> np.ndarray:
    """对 [N, C, H, W] 图像批量做 3×3 中值滤波（零填充，纯 numpy 实现）。"""
    n, c, h, w = images.shape
    padded = np.pad(images, ((0, 0), (0, 0), (1, 1), (1, 1)),
                    mode="constant", constant_values=0)
    shifted = []
    for dy in range(3):
        for dx in range(3):
            shifted.append(padded[:, :, dy:dy + h, dx:dx + w])
    stacked = np.stack(shifted, axis=0)  # [9, N, C, H, W]
    return np.median(stacked, axis=0).astype(images.dtype)


def defend(
    images: np.ndarray,
    labels: np.ndarray,
    kernel_size: int = 3,
) -> dict:
    """3×3 中值滤波防御。

    参数
    ----
    images      : [N, 1, 28, 28] float32 可能被投毒的训练图像
    labels      : [N] int64 可能被投毒的训练标签
    kernel_size : 滤波核大小（默认 3，仅支持奇数）

    返回
    ----
    {"images": 滤波后的图像, "labels": 原标签, "sample_weights": None}
    """
    images = np.asarray(images, dtype=np.float32)
    labels = np.asarray(labels, dtype=np.int64)
    if kernel_size % 2 == 0:
        raise ValueError(f"kernel_size 必须为奇数，实际 {kernel_size}")
    if kernel_size != 3:
        raise NotImplementedError("本基线仅实现 3×3 中值滤波")

    filtered = median_filter_3x3(images)
    return {"images": filtered, "labels": labels.copy(), "sample_weights": None}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="3×3 中值滤波防御（Baseline）")
    parser.add_argument("--input", default="data/poisoned.npz", help="输入投毒数据")
    parser.add_argument("--output", default="data/defended.npz", help="输出路径")
    args = parser.parse_args()

    poisoned = load_npz(args.input)
    out = defend(poisoned["images"], poisoned["labels"])
    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    save_npz(args.output, out["images"], out["labels"])
    print(f"[defense] 3×3 中值滤波完成：{len(poisoned['labels'])} -> {len(out['labels'])} 个样本")
