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
    pass
