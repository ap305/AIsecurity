# v3 API 攻防适配

`build.py` 构建 16 对、32 道题：02、03、08、09、13、14–22、27、28。最终导入由全量 77 题清单负责，本目录不部署、不修改数据库。

```powershell
python build.py --source <解压的人工智能实验-v3-261012目录> --output <空输出目录> --image <冻结评测镜像> --bigram <审查并准备的bigram.pt>
```

输出 `manifest.json`、`api-pools.json`、32 个不可覆盖题包、32 份公开资源和私有参考提交。所有清单路径相对输出目录，包内文件逐个记录 SHA-256。构建时验证同一对 A/D 的教师逻辑、公开框架和模型池参数一致。

## 评分与校准

`qualificationMetric` 用于入池；题目原有硬门槛未满足时返回 -1，禁止将 -1 校准为允许入池的阈值。`successMetric` 用于判断是否击败一个实际学生对手。比较统一为 `>=`。平台最后汇总有效对手胜率，无对手100%，正常失败参与分母，运行异常和未过基线不计分。适配器从不输出题目总分。

构建产物标记 `requiresCalibration=true`，阈值为 null。发布前必须用冻结模型池、冻结数据、官方参考提交分别运行 baseline 和真实 opponent 阶段并保存完整测量证据，填入门槛和真实 `llm.poolId`，再验证相同提交通过。协议夹具测试不构成校准证据。

缺失的入池门槛沿用官方参考实测 `qualificationMetric`；原有误伤、正常效用、文本质量门槛始终保留。对抗门槛取官方参考配对的 `successMetric`。官方指标恰为0时使用清单中的 `minimumPositiveSuccessThreshold`，已有非零指标不抬高。离散成功率取至少一个有效样本成功的正下限，27/28按原指标四位小数舍入后的实际粒度计算；02按原 RankShift 四位小数精度换算成 RankShift/100 的正下限。该字段的依据记录在 `minimumPositiveSuccessReason` 中。有效分母使用返回的 `metrics.samples`：08仅有害样本、27/28为隐藏片段数，其余为固定试次/样本数。清洁门槛失败、模型错误或数据变化均不得写入有效校准。

| 题目 | 实际对手介入位置 | 指标 |
|---|---|---|
| 02 | 攻击文本→对手提示防御→固定评分模型 | 排序偏移/100；防御取补数 |
| 03 | 对手生成水印→攻击变换→同一对手检测 | 合格文本去水印成功率；防御取补数 |
| 08 | 攻击提示→对手防护→目标模型和裁判 | 越狱成功率；防御取补数 |
| 09 | 注入→对手防护→指令任务 | 攻击泄露且任务失败率；防御未泄露且任务正确率 |
| 13 | 投毒文档→对手清理检索库→问答 | 定向成功率；防御正确且未被定向诱导率 |
| 14–22 | 修改限定入口→真实对手工具调用防护 | 工具任务劫持率；防御取补数 |
| 27 | 攻击查询→对手系统提示和输出防护 | 可见机密片段覆盖率；防御取补数 |
| 28 | 攻击查询→对手检索/系统提示/输出防护 | 可见机密片段覆盖率；防御取补数 |

03保留语义相似度/有效文本比例、AUC≥0.80、质量保持率≥0.90；08保留正常任务效用≥0.80；02/09/13保留原清洁门禁；14–22保留合法工具调用误伤≤10%；27/28保留原攻击资格覆盖率、防御泄露上限、效用下降≤5个百分点。27/28学生返回的自报覆盖率、计数、分数全部忽略，只以可信环境中实际可见回复重算。

## 模型池

每对使用独立的全局模型池 `V3-261012-API-xx`，同一对攻防共用相同冻结模型/版本。`api-pools.json` 包含准确 `parameters`（systemPrompt、tools、max_tokens、temperature、seed、maxCalls），不包含地址或密钥。构建清单中的 `$llm` 仅为未完成绑定的标记，聚合时需依据 `poolKey` 写入实际ID，不能把所有题绑到一个不同参数的通用池。

03、08、27、28的池不得设置 `systemPrompt`：可信评测器需分别发出质量裁判/目标模型/对手加固后的系统提示。模型、版本、温度、预算仍由池固定，worker不可连接网关。02、13和14–22由池固定系统提示，工具题的工具集合也固定。09原评测没有系统提示，因此保持省略。上下文 `parameters.maxModelCalls=1000` 与池预算1000一致；超额或模型响应异常均为系统错误、不产生成绩。

## 隔离与资产

学生代码只在独立 `platform_student` worker 执行。两个worker挂载同一当前题包的公开树，因此包内提供双方框架，由可信grader传入角色后延迟加载。可信grader不导入学生代码，worker只接收白名单数据或能力回调；隐藏答案、攻击目标和模型凭证不进入公共材料。

03可信bigram资产由固定200条自然文本按官方准备脚本生成，已审查的checkpoint SHA-256为 `c3e368cc510ffc00f85202abfd788974fb06a67c527cac7c8227f201d75b7d6d`。构建阶段将可信checkpoint转换为纯JSON计数，运行时不执行pickle、不训练或重新拟合。27/28防御的私有配置只通过该防御worker RPC初始化；攻击worker不接收秘密正文。27辅助诊断只基于已经实际返回给该攻击者的可见回复。

03的原水印、攻击后文本与无水印对照统一混排后检测，避免固定调用顺序泄露标签。每次新构建为该题对生成共享的私有256位排列键，计入冻结摘要，仅由grader持有；公开框架、下载ZIP和题目参数不含该键。新构建必须重新校准，不复用旧包的测量证据。统计时只由grader恢复原索引，指标公式保持一致。

## 验证

```powershell
python -m unittest discover -s tests -p 'test_*.py' -v
python tests/rpc_smoke.py --source <题包目录> --rpc <导出的platform_student与worker-template目录> --output <新测试目录> --bigram <可信bigram.pt>
python tests/production_smoke.py --build <build.py输出目录> --rpc <导出的RPC目录> --output <新测试目录>
python tests/production_smoke.py --build <build.py输出目录> --rpc <导出的RPC目录> --output <新测试目录> --block-openai-import
```

生产入口测试直接启动构建产物的 `grade.py`，传入完整 `definition.evaluation`，覆盖32道题、真实HTTP worker和模型网关协议夹具。冻结的 `sourceDigest`、`seed`、`maxModelCalls` 与门槛均在 `definition.evaluation` 顶层，运行时兼容旧嵌套参数。结果可在 quiz-svc 目录运行 `pnpm exec tsx course-pack-v3/adversarial/tests/validate_rpc_results.ts <测试目录/result-envelopes.json> <构建目录>`，使用平台真实结果校验器复核。

`--block-openai-import` 在正式入口禁止导入OpenAI SDK，验证隔离网关协议不依赖宿主机意外安装的SDK。原题CLI中的惰性SDK客户端不在平台评测调用链上。

单元测试覆盖真实对手参与、角色方向、异常不计分、>=边界、零胜率下限、非数值指标拒绝和平台结果结构。真实HTTP RPC测试覆盖全部16对、同包跨角色、防御合法任务/基线、隐藏字段拒绝、27/28伪造分数无效与公开代码不含秘密正文。测试模型为明确标注的固定协议夹具；正式模型效果、原题硬门槛和部署环境仍须在发布前实测。
