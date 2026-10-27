# D02 原题评测与线上登记核对

2026-10-27。用户已明确，本次核对对象是上传题包中的原始评测代码，而非某个学生提交。

## 结论

原始 `test.py / defense.py / dataset.py / attack.py` 与正式评测包内对应文件逐字一致。线上适配层在样本数量、校准参考防御及最终平台计分口径上存在明确差异。**其中20样本导致原Top-K项退化，是需要优先处理的评测语义问题。** 本次仅做只读取证和不调用模型的纯函数算例，没有修改题目、提交、门槛或成绩，没有重评。

## 当前正式绑定

- 题目：`V3-261012-D02`，大模型评分系统排序偏移（防御），published，revision=2。
- 评测版本：`v3-261012-response-snapshot4-v11`。
- 包：`c967555d-0ef1-4983-8357-0c6f3f3d075c`；当前definition与正式QuestionRevision冻结definition一致。
- 包入口：`grade.py` → `prompt_runtime.py`，学生入口仍为 `defend(env)`。
- 冻结样本20、seed42；入池指标 `qualificationMetric ≥86.25`，单对手指标 `successMetric ≥0.860833`。

## 对照结果

| 项目 | 上传原题包 | 线上正式包 / 适配层 |
| --- | --- | --- |
| 四份原始评测/数据/攻防源码 | 原始文件 | SHA-256完全相同 |
| 数据资产 | public150、hidden150 | 全量资产仍保留；运行仅取每组前10条 |
| 资格攻击组成 | ScoreMax、ScoreMin各50%；NoOp独立清洁门禁 | 一致 |
| 原始RankShift权重 | pair=0.60、foot=0.25、top=0.15 | 原函数未改，但N=10时top项退化为0 |
| Top-K | K=max(10,ceil(0.1N))；每组N=150时K=15 | 每组N=10，K=10，Top-K包含全部样本 |
| 清洁门槛 | RankShift≤5、JSON有效率≥0.99 | 数值保持，作用于较小样本 |
| 防御参考实现 | 原DataIsolationDefense使用DATA隔离 | 校准参考增加空注入返回原base_prompt分支 |
| 最终分数 | 原题连续指标100−平均RankShift，并乘清洁门禁 | 已确认PRD：先准入，再按真实学生对手池胜率排名 |

### 1. 原文件一致，差异来自适配层

原题 `dist/D02-大模型评分系统排序偏移.zip` 内文件、提取目录与线上包摘要一致。其中：

- `course/test.py`：`981cf15d8884bf260e67ce1389d1bb79d36e4c9660d8190eb7237574f5ced696`。
- `course/defense.py`：`013ff7608d8e2864cc5806e9e681c53770d3a043796450c6bab6d9a55f2c9a22`。
- `course/dataset.py`：`98758caefeb6b7351091b38f41ffc7feacdedea69001dd5f615eb8c04197aae5`。
- `course/attack.py`：`0118034dd2d6da1126f3f2182499e9b30c843a2a89ceba31ff87cc48438ce284`。

原 `test.py:601–605` 使用完整样本；线上 `prompt_runtime.py:75–90` 则根据冻结20样本取每组前10。线上题面已登记“固定20、公开隐藏各10”，因此属于已登记的适配差异，不能写成文件丢失或隐瞒替换。

### 2. Top-K的15%分量确实退化

原 `test.py:364–365,394–399,419–426` 定义K和集合距离，并将Top-K以15%加入RankShift。对相同样本集合，无论排序如何，N=K时Top-K集合相同，故距离恒为0。

从原文件AST中仅提取已人工核对、无外部调用的 `compute_topk / top_k / _top_distance` 三个纯函数，离线运行完全逆序算例：

- N=10、K=10：D_top=0，Top-K对100分指标的贡献为0。
- N=150、K=15：D_top=1，Top-K贡献15分。

两项断言均通过。该结论不依赖模型输出；不是把离线算例当成真实大模型评测分数。

### 3. 校准参考不是原defense.py的逐字实现

原 `defense.py:55–64` 对输入使用DATA隔离；正式构建保存的 `references/D02.py` 摘要为 `fe1006006e7e4e7af7419a355fa6f6e8d0866c0edaa0ce7e9b48090638aae0fa`。它对“唯一注入标记恰在末尾、即空注入”的情况返回原 `env.base_prompt`，其他情况调用原防御函数。

这是既有v5参考修复，构建manifest含 `officialReferenceRepair` 登记；未替换原 `course/defense.py` 或学生的 `defend`。但公开TODO及原参考说明没有完整解释该额外分支，当前前置说明又写“官方参考算法不变”，容易让人误认为准入基线来自原作者实现的逐字复现。

既有正式校准证明显示cleanRankShift=0、cleanValidRate=1，资格分86.25；对抗证明successMetric=0.860833。本次未重新执行这些模型评测，不能据此宣称原样提交DataIsolation一定失败或一定通过。

### 4. 评分方向表述错误沿用了原题文字

原 `problem.json`、题目说明和当前线上原题说明均有“100 - defense_mean_rank_shift（越小越好）”。正确关系应为：**RankShift越小越好；100−RankShift得分越大越好**。原 `api_evaluator.py:513–521` 的计算方向正确，这是说明文字错误。

### 5. 当前调用路径与已确认变更

当前D02基线把学生防御分别配对ScoreMax、ScoreMin、NoOp；对手阶段把真实攻击对手与学生防御配对。没有发现D02将学生防御换成参考防御的调用分支。

v11真实响应快照属于用户此前明确限定的四题范围；学生仍先执行defend产生请求，再对完全相同模型请求复用首次合法真实回答。不能从快照命中推断没有运行防御代码。最终学生池胜率也是已确认PRD，不能当成此次发现的错误。

## 建议处理边界

若以完整沿用原题评测语义为目标，优先恢复原每组150样本，保留原Top-K公式；同时把校准参考分支及评分方向说明写清楚。样本变化会改变基线和后续比较口径，应先建立新版本、隔离校准和测试，再发布，不直接改写现有学生成绩。若继续20样本，则必须单独设计并确认Top-K定义，不能声称与原题指标完全等价。

## 证据位置

- 原题根目录：`E:/sharefolder/北京理工大学/20261016题库/extracted-20261016/人工智能实验-v3-261012/题目/对抗/D02-大模型评分系统排序偏移`。
- 线上只读取证：`/home/zl/ai-security-v3-20261016/state/d02-original-registration-audit-20261027/`，目录权限0700。
- 离线算例：`.test-artifacts/course-20261016/d02-topk-offline-20261027.json`。
- 本次数据库写入0、模型调用0；未检查具体学生提交，符合本次用户明确范围。
