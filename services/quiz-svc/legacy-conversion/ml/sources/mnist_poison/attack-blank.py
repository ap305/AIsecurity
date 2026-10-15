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
    pass
