# PRD V1.1 独立评测部署与验证

评测入口为 `services/quiz-svc/src/services/composeJudge.ts`。平台只执行自行生成的 Compose；上传的 `compose.yaml` 仅接受 `evaluator` 镜像、固定 Python 命令、工作目录和三个无敏感信息的 Python 环境标志。自定义宿主命令、Dockerfile 构建、挂载、端口、设备、特权、host 网络及 capabilities 均不能由环境包提供。

## Linux 宿主进程部署

可信调度服务需要可用的 Docker Engine、Compose v2 CLI、Node.js 及平台已批准的 Python/课程镜像。先由部署人员加载镜像，任务使用 `--no-build --pull never`。学生容器不访问 Docker socket。

设置可写包目录和每任务工作目录：

```text
EVALUATION_PACKAGE_ROOT=/var/lib/ai-security/evaluation-packages
EVALUATION_WORKSPACE_ROOT=/var/lib/ai-security/evaluation-workspaces
EVALUATION_ALLOWED_IMAGES=python@sha256:<部署核验后的真实摘要>,<其他批准的固定摘要镜像>
EVALUATION_REQUIRE_IMAGE_DIGEST=1
EVALUATION_RELAY_IMAGE=python@sha256:<批准的relay Python镜像真实摘要>
```

环境包 manifest.image 与 relay 镜像必须进入允许列表；启用摘要策略时，两者都必须以 `@sha256:` 固定。示例中的 `python:3.12-slim` 用于开发；生产先解析核验镜像摘要并更新 manifest，不依赖可能移动的 tag。包内容摘要、题目版本和评测配置版本分别冻结。

manifest 必須声明 `protocol: "platform-rpc-v1"`，未迁移的直接导入学生模块包会被拒绝。可信 grader 使用固定 `platform_student.invoke(worker, function, args, kwargs)`；学生与对手在不同 worker 中运行，各自只挂自身只读代码与参数。worker 没有 grader 的题目包、context、结果目录，也不共享另一 worker 的网络或token。学生模型加载自身 `/materials/weights.bin`；返回值以受限JSON传给grader，默认请求/响应各1MB，manifest.rpc 可按题声明至16MB。RPC采用本次实际执行deadline，不额外施加隐藏的60秒超时。GPU与其他序列化格式尚需部署和题目契约支持。

模型网关传入题目固定的 `modelGateway.url/token`。URL 为兼容 base 路径，relay 仅代理 POST `chat/completions`；平台可提供 `http://host.docker.internal:4002/api/evaluation-gateway/<submissionId>`。Linux 下 relay 设置 `host.docker.internal:host-gateway`。若网关部署于其他机器，应传入从 Docker 容器可达的批准地址，不能使用容器自身的 `127.0.0.1`。

grader 分别连接学生lane、对手lane与可选网关lane；每条lane均为独立 internal 网络。worker 只连接自身lane。可信 relay 另接任务专属 egress 网络，并只转发到固定网关 URL；真实网关 token 仅挂给 relay。grader 获得随机本地 relay token，worker 不得到平台、供应方或relay凭证。网关仍须固定模型、限制调用并验证任务归属；relay 默认单任务上限32次，题目固定参数 `maxModelCalls` 可调整至不超过1000。

## 调度服务自身容器化

Docker CLI 位于可信调度容器内；调度服务可访问其专用 Docker daemon 或受保护的 daemon socket。该访问能力不传给学生容器。建议将调度服务与公开 API 分离，用内部任务队列调用，不让一般业务处理器取得 Docker 权限。

必须将工作目录映射到宿主固定路径，避免 Docker daemon 看不到调度容器内的路径：

```text
可信服务挂载：/var/lib/ai-security/evaluation-workspaces:/evaluation-workspaces
EVALUATION_WORKSPACE_ROOT=/evaluation-workspaces
EVALUATION_WORKSPACE_HOST_ROOT=/var/lib/ai-security/evaluation-workspaces
```

runner 在服务内创建只读材料、固定启动脚本和受控 compose.json，挂载源则按 `EVALUATION_WORKSPACE_HOST_ROOT` 转换为 daemon 可见路径。所有任务文件必须位于同一映射工作目录下。包目录与上传材料目录由可信服务读取，学生容器仅看到当次冻结副本。

若 Docker daemon 在远程主机，必须让上述宿主路径通过部署工具同步到该 daemon 所在主机，并保持一致映射；不能仅设置 DOCKER_HOST 就认为本地 bind mount 会自动复制。提供远程 daemon 的实际材料传输后才能宣称远程运行验证通过。

## 异常和资源恢复

