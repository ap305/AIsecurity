# D02 原题评测恢复：实现与校准进度

截至2026-10-27，本记录是进行中证据，**不是上线完成报告**。范围为用户上传原始D02评测逻辑、公开150/隐藏150样本；保持已确认的PRD最终胜率及四题真实响应快照政策。

## 已实现并验证

- 新候选版本 `v3-261012-d02-original300-v12`。原 `test.py/defense.py/dataset.py/attack.py` 不改；恢复原作者DataIsolationDefense，不含空注入直通。
- 原Top-K、三项权重、cleanRankShift≤5及cleanValidRate≥0.99不变。原始参考函数AST提取后SHA-256为 `9b941cd0b0d19b8bad5ace3e70cf628837b8e7c52c810fe688f83b0b64c64b5a`。
- 仅D02增独立模型池预算3600及显式 `executionProfile=d02-original300-v12` 的24小时上限；其他题仍受原1000次、1小时上限。单请求超时、模型、推理参数及未知结果不自动重试政策未变。
- 新D02和旧A02仅共享受限的Pool/Slot版本；算法、任务、成绩仍保存真实评测版本。导入器、成绩汇总与失效清理同步。
- 独立重任务worker及分页分发隔离D02长任务，普通worker不会被其队头占住。重任务容器部署必须设置至少25小时停止宽限，并保留现有任务自然结束机制。
- 题面明确300样本、原作者参考及“100−RankShift得分越高越好”。候选元数据中的旧20样本/旧时限声明亦已修正，保留历史来源说明。
- 独立完整后端回归331项：329通过、0失败、2项平台环境跳过。主代理另跑54项重点回归：53通过、0失败、1项Docker环境跳过；TypeScript通过。原题恢复Python专项11项通过。

## 独立真实环境

- 当前生产API仍为 `v20261027-40-admin-test-accounts`，D02仍revision2/v11；77题保持发布。
- 新独立目录 `/home/zl/ai-security-d02-original-20261027`，API14008、独立数据库15440。校准API不启动worker，不领取学生任务。
- 候选源码目录 `/home/zl/ai-security-v3-20261016/releases/v20261027-42-d02-original300-candidate`。
- 构建 `/home/zl/ai-security-v3-20261016/build/full-build-production-d02-original300-v12r3`。原v11构建保留；其他76题、68包及321份资料保持原字节。
- r2→r3仅修正 `build-evidence.json` 与 `adversarial/manifest.json`；根manifest、包内全部文件、参考代码和题目定义完全一致。根manifest SHA-256 `a4c2a75bcf8a310bec9020706a47e3a53b122bfc0ed9e9138e8d5c55c0c75e03`。
- 隔离包ID `767cc170-8473-45c8-8184-9c7c940a9fe7`。
- 新独立模型池 `e1d14a3d-6bfe-4f4b-bdbd-0234b3849825` revision1，仍 `Qwen/Qwen3-8B`。该新池元数据已由正常管理员API创建并同步到克隆库；**生产题目尚未绑定它，其他池未改**。
- 管理员只走已授权正常登录；没有读取生产认证签名密钥或自签管理员令牌。

## 真实校准证据

首次原规模基线自测 `8a25da49-3bc6-49e6-a1dc-e7269c701bfd`，北京时间19:52:37–19:55:27：

- 9次请求、9次上游调用；前8次合法真实响应已保存。
- 第9次上游超时，脱敏日志 `model_upstream_failure/reason=timeout/status=null`；不是学生接口错误或门禁不通过。
- 自测 `system_error/cleanupStatus=cleaned`。未产生完整300样本分数，不能据此前缀宣称原参考通过或失败。
- 此轮隔离进程采用串行、无额外间隔以实测耗时；现网35000毫秒节奏从未修改。

北京时间20:01:36启动第二轮受控恢复：克隆进程也恢复现网35000毫秒冷请求间隔；保留首次失败证明和8条合法响应，不覆盖历史或缓存响应。通过既有校准refresh机制绑定仅元数据修正的r3输入。仅恢复一次已清理系统异常，失败后不自动无限重试。

主要状态：

- `state/calibration-state-v12r3.json`（r2原状态仍保留）。
- `state/reports/d02-original-calibration-progress.json`。
- `state/reports/d02-original-calibration-timeout1.json`。
- 控制器容器 `ai-security-d02-original-calibration-20261027`。
- 本地只读监控 `.test-artifacts/course-20261016/d02-monitor-original-calibration-20261027.sh`，由 `remote-v3.py --sudo` 调用。

## 上线前仍须完成

1. 全量原参考校准完成；若原清洁门禁失败，停止发布，不降低门槛、不加回空注入特判。
2. 按实测冻结新阈值，执行新配置的正式baseline/opponent自测及隔离学生路径验收；区分真实上游与快照命中，不能以旧20样本证明代替。
3. 通过现有安全桥接/排空流程部署新API和独立heavy worker；不强杀在评测任务，不改用户数据库结构。重任务停止宽限至少25小时。
4. 备份并使用 `expectedQuestionDigest` 和事务内严格守卫更新D02。初审D02仅5条历史失败提交、0有效成绩、0slot；发布前须重新核对，若新增有效记录不可沿用此无成绩方案。
5. 保留旧5条提交、其冻结快照及旧包；发布本身不触发A02重算，不删除旧成绩。验证其他76题定义、原有成绩指纹、学生提交队列及公网健康。

当前尚无新阈值、最终验收或上线成功证据。隔离校准的上游仍与正式模型服务共享；不能把独立队列说成独立外部模型算力。
