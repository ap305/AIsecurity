# PRD V1.1 题库与评测资产迁移盘点

盘点日期：2026-10-14。范围为本仓库 checkout 的 `services/quiz-svc/prisma/seed.ts`、`src/lib/scenarioQuestions.ts`、旧 `src/services/match.ts`、`judge-assets/` 与 `question-assets/`。本次仅查看源文件、目录和文件名，未运行 seed、旧评测器或学生程序，未连接业务数据库、读取凭据、转换真实提交。

这是静态候选清单，不能代表线上已发布题数、实际 judgeMode、部署中的资产版本或题目验收状态。最终发布/下架/转换清单须用[迁移预览](prd-v1.1-delivery.md#迁移和运行)得到的数据库报告补全，按数据库中的实际题目 ID 与 revision 核对；历史 ID 不按本清单重编号。

## 1 范围和总量

当前 seed 定义 32 道模块基础题（27 理论 + 5 编程）、16 道独立编程实践题、32 道旧描述型安全场景，以及 24 个有攻防映射的场景各 2 道角色题。静态候选共 128 条：48 基础、80 旧 `security`。该数量不是本 PRD 的固定题目配额。

`seed.ts` 的 `main()` 开头删除 `Submission` 和 `Question`。因此 `db:seed` 是历史开发重建工具，不能用作本次保留历史记录的迁移步骤，也不能用它覆盖业务数据库。新迁移使用独立的差异报告和显式应用流程。

所有下列旧资产目前都是旧 Python 调用接口，不能直接当作已发布的 `platform-rpc-v1` 环境包。静态“文件存在”也不证明权重可加载、数据完整、依赖可安装或算法评分正确。

## 2 模块基础题和旧描述型安全题

seed 中编号使用模块内累计 `num`。插入实践题后，旧安全题的 S 编号跟随移动，需特别核对历史数据库是否来自较早 seed。

| 模块 | 理论题 ID | 自动评测编程题 ID / 题目 | 旧编程资产 | 旧描述型安全题 ID（按当前 seed 公式） |
| --- | --- | --- | --- | --- |
| M1 对抗攻击与规避 | M1-B01～M1-B06 | M1-B07 / FGSM 对抗样本生成 | `judge-assets/m1-fgsm/test_code.py` | M1-S11～M1-S17 |
| M2 数据投毒与后门 | M2-B01～M2-B05 | M2-B06 / 标签投毒攻击与检测 | `judge-assets/m2-poison/test_code.py` | M2-S10～M2-S15 |
| M3 模型窃取与隐私 | M3-B01～M3-B06 | M3-B07 / 成员推断攻击 | `judge-assets/m3-mia/test_code.py` | M3-S11～M3-S17 |
| M4 LLM 安全 | M4-B01～M4-B05 | M4-B06 / Prompt 注入检测器 | `judge-assets/m4-injection/test_code.py` | M4-S11～M4-S16 |
| M5 公平性与审计 | M5-B01～M5-B05 | M5-B06 / 公平性指标计算 | `judge-assets/m5-fairness/test_code.py` | M5-S10～M5-S15 |

旧入口为 `/module/:moduleCode` → `/question/:id` → `/api/submissions`；旧配置分别为 `theory_eval` 或 `code_eval`，后者通过 `assetDir/script` 找到 `test_code.py`。

- 理论题题面与关键词/minWords 规则存在于 seed；无独立 Compose/RPC 包。先由教学方确定是否保留“Markdown 作答 + 关键词评分”题型，再配置能接受文本答案的可信评测入口；不能未经确认将这些内容变成代码填空题或把旧关键词分默认视为新版算法评分。
- 五道模块编程题的测试脚本在本地存在，主要使用 NumPy/内置样例；可以复用题面、参考逻辑及测试断言。脚本直接导入 `student_code.py`，需要将学生函数执行放到 worker，把测试输入、断言和成绩计算保留在 grader。
- `m2-poison/test_code.py` 与 `m3-mia/test_code.py` 可见 `np.random.randn`；前者还有 Python `hash(...)` 派生随机种子。迁移时需要固定随机源和参数，验证同一版本的重复结果一致，不能仅沿用旧输出文本中的分数。
- 32 道描述型安全题的 seed 记录为 `type='A/D'`、`answerTemplate=null`、`testConfig=null`，没有对应固定角色、基线或可执行评测契约。它们可复用教学题面；上线前须补成攻击/防御两条角色任务并建立关联、模板、环境与基线，或明确保留为不开放提交的历史资料。不能把它们误认成下文 24 个完整场景的重复资产。

## 3 独立编程实践题（16 道）

以下每个旧入口均为 `/question/<ID>` → `/api/submissions`。旧 `test_code.py` 用命令行接收代码目录，模型题还接收模型路径；由旧 `judge.ts` 执行并解析打印的成绩。`question-assets/<asset>/template.py`、`solution.py` 可用于迁移模板与参考答案；LENET-01 的两份代码直接内置在 seed，未见同名 `question-assets/lenet` 目录。

“需学生权重”不等于缺平台资产：这类权重应由学生本地训练后随该次提交冻结。教师仍须提供标准权重用于自测；本地已有参考权重不代表它符合最新版结构。

| ID / 名称 | 旧类型与目录 | 本地确有的数据/权重 | 可复用方式与逐题阻塞 |
| --- | --- | --- | --- |
| LENET-01 / LeNet 手写数字识别 | model_eval / `lenet` | `test_code.py`、requirements、MNIST test Arrow | 保留测试集与准确率逻辑；内置模板需提供 worker 预测函数包装。需要学生 `model.pth` 及教师标准权重、PyTorch/torchvision/datasets 镜像；旧 grader 直接 import LeNet 必须拆开。 |
| FNN-01 / Iris 分类 | model_eval / `fnn-iris` | `test.csv`、requirements、模板/参考解 | 可复用固定测试 CSV 与模型结构检查；学生权重及 PyTorch/pandas 镜像必需。原脚本 `torch.load(...weights_only=True)` 的限制应保留，加载在受控 worker 中。 |
| RNN-01 / 序列分类 | model_eval / `rnn-seq` | `sequence_dataset.csv`、requirements、模板/参考解 | 保留固定序列与标签；学生 `rnn_model.pth`。直接导入 SequenceDataset/RNNClassifier 要改成 RPC 预测及结构摘要。 |
| ACT-01 / 激活函数与梯度 | code_eval / `activation` | test、requirements、模板/参考解；未见外部数据或权重 | 较适合先转换：sigmoid/tanh/relu/leaky_relu 采用 JSON 数组输入输出，grader 保存数值断言。需要 NumPy 镜像和数组大小/精度契约。 |
| AUG-01 / MNIST 数据增强对比 | model_eval / `aug-mnist` | MNIST test Arrow、基线 `model.pth`、requirements | 基线确有文件；学生上传 augmented_model。需冻结增强模型/基线的结构、数据预处理和比较方式，加载基线与学生权重应保持权限边界。 |
| CNN-01 / 经典 CNN 架构对比 | model_eval / `cnn-compare` | MNIST test Arrow、requirements、模板/参考解 | 旧提交为包含多个 state_dict 的 `cnn_models.pth`，不能按任意单模型 .pt 接收。需要声明合并键、各架构接口和评分聚合；测试与预测通过 RPC 分离。 |
| DET-01 / 预训练目标检测推理 | code_eval / `detection` | test、requirements、模板/参考解；该 judge 目录未见真实检测图片/预训练权重 | 旧脚本含结构及最小流程检查；不能声称完成真实检测性能评测。需出题人确认检查范围，若要真实检测，补固定图片、目标标注与离线可用权重；不要在无网络 worker 中临时下载模型。 |
| QLRN-01 / Q-Learning 迷宫 | code_eval / `qlrn-maze` | test、模板/参考解；未见外部数据/权重 | 可复用迷宫及算法断言，补 NumPy 镜像；将完整训练循环/对象接口改为有界 RPC 函数或状态接口，固定随机种子。 |
| MATT-01 / 多头注意力可视化 | code_eval / `mhatt-viz` | test、模板/参考解；未见外部数据/权重 | 旧测试直接实例化 MultiHeadAttention；需 worker 包装前向/形状与数值输出，不能把可执行类传给 grader。PyTorch 依赖与 JSON 批次上限需验证。 |
| LSTM-01 / 文本生成 | code_eval / `lstm-gen` | test、模板/参考解；未见外部训练语料/权重 | 静态存在的是网络/接口评测代码。需要确认目标是结构测试还是实际生成质量；后者另补固定语料、标准权重与质量指标，避免承诺平台通用在线训练。 |
| DCGAN-01 / 图像生成 | code_eval / `dcgan-gen` | test、模板/参考解；未见外部训练图像/生成模型权重 | Generator/Discriminator 实例化测试可复用但须 RPC 包装。真实图像质量评测还缺课程数据、参考模型/指标及预算；结构测试不能替代真实生成质量。 |
| GANS-01 / GAN 稳定性比较 | code_eval / `gan-stab` | test、模板/参考解；未见外部数据/权重 | 先明确结构/损失函数检查与训练稳定性实验的边界；固定指标、随机源和运行规模，学生执行与 grader 断言分离。 |
| GCN-01 / Cora 节点分类 | model_eval / `gcn-node` | `data/Cora/cora/cora.content`、`cora.cites`、test、模板/参考解 | 可复用 Cora 本地数据；学生 `gcn_model.pth`。需冻结图归一化、划分及特征顺序；GraphConvolution/GCN 直接 import 改 RPC，较大矩阵需受控分批传输。 |
| TRSF-01 / Transformer 文本分类 | model_eval / `trsf-encoder` | AGNews `test.csv`、`vocab.json`、test、模板/参考解 | 固定词表与测试集确有文件；训练语料不在该 judge 目录。需提供学生本地训练资料及标准权重，冻结词表哈希、tokenization 与 `transformer_encoder.pth` 键结构。 |
| PYTB-01 / PyTorch/TensorBoard 流程 | model_eval / `pytb-flow` | MNIST train/test Arrow、dataset_dict 与 test、模板/参考解 | 可复用数据及 CNN 推理评价；学生 `mnist_cnn.pth`。需要确认新版只评推理，TensorBoard/训练日志是否是必要材料；不得自动扩成服务器通用训练。 |
| DQN-01 / CartPole 实验 | code_eval / `dqn-cartpole` | test、requirements、参考 `dqn_model.pth`、模板/参考解 | 旧脚本注入 gym/matplotlib mock，不运行 CartPole，只检查网络与 Q 值。若沿用应在题面明确；若要回合奖励评测，需真实 gymnasium、固定种子/回合与运行预算，重新自测。 |

8 道实践模型题为 LENET/FNN/RNN/AUG/CNN/GCN/TRSF/PYTB；8 道实践算法题为 ACT/DET/QLRN/MATT/LSTM/DCGAN/GANS/DQN。这只是旧配置分类；新提交能力最终由题目版本明确。

## 4 攻防场景（24 个，共 48 条固定角色候选）

映射依据为 `src/lib/scenarioQuestions.ts`。旧学生入口为 `/arena` 同页场景和角色选择，旧接口为 `/api/matches/run`、`/api/matches/submit-inline` 或工程上传/校验；这些执行入口在新版明确返回迁移提示，不能继续给基础积分加分。

下表“共享 Agent 引擎”指 `judge-assets/agent_injection/agent_injection_engine.py`；“legacy 独立引擎”指 `judge-assets/<scenario>/<scenario>_engine.py`。这两个形式均直接执行/导入学生 Python 或 Solution，并不能直接运行在可信 grader 内。

| 场景 | 攻击题 ID | 防御题 ID | 本地旧资产与迁移要点 |
| --- | --- | --- | --- |
| bankbot | AGENT-AD-ATK | AGENT-AD-DEF | `bankbot/bankbot_engine.py` 及 seed 模板。需分离交易环境与学生攻击/守卫回调，固定平台模型和合法交易基线；未见独立 managed 包。 |
| mailmate | MAILMATE-AD-ATK | MAILMATE-AD-DEF | 共享 Agent 引擎的邮件场景配置；无独立 managed 目录。将邮件数据保留为 grader fixture，学生只返回攻击内容或净化决定。 |
| chatops | CHATOPS-AD-ATK | CHATOPS-AD-DEF | 共享引擎 + `managed/chatops/v1/code`。有 backend/blank/参考实现/test/dataset 与 attack_payloads、defense_fpr 数据；优先可复用，但 `from attack/defense` 和 Env 回调需 RPC 拆分。 |
| tripbot | TRIPBOT-AD-ATK | TRIPBOT-AD-DEF | 共享引擎的行程场景；无独立 managed 目录。需固定工具状态、正常行程可用性指标与平台模型，不能仅复用注入字符串作为完整判题。 |
| safellm | SAFELLM-AD-ATK | SAFELLM-AD-DEF | legacy 独立引擎含规则 mock 与网关路径；需补固定真实模型、内容护栏/安全目标及样例，正式评测不能自动回落规则 mock。 |
| prompt_injection | PINJ-AD-ATK | PINJ-AD-DEF | legacy 独立引擎含规则 mock 与网关路径；需固定任务/受保护指令、指标与模型，RPC 分离提示渲染和结果判定。 |
| rankguard | RANKGUARD-AD | RANKGUARD-AD-DEF | legacy 排序偏移引擎含规则 mock 与网关路径；需固定原始列表、偏移成功阈值及模型参数，成绩按用户对手数计算。 |
| deepfake_audio | DEEPFAKE-AD | DEEPFAKE-AD-DEF | 本地该目录仅一个 legacy engine，无 .wav/.pt/.pth；它是 NumPy 音频仿真。真实反欺骗课题需恢复音频数据、检测基线/权重、质量限制和 AUC/EER 归一指标；未见本地模型 managed 版本。 |
| watermark_image | WATERMARK-AD | WATERMARK-AD-DEF | 本地仅 legacy NumPy/DCT 引擎，无图片数据或模型 managed 目录。可复用仿真任务；正式水印指标、图像集和 embed/detect 接口须由出题人冻结。 |
| mnist_backdoor | MNIST-BD | MNIST-BD-DEF | 本地仅 legacy NumPy 伪模型引擎，无该场景真实 MNIST/权重资产。真实后门题需要基线、触发器及干净精度约束，旧训练/回调接口与新版本地训练参数提交要求需重新对应。 |
| deepfake_image | DEEPFAKE-IMG | DEEPFAKE-IMG-DEF | 本地仅 legacy 引擎，无该目录图片/检测权重。缺真实检测集、质量约束、标准基线与模型 managed 包；仿真不能替代正式 DeepFake 验收。 |
| mnist_poison | MNIST-POISON | MNIST-POISON-DEF | 本地仅 legacy 引擎，无该场景数据/权重。需确定投毒比例、标签/无目标约束、恢复指标的资格归一化以及服务器是否只推理；原分档分数不作为新版百分比。 |
| text_watermark | TEXT-WM | TEXT-WM-DEF | legacy 引擎有固定文本/mock/网关路径；未见实际水印模型包。需真实生成/检测服务或固定样本、语义质量约束与标准检测指标。 |
| poisoned_rag | POISONED-RAG | POISONED-RAG-DEF | legacy 引擎有固定检索任务、规则 mock 与网关路径。需冻结语料/检索器及真实模型，攻击文档与防御处理通过 RPC 返回数据，不能导入对手代码到 grader。 |
| mnist_distill | MNIST-EXTRACT | MNIST-EXTRACT-DEF | legacy engine 含 `_make_images`、240 个查询池、160 次预算的本地仿真环境；没有两小时教师 HTTP 服务或实际教师权重资产。需部署教师 API、配置租约和查询契约，提供离线训练流程与标准权重。 |
| patch_attack | PATCH-AD | PATCH-AD-DEF | 本地仅 legacy engine：32×32 RGB/中央高亮对象仿真；无真实检测数据、检测器权重或模型 managed 包。正式贴片题需恢复检测模型/图像标注、尺寸/可见性约束、函数/类包装与资源预算。 |
| supportbot | SUPPORTBOT-AD-ATK | SUPPORTBOT-AD-DEF | 共享引擎 + `managed/supportbot/v1/code`；backend/blank/test/dataset/参考代码及 clean_behavior.json 存在。需 RPC 拆分 Env、检索和 defend pre/post 回调，固定平台 LLM。 |
| projectbot | PROJECTBOT-AD-ATK | PROJECTBOT-AD-DEF | 共享 Agent 引擎；无独立 managed 目录。需冻结项目状态、允许变更、攻击目标及可用性测试；保留状态机于 grader。 |
| vendorbot | VENDORBOT-AD-ATK | VENDORBOT-AD-DEF | 共享 Agent 引擎；无独立 managed 目录。需固定第三方数据、账单/供应商基线及工具权限。 |
| agendabot | AGENDABOT-AD-ATK | AGENDABOT-AD-DEF | 共享引擎 + `managed/agendabot/v1/code`；完整文本资产存在。需 RPC 拆分参会人来源/工具守卫，固定平台 LLM 和正常任务成功规则。 |
| webbot | WEBBOT-AD-ATK | WEBBOT-AD-DEF | 共享引擎 + `managed/webbot/v1/code`；完整文本资产存在。需 RPC 拆分网页打开、表单及通知邮箱守卫；课程外部网站是否属于测试依赖须单独确认。 |
| codereviewbot | CODEREVIEWBOT-AD-ATK | CODEREVIEWBOT-AD-DEF | 共享 Agent 引擎；无独立 managed 目录。需冻结代码审查资料、工具权限和正常行为，不把其他真实仓库状态作为可变输入。 |
| hrbot | HRBOT-AD-ATK | HRBOT-AD-DEF | 共享 Agent 引擎；无独立 managed 目录。需固定花名册与角色权限、保护数据和输出脱敏规则。 |
| searchbot | SEARCHBOT-AD-ATK | SEARCHBOT-AD-DEF | 共享 Agent 引擎；无独立 managed 目录。需固定检索数据、答案/目标、可信来源规则与平台 LLM。 |

`managed/` 本地仅见 supportbot/agendabot/webbot/chatops 的 v1 和 current 文件；四题都有 attack/defense backend、blank、参考代码、test.py、dataset.py。当前 checkout 未见这些场景的 v2 目录，也未见模型类六题的 managed 目录。旧 `ADAPTER_CALIBRATION.md` 记载的服务器 v2 切换不能当作本地资产齐全证据；需要从受控部署备份核验、恢复并重新做摘要和来源登记。

`judge-assets/_patches/2026-09-16-llm-forced-reads/` 另有四个 Agent 场景的补丁及版本文本，ChatOps 子目录还有 v3 元数据。补丁不是完整已发布环境包，迁移时要核对它与实际基础资产的版本关系，不能将“目录名称 v3”当作课堂当前版本。

## 5 共同转换要求与明确阻塞

| 阻塞编号 | 影响范围 | 必须补齐的工作 | 已有可复用证据 |
| --- | --- | --- | --- |
| MIG-RPC | 所有旧自动评测 | 旧 import/exec、类对象、Env/闭包和 NumPy/Torch 对象须改成 worker 的有界 JSON/RPC 接口。grader 保留隐藏数据、断言、基线、聚合与最终结果；不能在 grader 导入学生/对手代码，也不能只把 test.py 原封不动包成 main.py。 | test_code.py、engine、backend/blank、模板及参考代码。 |
| MIG-PACKAGE | 所有旧题 | 建立 protocol=platform-rpc-v1 的 manifest、受控 Compose 声明、固定批准镜像及 main.py；冻结题版本、包摘要和评测版本，并绑定按最终 role/参数/模型配置执行的自测。 | 三个 `evaluation-examples` 说明格式和平台闭环，但不能替代真实题目。 |
| MIG-DATA | 模型/检测/真实攻防 | 盘点表中数据“本地存在”仅指文件存在，需校验摘要、样本数量、标签/划分、预处理和许可。缺失的真实模型六题数据/权重、检测图片与标准提交须由出题人或受控部署备份补齐。 | 基础实践的 MNIST Arrow、Cora、AGNews/词表、CSV，AUG/DQN 参考权重。 |
| MIG-MODEL | 模型训练类 | 明确文件格式、模型结构、键、设备及加载接口；学生本地训练权重进入 worker，grader 不加载不可信可执行对象。准备教师标准权重和无效权重案例。 | 旧脚本有模型结构与 strict/load_state_dict 约定，CNN 还有合并权重约定。 |
| MIG-LLM | Agent、越狱、注入、排序、RAG/文本水印等启用模型的题 | 部署平台固定 API 池服务，冻结实际模型版本、系统提示/工具权限/采样和预算；网络只能经过受控 relay，不能将旧 `mock` 的规则结果视为正式真实模型验收。 | managed/mock 和 legacy 网关代码可参考任务逻辑，服务可用性未在此次静态盘点验证。 |
| MIG-TEACHER | 蒸馏/黑盒查询 | 实际教师服务、输入输出、查询额度、固定训练数据来源与标准提交。旧本地 query 函数不是学生两小时 HTTP API。 | mnist_distill 的公开池/预算设计可作为教师服务契约参考。 |
| MIG-SCORE | 所有攻防 | 逐题归一化资格指标并使用 >=；为每对手输出声明 successMetric，按冻结阈值确定二元成功。对手来自相反角色有效用户算法，最终百分比由平台汇总。旧分档、ASR/AUC或固定池均值不能直接充当用户人数百分比。 | 场景 test/engine 和旧 managed adapter 可参考原始指标；新平台保存对手快照及原始指标审计。 |
| MIG-RUNTIME | 所有正式发布题 | 目标 Docker 主机验证镜像、RPC、网络/只读/资源/超时清理、模型加载、真实 LLM 与专业标准样例。确需 GPU 的题目须确认平台受控 GPU 资源分配与镜像；上传 Compose 不能自行添加设备。 | 本地平台规则/内存 PostgreSQL/HTTP/RPC测试及包示例；它们不等同 Docker/GPU实机验收。 |

旧 managed 脚本的 `from attack import attack` / `from defense import defend` 与直接 Env 回调是 MIG-RPC 的具体证据。尤其 patch/DeepFake 的类池契约与 Agent 的工具 pre/post 回调，不能用简单改函数名完成迁移；需要教师提供可序列化行为接口与状态可见性边界。

## 6 发布清单与迁移报告的补全字段

迁移执行人员应以数据库预览报告的 actual questionId/revision 为主键，补成可审核清单。每行至少登记：

| 字段 | 记录要求 |
| --- | --- |
| 实际题目 ID / 当前 revision / 状态 | 与数据库报告匹配；记录 seed 或历史数据库之间的差异。 |
| 基础/对抗、固定 role、scenarioId | 描述型旧 A/D 需新建固定角色任务；保留旧资料关联。 |
| 原模板/数据/权重来源与摘要 | 注明来自 checkout、教师标准包或受控部署备份，标出缺失/不一致。 |
| 新环境 packageId / digest / evaluationVersion | 与冻结发布快照和相反角色兼容版本对应。 |
| RPC 转换接口与能力 | 权重是否必需、输入输出/分批大小、教师 API、模型池配置。 |
| 自测编号及实际环境 | 正确提交、无效材料、基线低/等/高、完整对手、异常/超时清理；注明实际 Docker/GPU/LLM证据。 |
| 基础历史成绩处理 | 是否同题变化清零、保留原有效分或另建新题；记录时间戳估算警告，旧晚到结果不得恢复失效分。 |
| 历史攻防算法处理 | 按当前规则验证后入池；缺代码/权重/身份或版本不兼容的记录只留审计，不生成正式动态成绩。 |
| 阻塞/责任人/发布结论 | 列 MIG-* 具体阻塞、所缺资产及验收负责人；待转换题不得标为已上线。 |

建议优先完成无外部资产的 ACT-01 与五道模块编程题，再转换已有完整基础模型数据的实践题和四道 managed Agent 文本场景。真实模型攻防、教师服务及专业质量指标在资产补齐后验收。这是实施优先级，不把 PRD 的蒸馏或动态攻防范围改成可选功能。

本盘点未决定任何生产题目发布状态，没有执行历史成绩重建。实际发布清单、不中断任务处理和迁移窗口继续由数据库差异报告、目标环境验证和出题人标准样例共同确认。
