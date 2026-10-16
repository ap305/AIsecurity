# v3 媒体攻防 05 / 10 / 11 / 12

`build(source_root, output, image, reference_weights=None, private_order_seeds=None, practice_cache_root=None)` 构建四个共享环境包、八道攻防题，返回与基础题一致的中间清单。每个包同时包含两个角色的公开框架，worker直到收到可信裁判的角色初始化调用才合成提交；角色不能在同一worker内改变。学生PyTorch参数及joblib对象只在worker读取，评分端仅得到受限数组、标量或随机对象句柄。基线使用原冻结教师资产；对抗阶段双方都是真实独立worker，不以官方攻击池冒充对手。

`--private-order-seeds`读取四个MEDIA包的256位私有种子配置；首次构建可生成，后续构建应重用输出`private-order-seeds.json`以固定同一配对的输入次序。每个配对A/D共享同一包，私种子仅写入grader的`evaluation-order.json`并计入包hash，不进入worker挂载、下载ZIP或结果字段。05一次混排完整干净/贴片批次；11/12在所有干净、攻击、真人/伪造样本收集完成后统一混排推理，裁判恢复原公式需要的索引。10对正负分支的攻击调用和检测调用分别私有混排。不能使用公开种子或按标签分阶段调用。

构建清单的基线和对抗阈值保持`null`，标记`requiresCalibration`。必须由实际环境包自测校准并冻结正的成功门槛后发布。对抗结果仅返回`success`和扁平数值指标，最终百分比由平台汇总；异常不计分。`result_contract.py`保证最多100项有限数值，不向平台结果协议传递原题的说明字符串、嵌套字典或布尔指标。校准时允许只采集指标，但正式运行拒绝缺失、零或负的胜利门槛。

| 题目 | 基线资格指标 | 实际对手指标 |
| --- | --- | --- |
| A05 | 原`100×(0.85×AttackGain+0.15×ConfidenceDrop)`，且Gain≥0.40、HideRate≥0.50 | 每个合格目标独立贴片，目标隐藏且对方未检出占比 |
| D05 | 原`100×(0.7×BalancedAccuracy+0.3×AUC)`，且干净FPR≤0.10、贴片TPR≥0.70 | 对实际攻击贴片的检出目标占比；同一80张干净控制图FPR须≤0.10 |
| A10 | 原`100×(1−mean AUC)`，D0和null对照保留 | 与实际水印嵌入/检测器配对的`1−AUC`；保留原逐样本保真失败回退 |
| D10 | 原Id/A0平均AUC×100 | 干净Id对照与实际攻击的AUC平均；对称正负样本均交给实际攻击 |
| A11 | 两教师检测器平均ASR×100，合法率≥0.80且平均SSIM≥0.92 | 对单个实际检测器的ASR，保留相同资格门槛 |
| D11 | 原`(clean AUC+固定攻击池robust AUC)/2×100` | `clean AUC`与单个实际攻击的`robust AUC`平均 |
| A12 | 原Codec/Noise/Channel平均`100×ASR×Q` | 仅学生CodecAttack对实际防御的`ASR×Q`，不混入其他官方攻击 |
| D12 | 原EER/AUC/效率加权公式 | 同一公式，鲁棒集只使用实际攻击；干净真人/伪造控制保留 |

05保留用户确认的逐目标独立修正：隐藏集80张图片、152个合格目标，每个目标单独渲染、推理和计分，不能只贴每图首目标却让所有目标进入分母。原参考攻击实测Gain=0.7714285、HideRate=0.9473684；与参考防御配对时攻击成功1/152、防御检出151/152，干净误报1/80。

11原JPEG参考quality85虽合法率1，但SSIM=0.889353<0.92。quality95仍不达标；原基类还会把传入95吸附回85。保留相同纯JPEG算法和原门槛，参考改为quality100、4:4:4；实测SSIM=0.994159、合法率1、攻击成功0/48。因此其资格参考为0，**零参考不等于对抗获胜**，对抗门槛至少1/48。学生不受参考参数限制。失去资格的结果输出`legalityGate=0`和`qualificationMetric=-1`，避免0≥0误通过。

`minimumPositiveSuccessThreshold`仅在参考成功指标恰为零时使用：05为1/152，A11为1/48，A10为1/(2×48²)，D10/D11为1/(4×48²)。12含连续Q/效率，没有严格离散最小正值，字段为null；若校准意外得到零，应停止冻结并核查，不能任意抬为1/N。所有非零参考指标直接保留真实实测值。

公开资源重新派生：05仅前370张训练/验证图，不含80张隐藏图；11只含train文件，本地test从train抽样；10/12不公开正式数据生成链，只提供已准备好的独立练习缓存。更改默认seed不能阻止复现正式数据，因此worker的`public/dataset.py`和学生ZIP内dataset均仅保留安全读取/格式转换接口。显式预处理脚本`tests/prepare_public_training.py`用审查过的作者生成器与独立seed1042生成`media10-training.npz`、`media12-training.npz`、`media12-validation.npz`，通过`--practice-cache-root`传入；构建器不执行原题代码，并用逐样本hash拒绝正式/公开数据或音频训练/验证数据重合。练习缓存只进入ZIP，不挂载到评测worker。

所有8份包均实际解压、导入完成后的学生模块并加载训练数据通过。A05、D05、D11、D12四条本地训练/导出路径均以真实参考完成填写，实际拟合并生成model.pt通过；标准答案和验收产物仅在私有测试目录，不进入下载包。

测试入口：

```text
python -m unittest discover -s tests -p 'test_*.py' -v
python tests/rpc_smoke.py --build <构建目录> --rpc <导出的生产RPC目录> --output <新测试目录> --id A05 --phase baseline
python tests/rpc_smoke.py --build <构建目录> --rpc <RPC目录> --output <新测试目录> --id A11 --phase opponent --success-threshold 0.020833333333333332
python tests/local_resource_smoke.py --build <构建目录> --output <新目录> --id D11 --fit
```

RPC harness按生产形态传完整`definition.evaluation`，每份真实结果立即调用项目`validateEvaluationResult`。本机多进程RPC验证数值与协议，不能替代部署主机的Docker挂载/网络隔离和环境包清理自测。

`calibration.local.json`记录8题全部16次真实本地阶段结果、参考源码/权重hash和A11参数修正证据，正式阈值仍需目标容器再校准。空Torch/HF缓存且禁止外网socket条件下，A11双教师基线和真实对手阶段均复测通过；对手门槛1/48时成功率0返回`success=false`。media11实际使用scipy特征及scikit-learn检测器；media05的ResNet18恢复明确`pretrained=False`，私有参数随包提供，不依赖主机模型缓存。

私有混排修复后全部16次真实基线/对手评测及生产TS协议校验通过，参考数值保持一致；14项单元回归包含批次大小、半段位置、奇偶调用和图像/语音阶段计数捷径的阻断，以及正式生成器不下发、练习缓存重合拒绝。水印原教师函数与安全实现全部原统计字段在48样本Id/A0两组上逐项一致（容差1e-12，不含耗时）。10/12裁剪后的四份下载包已实际导入/读取；D12在新独立缓存上完成真实训练和参数导出。独立复审确认下载ZIP和worker公开dataset一致，worker不挂任何NPZ，私有种子不进入公开材料。
