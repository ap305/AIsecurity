# 原十场景、20 道题恢复

本流程保留原题 ID、原数据、官方参考、门槛政策、训练预算和学生历史。旧服务器的 ready/published 状态只作历史证据，不能移植为新服务器的通过证明。新 state 必须重新生成 packageId、模型池 revision、40 次参考校准和 40 次冻结门槛验证；全部清理完成并通过才发布。

## 本地构建与传输

`build_restoration.py` 先将旧 ML build 的十个资产逐一与原 provenance SHA256/字节数核对，再运行现有 Bot/ML 构建器。输出 10 个私有环境包、20 条元数据、两份专用验收提交与资产来源记录。传输归档按所有文件 SHA256 去重，不使用符号链接或硬链接。

```powershell
python -B services/quiz-svc/legacy-conversion/build_restoration.py --asset-build-root .test-artifacts/ml-full-rpc-test3 --output .test-artifacts/course-20261016/legacy-restoration/build --archive .test-artifacts/course-20261016/legacy-restoration/legacy20.tar.gz --runtime-root /courses/legacy20 --image 127.0.0.1:15000/legacy/evaluator@sha256:25ccbe9e37022d795e55a91c206fd0e0333ea92064dc445ab8a6f000494b24e6
```

重复构建需选择新输出目录，并传 `--private-order-seeds <上次build>/ml/private-order-seeds.json` 保持冻结排列。整个归档都是管理员私有材料，不得放公开资源目录。上传归档和 `restore_bundle.py`，先核对归档 SHA256，再物化到新的目录：

```bash
python3 restore_bundle.py --archive legacy20.tar.gz --output "$STATE/built-courses/legacy20"
```

私有媒体种子仅在 grader 的 `evaluation-order.json` 中，未列入 worker 文件白名单。音频/图像先收集 clean 和所有 attacked 样本再混排推理；贴片将验证集与实际对抗集混为一次无标签批次；水印对正负分支攻击输入与检测输入分别混排。可信裁判还原索引计算原公式。所有四组媒体题提高 evaluation version，必须重新校准。

## 新服务器准备

1. 使用原生产库副本和原 `uploads`、`resources`、账号及认证配置；不要运行 seed/reset，不要覆盖历史文件。
2. 新 API 的镜像允许列表加入上面的完整 digest，并验证其镜像配置 ID 仍为 `sha256:bb3ee30c5b38c6974260387d2f0ba4de6b89c9d3954cae420ad346ea81853e4c`。必须同时配置真实 relay digest、Docker/Compose、workspace 的宿主机路径与模型网关。旧依赖镜像自带公开 ResNet18 ImageNet 权重，不能换成新课程镜像或随机权重。
3. 新建仅管理员可读的 `$STATE/conversion-token.txt`、`$STATE/model-config.json` 和 reports 目录。模型配置只用 credentialEnv 引用既有环境凭据；禁止把密钥放 JSON。三类真实模型 Bot（Support/Agenda/Web）必须通过实际模型网关，ChatOps 不需要模型。
4. 数据库原20题须仍为 published/managed/v2，ID 完整；当前 definition 为空是此次转换的输入。其余48基础题、60待发布题不在此转换范围。

## 四阶段命令

以下使用部署者实际 `$RELEASE`（含当前 converter 及 node_modules）、`$STATE`、`$NODE_IMAGE`，并假定内网 API 已在 14004 启动。`$STATE/built-courses` 映射 `/courses` 与元数据一致。每个阶段成功退出后才运行下一阶段；可重复同一阶段恢复已完成的精确配置证明，不能同时运行两个转换器。

```bash
stage=prepare # 依次改为 calibrate、verify、publish
docker run --rm --network host \
  -v "$RELEASE:/app:ro" -v "$STATE:/migration" \
  -v "$STATE/built-courses:/courses:ro" \
  -w /app/services/quiz-svc "$NODE_IMAGE" \
  node node_modules/tsx/dist/cli.mjs scripts/convertLegacyQuestions.ts \
  --metadata /courses/legacy20/bots/metadata.json \
  --metadata /courses/legacy20/ml/questions.json \
  --api http://127.0.0.1:14004/api \
  --token-file /migration/conversion-token.txt \
  --model-config /migration/model-config.json \
  --state /migration/reports/legacy20-new-server.json \
  --acceptance /courses/legacy20/acceptance/manifest.json \
  --concurrency 2 --stage "$stage"
```

已完成且清理干净的失败尝试可在确认原因修复后加 `--retry-failed`；运行中或未清理的任务不能覆盖。发布前复制 ready state 留档。发布门禁先检查全部20题；publish 必须全范围，不可通过 `--only` 绕过。所有阈值仍采用 ≥，正常失败计入分母；ChatOps 零参考胜率沿用已批准的至少1/20下限。固定硬门槛不能降低，两份独立 acceptance 仅用于验证，不参与参考阈值校准。

发布后至少核对20题为10对固定角色、definition.packageDigest 与本次冻结证据相同、资源可读、模型池版本没变、无残留评测容器/工作区。完整真实学生提交验收 `scripts/acceptanceLegacyCourses.ts --rehearsal` 会新建测试账号和提交，只能在独立演练库运行，不能直接在生产副本运行。

## 历史兼容与只读验收

新版 `routes/matches.ts` 继续提供 `GET /api/matches/uploads?scenario=<原场景>&role=solo_attack|solo_defense`，按登录用户的原 userId 读取 `services/quiz-svc/uploads/matches/history.json`，只返回文件名、时间、大小、版本和归档状态。前端 `LegacyUploadHistory` 根据原题/场景映射调用该接口。保持目录挂载、账号 ID 和认证密钥；统一 Submission 为0不妨碍历史列表。旧 uploads 原文件目录全部留存。

原 `scores.json` 只保留历史事实，不直接灌入新版 ArenaScore/BasicScore，也不能从累计 UserScore 推导逐题成绩。旧 POST /matches/upload、run、submit-inline、validate 返回410并引导统一 /api/submissions；恢复新题定义后才具备真实可提交条件。不会恢复旧容器内直接执行学生代码的旁路。

可使用 `scripts/verifyTeachingInteraction.ts` 配合现有管理员/学生令牌做只读检查。若账号没有真实新提交，报告应为未覆盖，不伪报提交验收通过。
