# Patch 逐目标评测口径审查

2026-10-15 已确认采用“每个合格目标独立贴片、独立评测”，保持 `AttackGain ≥ 0.40`、`HideRate ≥ 0.50`。原 `sources/patch_attack/test.py` 对同图仅首次遇到的 eligible 目标生成攻击图，随后却把该图全部 eligible 目标计入分母；这会把没有接受贴片干预的目标计为攻击失败。

下表使用原官方 `GradientPatchAttack`，公开训练集 120 图、公开验证集 30 图共 62 个 eligible 目标，seed=42、250 次优化。公开数据专用无网络容器未挂载隐藏测试；没有替换模型、降低门槛或调整官方攻击。镜像、源文件、公开权重、数据容器及各数组 SHA256 均记在同名 JSON 中。

| 统计口径 | 计分目标 | 攻击后仍检测到 | 自然遮挡后仍检测到 | HideRate | AttackGain |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原实现：每图贴首目标，统计全部目标 | 62 | 31 | 37 | 0.500000 | 0.162162 |
| 对照方案：仅统计实际贴片首目标 | 30 | 0 | 5 | 1.000000 | 0.99999994 |
| 已确认方案：每个 eligible 独立贴片并统计该目标 | 62 | 0 | 9 | 1.000000 | 0.99999993 |

官方贴片已经隐藏全部实际被贴片的验证目标。采用逐目标方案可覆盖全部 eligible，避免只取首目标带来的标注顺序偏差。每个 case 从原 clean 图开始；攻击和遮挡共享位置、缩放、旋转、颜色参数；同一个 seed=42 随机流按原 eligible 顺序运行，原 AttackGain 公式中的 epsilon 和遮挡全成功分支不变。Clean、攻击与遮挡三组指标采用同一批目标，攻击对抗的 base 也采用该口径。防御方图级二分类、训练数据与资格线不受此问题影响。

本证据说明计分对象与实际干预对象不一致，**不证明原硬门槛在数学上绝对不可达**。局部感受野之外仍可能因 NMS、目标重叠产生间接漏检。公开研究不作为隐藏集调参或发布通过证明；新版包仍需完整官方参考 baseline/opponent 自测并冻结对应版本。

复现（固定镜像内，仅挂公开 120/30 NPZ 和 detector.pt）：

```sh
python tests/review_patch_protocol.py --public-data /public/attack-public.npz --weights /public/detector.pt --output /results/review.json --image-id sha256:bb3ee30c5b38c6974260387d2f0ba4de6b89c9d3954cae420ad346ea81853e4c
```

脚本拒绝含其他 split 或不等于 150 条记录的 NPZ，输入只读，输出文件已存在时拒绝覆盖。NPZ 压缩容器哈希可能受导出库版本影响，因此同时提供每个原始数组的 dtype、shape 和字节哈希以复核相同数据。
