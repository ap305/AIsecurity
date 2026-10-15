# 六个原课程 v2 场景转换

本目录独立保留服务器 `managed/<scenario>/v2/code` 的可信源码快照。六个包覆盖原12道攻击/防御题，不采用v1或替代练习。`build.py` 为源码计算SHA256，生成题面、原接口模板、参考代码、环境包、资源和校准元数据。

## 构建与安装输入

```powershell
python prepare_audio.py --output <资产根>/deepfake_audio/v2/code/data/audio_splits.npz
python build.py --asset-root <managed资产根> --output <新输出目录> --image <固定镜像>
python calibrate.py --questions <输出>/questions.json --measurements <真实RPC自测结果.json> --output <新policy.json>
```

每题安装记录包含 `questionId/scenarioId/role/title/content/answerTemplate/solution/definition/packageDirectory/referenceCodePath/calibrationRequired/calibration/metrics/policy/provenance/publishable`。安装器导入对应包，补齐packageId后，先进行官方参考baseline和opponent两阶段真实自测。只有资产完整、阈值已定、发布自测门禁通过的题目才可发布。源码审查的`--allow-missing-assets`输出不可用于部署。

`calibration.baseline/opponent`为`fixed`或`reference`。已有门槛用`baselineThreshold/successThreshold`；缺失门槛来自官方参考算法固定数据实测。`metrics`声明原指标名字；运行结果统一映射`qualificationMetric/successMetric`。未校准环境仍产出真实指标；安装器临时给题目阈值0，并在评测parameters写入calibrationMode=true用于自测，但不得发布。Patch攻击baseline不额外训练防御，successMetric由独立opponent自测产出。

正式安装保留同一个自测包及digest，把真实门槛冻结到definition.evaluation及其parameters.successThreshold，并移除parameters.calibrationMode。裁判按冻结的parameters.successThreshold判定对抗成功，拒绝未提供有限阈值的正式评测。安装器把题面thresholdContentPlaceholder（`<!-- FROZEN_COURSE_THRESHOLDS -->`）替换为明确的原指标名称和两阶段阈值，不需重新打包来改变门槛。

`calibrate.py`测量输入为数组，每项有questionId、phase、result（status/metrics）、referenceCodeSha256、对抗时的opponentReferenceCodeSha256、measuredAt。固定门槛永不因为参考算法未通过而降低；report会明确列出这些失败。校准证据保留源码/数据哈希、镜像、seed及原始指标。

## 数据和隔离

MNIST两场景要求真实固定8000/2000缓存；Patch要求原benchmark.npz与detector.pt；图像要求192/96缓存，水印要求48张512像素缓存。音频使用原生成器重新生成64训练/64测试，修复旧缓存将训练集同时当测试集的问题。缺文件明确失败，不尝试下载、合成替换或缩小规模。

私有data、original_test.py和裁判只挂载到grader。worker只获得manifest明确列出的public文件、学生代码和公开TinyDetector权重。公共dataset删除隐藏数据加载/生成入口。学生类、训练后模型和梯度图留在worker，裁判通过平台安全ndarray和对象RPC调用，禁止pickle传输。ResNet18公共ImageNet权重必须随已锁定镜像提供；加载失败不会随机初始化。

原课程自身的DeepFake音频/图像、Patch和水印数据是确定性合成基准，保留原生成器/缓存、规模和模型。MNIST为真实数据。两者需在交付说明中分别说明。

## 纠正与计分

- 题面/模板同步实际v2的类与函数接口，删除旧伪模型、32像素和env/task陈述。
- MNIST裁判实际比较像素与标签核验5%预算，检查统一连续2×2触发器，不信任学生自报n_modified。统一MLP仍用原数据训练协议，未增加原模型不支持的sample_weights功能。
- 音频保留AttackScore和线上RobustAUC，不读取学生模型的私有GMM属性，不把固定池其他攻击分数混入学生攻击分。
- 固定池仅用于baseline；opponent只使用指定双方。原评测中的正常失败仍正常完成，不能用异常或缩小分母改变新PRD计分。
- 水印执行异常、非法返回结构及非有限概率按D-05不产生成绩；仅正常返回但未满足原质量门槛的变换保留原图回退。原v2异常回退0.5的实现不再作为得分来源。
- Patch按已确认的逐目标口径评测：对每个eligible目标从原图独立生成攻击图与自然遮挡图，复用同一几何参数，只统计该目标。修正原实现每图只贴首目标却统计全部目标的问题，保留AttackGain≥.40与HideRate≥.50；攻击对抗使用相同的修正base，防御图级训练与对抗协议保持原标准。公开审查证据见`acceptance/patch_protocol_review.json`，其结果不代替正式自测。
- Patch裁判和worker统一固定Torch intra-op/inter-op线程为1、启用确定性算法及MKLDNN确定性开关，保留MKLDNN。原seed=42的两份CPU训练在首次反传后出现数值漂移；修复配置下两份完整8轮公开复验的逐步输出、模型和预测全部相同。源码、输入及结果哈希见`acceptance/patch_determinism_review.json`。该Patch专属数值配置不改变模型、训练参数和资格线，新评测版本与包必须重新自测。
- 所有平台阈值采用≥；小于越好的约束转为margin（例如`0.1-FPR`），margin≥0包含边界。

验证入口：`python -m unittest discover -s tests -v`。真实训练、图像质量和Docker隔离需在对应固定依赖镜像上做完整课程自测；单元测试不能替代这些验收。

功能集成可先用`node <quiz-svc>/node_modules/tsx/dist/cli.mjs tests/export_rpc.ts <临时RPC目录>`导出生产协议，再运行`python tests/rpc_course_smoke.py --build <构建输出> --rpc <临时RPC目录> --output <新日志目录> --scenario mnist_poison --role attack --phase baseline`。该测试在独立Python进程中使用真实完整课程数据、实际参考代码和生产RPC；它验证功能，不代替Docker隔离或固定依赖镜像的权威校准。

在固定镜像内运行上述 harness 时加`--isolated-worker`，使worker使用与生产一致的`python -I`启动模式。学生`code.py`通过显式路径加载，材料目录不得进入模块搜索路径，否则会遮蔽Python标准库`code`，使Torch导入失败。

`acceptance/manifest.json`提供独立标准验收提交，只用于证明已有硬门槛可实际通过；原官方reference和固定池保持不变，缺失阈值仍由官方reference实测。验收例仅用公开train研究，验证证据分别保存；正式服务器隐藏数据验收通过前不得视为发布证据。

MNIST投毒当前验收例使用合法的像素与标签联合替换，变化索引并集恰为5%；公开15组holdout、冻结代码哈希及完整8000样本契约记录在`acceptance/mnist_poison_validation.json`，研究说明与复现入口见同目录`mnist_poison_attack_research.md`。它只改变验收提交，不改变环境包、官方参考或计分门槛。