每次任务都有随机 Compose project 与 `attempt-*` 目录。成功、代码错误、超时、启动失败及结果协议失败均执行该 project 的 `down --volumes --remove-orphans`，随后删除经范围校验的当次目录。无任何全局 `docker prune`。

启动前写任务专属 `_cleanup/eval-<id>.json` 清单，内容为 project、工作目录、受控 Compose 和创建时间，不包含 API token。正常清理后删除清单；down 失败时返回 `cleanup_failed` 并保留清单。进程中断也保留清单。

服务启动及每30秒调用 `recoverPendingComposeCleanups()`。清单包含执行超时加60秒宽限的expiresAt，运行中且未到期的任务不会被恢复器停止；cleanup_failed立即可重试。恢复器以跨进程原子lock认领清单，只清理该project与经范围验证的目录，避免多实例重复删除。中断的恢复claim在60秒后可重新认领。部署人员应监测pending数量与清理错误，不能用停止日志代替完成清理。

## 自测与发布

包上传返回不可变 packageId 与 digest。管理员自测通过以下 API 创建、轮询：

```text
POST /api/admin/evaluation-packages                         multipart file=ZIP
POST /api/admin/evaluation-packages/:id/validate
POST /api/admin/evaluation-packages/:id/self-tests          {definition,category,role,code,phase,opponent?,weightFixture?}
GET  /api/admin/evaluation-packages/:id/self-tests/:testId
```

definition 是完整题目配置，必须绑定该packageId；category为basic/adversarial，基础题role为null，攻防题role为attack/defense。参数由definition.evaluation冻结，不能由单独parameters覆盖；baselineCode/baselineFixture/baselineWeightFixture取自同一配置。自测自身权重weightFixture及opponent.weightFixture只接受包内fixtures/相对路径。

代码/模型基础题需basic阶段证据；攻防题需分别具备baseline与opponent阶段证据。`getSuccessfulPackageSelfTest(packageId, phase, undefined, configurationKey)` 精确匹配包digest、完整配置hash、固定role、分类及模型配置revision，并要求正常完成、环境清理成功。发布时基线指标必须大于等于门槛，对抗指定指标须有限，基础分须在声明满分内。正常0%或单对手false仍是合法结果，不能当作运行故障。

网关自测从definition.llm.poolId冻结平台配置，不接受URL或密钥。独立evaluation-self-test-gateway以签名purpose:selftest凭证、testId、packageDigest和running状态鉴权；预算通过原子文件锁计次，模型由冻结poolBinding控制。公网或普通学生凭证不能调用该网关。对教师接口的自测与健康就绪状态仍由教师服务管理模块确认，不等价于GPU模型推理已经验证。

出题人还应使用正确答案、无效材料、超时案例验证题目契约。平台强制分开grader与学生执行容器，仅收集grader日志中的严格绑定结果，校验有限数值与合法范围。三个样例均通过固定RPC客户端调用学生函数；不在grader中导入学生模块。旧自定义main必须迁移到该接口。算法正确性、隐藏数据及对抗成功聚合条件由可信出题入口定义。

## 测试命令与验证边界

在 `services/quiz-svc` 运行：

```text
node node_modules/tsx/dist/cli.mjs --test tests/compose-package.test.ts tests/compose-runner.test.ts
```

覆盖 ZIP 穿越、符号链接、重复路径、压缩炸弹、伪造解压长度、Compose 高风险字段、不可变摘要、参数和结果绑定、有限数值、独立并发材料、每条分支清理、活跃任务保护和并发恢复认领。真实Python 3子进程运行RPC与求和、参数推理、双角色攻防样例，验证worker monkeypatch不改变grader函数。Python路径可通过EVALUATION_TEST_PYTHON指定；不可用时此项明确skip，不计为通过。

本机未提供 Docker daemon，真实 Compose、cgroup/网络/只读挂载、宿主路径映射、relay 连接、GPU/PyTorch 与供应方 LLM 调用均需要在目标 Docker 主机验证。命令执行注入测试不能代替这些检查。

目标Linux Docker主机上一键执行真实验收（在services/quiz-svc）：

```text
RUN_DOCKER_EVALUATION_TESTS=1 node node_modules/tsx/dist/cli.mjs --test tests/compose-runner.test.ts
```

PowerShell可分两行设置`$env:RUN_DOCKER_EVALUATION_TESTS='1'`再运行相同node命令。该验收要求daemon可访问且批准镜像预先可用，执行算法、隐藏材料不可见、参数推理及双worker真实对抗；失败报告真实故障，不能自动回退宿主Python或mock分数。Gateway、GPU、PyTorch课程题、镜像摘要和容器化宿主映射仍须按部署实际配置分别验证。
