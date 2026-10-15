# Patch CPU 训练重复性审查

在固定镜像 `ai-security-legacy-eval:20261015-r1` 的同一服务器上，原参考防御即使使用 seed=42，也会出现不同结果。该差异已用公开防御训练160图、验证60图复现；未使用隐藏测试图或标签调试、选算法或改门槛。

两份全新容器的训练和验证数组、初始化全连接层、初始化后的 Torch 随机状态、八轮采样顺序全部相同。第一次前向的 logits 与 loss 逐字节相同，第一次反向传播及参数更新后开始出现数值差异。完整八轮后，两份模型不同，验证 FPR 分别为0.05和0.10、TPR均为1。说明问题在 CPU 训练数值执行阶段，不能归因于固定池随机数、角色分支或学生与对手共享随机状态；本次没有进一步把问题武断定位到某个底层算子。

| 配置 | 独立复验 | 结果 |
|---|---|---|
| 原镜像线程数2 | 两份完整8轮 | 第2步起分叉，最终FPR不同 |
| 确定性算法与MKLDNN确定性开关 | 两份3步 | 第1次参数更新后仍分叉 |
| 上述开关，并固定Torch intra-op/inter-op线程为1 | 两份3步及两份完整8轮 | 每步loss/logits、采样顺序、最终模型与预测全部逐字节一致 |

固定配置保留MKLDNN启用状态，保留原ResNet18、公开预训练权重、seed=42、8轮、batch=32、224像素、优化器参数和全部资格门槛。两份完整复验得到FPR=0、TPR=56/60，最终模型SHA256为`78a34e4aed3cfb2928ef47d1d5366e312a8a36f253e5e5428105e6924f32186c`，预测SHA256为`46ea8e90827b377fad3e8bea0a2d6a61bb0d2964540256ef8adb0d5ad1b28461`。

生产RPC另做了直接检查：只在首次construct的bootstrap中配置，随后fit和predict分别处于新的原生线程9、81、83；三个调用执行张量算子前后均为单线程、interop=1、两个确定性开关启用。固定镜像中配置能够传播到后续RPC线程，无须修改通用RPC协议。完整训练复验在进程启动时配置，并模拟construct/fit/predict的独立串行线程；RPC配置传播证据单独记录，二者不混作完整平台自测。

环境包为Patch双方统一使用`torch-cpu-single-thread-deterministic-v1`，评测版本更新为`course-v2-rpc-patch-target-cpu1-v3`。只有Patch的裁判和公开worker bootstrap调用该配置，其他五个ML场景不启用。新包必须重新进行平台baseline/opponent自测和阈值冻结；以上公开证据不替代发布验收，也不承诺跨硬件逐字节一致。

详细源码、材料和输入哈希、首三步数值、完整训练轨迹哈希以及运行时间见`patch_determinism_review.json`。复现入口为`tests/review_patch_determinism.py`：输入仅含原benchmark的公开防御切片（行150:370，共220图；`images/boxes/cids/counts`四数组），在固定镜像中分别以`--profile original`、`flags`、`single`运行两个全新进程。默认`single`完整运行原8轮，不覆盖已有输出文件。
