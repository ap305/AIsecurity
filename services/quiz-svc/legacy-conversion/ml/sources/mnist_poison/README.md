# 手写数字分类数据投毒 —— 代码说明（README）

MNIST 手写数字分类上的**数据投毒攻防**基准：攻击方在 5% 投毒预算内篡改训练集标签使分类性能下降，防御方在不知情的情况下清洗/鲁棒训练以恢复性能。统一评测模型为 MLP(256,128)，CPU 秒级~数十秒跑通。

## 文件职责

| 文件 | 职责 |
|---|---|
| `dataset.py` | 加载 MNIST 基准数据（OpenML id=554，内置 `data/openml` 离线缓存）与固定划分（训练 8000 / 测试 2000，seed 42）；无缓存且无网时自动回退到离线合成数据 |
| `attack.py` | 攻击 Baseline：随机标签翻转（RandomLabelFlip），`attack(images, labels, poison_rate=0.05, seed=42) -> {"images","labels"}` |
| `defense.py` | 防御 Baseline：数据增强（DataAugmentation），`defend(images, labels, seed=42, max_shift=2, copies=1)`，每样本生成 1 份 ±2 像素随机平移副本，训练集扩为 2 倍 |
| `test.py` | 评测入口：训练统一 MLP → 计算 Accuracy/PoisonRate/UntargetedASR/AttackSuccess/RecoveryRate/EffectiveASR；`--stage attack\|defense\|all`，输出 `results/metrics.json` |
| `run_attack.sh` / `run_defense.sh` | 终端脚本（`python test.py --stage attack` / `--stage defense` 的包装） |
| `requirements.txt` | 最小依赖：numpy、scikit-learn |

## 运行

```bash
pip install -r requirements.txt
bash run_attack.sh      # 攻击方 Baseline 评测（或 python test.py --stage attack）
bash run_defense.sh     # 防守方 Baseline 评测（或 python test.py --stage defense）
```

Windows 无 bash 时直接运行等效 python 命令即可。

## 指标（与基准文档一致）

$$Accuracy = \frac{\#correct}{N_{test}},\quad
PoisonRate = \frac{N_{modified}}{N_{train}},\quad
UntargetedASR = \max\left(0,\ \frac{Acc_{clean} - Acc_{attack}}{Acc_{clean}}\right)$$

$$RecoveryRate = clip\left(\frac{Acc_{defense} - Acc_{attack}}{Acc_{clean} - Acc_{attack}},\ 0,\ 1\right),\quad
EffectiveASR = \max\left(0,\ \frac{Acc_{clean} - Acc_{defense}}{Acc_{clean}}\right)$$

攻击成功判定：$Acc_{attack} < Acc_{clean} - \Delta$（$\Delta = 0.05$，即 5 个百分点）。

## 参考实测结果（默认参数：PoisonRate=5%、seed=42）

- 干净训练：$Acc_{clean}=0.9405$；
- 随机标签翻转投毒后：$Acc_{attack}=0.9290$，$UntargetedASR=0.0122$，未达 $\Delta=5$pp 判定线（5% 对称标签噪声对 MNIST 属弱攻击，如实报告）；
- 数据增强防御后：$Acc_{defense}=0.9475$，$RecoveryRate=1.0$，$EffectiveASR=0.0$。

数值随硬件/运行略有波动。
