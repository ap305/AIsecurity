# 手写数字局部触发器后门（代码说明）

本目录为《手写数字局部触发器后门》题目的标准代码包：实现攻击方 Baseline（右下角
2×2 全白触发器）与防守方 Baseline（3×3 中值滤波），并在统一基准（MNIST、固定划分、
统一 MLP 模型）上计算全部攻防指标。

## 文件说明

| 文件 | 职责 |
|---|---|
| `dataset.py` | 加载/缓存基准数据集：优先本地 `data/train.npz`、`data/test.npz`，否则经 OpenML `fetch_openml("mnist_784", id=554)` 下载（`data/openml/` 已内置离线缓存），网络与缓存均不可用时回退到合成数据。输出 `{"images": [N,1,28,28] float32∈[0,1], "labels": [N] int64}` |
| `attack.py` | 攻击 Baseline：`attack(images, labels, target_label=0, poison_rate=0.05, seed=42)`，注入右下角 2×2 全白局部触发器并将标签改为目标标签，返回 `{"images","labels","trigger_mask","trigger_pattern",...}` |
| `defense.py` | 防御 Baseline：`defend(images, labels, kernel_size=3)`，对所有训练图像做 3×3 中值滤波（零填充、纯 numpy），不改变标签、不删除样本 |
| `test.py` | 基准指标计算：干净训练 → 攻击 → 投毒训练 → 防御 → 清洗训练 → 干净/触发测试 → 输出报告与 `results/metrics.json`；`--stage attack|defense|all` |
| `run_attack.sh` | 攻击方终端脚本：`python test.py --stage attack` |
| `run_defense.sh` | 防守方终端脚本：`python test.py --stage defense` |
| `requirements.txt` | 最小依赖：numpy、scikit-learn（CPU 即可） |

## 快速开始

```bash
pip install -r requirements.txt
bash run_attack.sh      # 攻击方指标（约 1~2 分钟，CPU）
bash run_defense.sh     # 防守方指标（约 1~2 分钟，CPU）
# 或一次性完整评测：
python test.py --stage all
```

评测结果保存在 `results/metrics.json`（含 Acc_clean/Acc_attack/Acc_defense、
ASR_clean/ASR_attack/ASR_defense、PoisonRate、BackdoorGain、CleanRetention、
AttackScore、BackdoorRemoval、DefenseScore、资格线/参考线等）。

## 默认基准设置

- 数据集：MNIST（OpenML id=554），训练 8000 / 测试 2000，seed=42 固定划分，结果可复现；
- 统一模型：`sklearn MLPClassifier`，隐层 `[256, 128]`，ReLU、Adam、`alpha=1e-4`、
  `batch_size=128`、`learning_rate_init=1e-3`、`max_iter=40`、early stopping；
- 攻击默认参数：目标标签 `target_label=0`（公开调试阶段约定）、投毒率 `poison_rate=0.05`、
  触发器 2×2 全白、位置右下角（与边界保留 1 像素间距）、随机种子 42；
- 防御默认参数：3×3 中值滤波（零填充）。

可复现性说明：固定随机种子（默认 42）与固定数据划分，多次运行结果一致；不同
硬件/库版本下准确率可能有 ±0.005 量级的小幅波动，属正常现象。

## 数据获取（无网络环境）

`data/openml/` 已内置 OpenML 离线缓存，`fetch_openml` 会直接命中，无需联网；
若缓存被删除且无网络，`dataset.py` 自动回退到离线合成数据，评测流程仍可跑通。

## 常见问题

- 运行报 `ModuleNotFoundError: sklearn`：请先 `pip install -r requirements.txt`；
- 首次运行较慢：需要解压内置 OpenML 缓存并生成 `data/train.npz`、`data/test.npz`，
  之后直接命中本地缓存；
- 控制台中文乱码：Windows 下请使用 Git Bash（UTF-8）运行 `bash run_*.sh`。
