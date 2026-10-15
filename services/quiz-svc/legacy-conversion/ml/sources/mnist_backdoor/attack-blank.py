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
    pass
