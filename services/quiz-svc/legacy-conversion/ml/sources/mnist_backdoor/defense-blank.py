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
    pass
