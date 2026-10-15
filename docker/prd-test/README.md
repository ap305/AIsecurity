# PRD V1.1 服务器独立测试环境

本配置使用独立 Compose project `ai-security-prd-v11-test`，默认测试站50081、API14002、仅回环数据库15432。部署前检查这些端口空闲；不要覆盖旧站的50080/4002服务、源文件或数据库。

部署目录示例：`/home/zl/ai-security-prd-v11/releases/<tag>` 保存已提交版本及构建产物，`/home/zl/ai-security-prd-v11/state` 保存测试数据。Docker CLI、Compose插件和镜像路径须以实际服务器盘点为准。API是可信调度进程，需要Docker socket；任何学生执行容器都不会获得此socket。

部署用 `deployment.env` 包含 `PRD_RELEASE_DIR`、`PRD_STATE_DIR`、`PRD_NODE_IMAGE`、`PRD_POSTGRES_IMAGE`、`PRD_NGINX_IMAGE`、`PRD_DOCKER_BINARY`、`PRD_COMPOSE_PLUGIN` 和端口。真实密钥只写在服务器权限为0600的state配置文件，不得提交仓库或输出到部署日志。

`database.env` 设置随机 `POSTGRES_PASSWORD`、独立 `POSTGRES_USER`/`POSTGRES_DB`；`api.env` 设置指向127.0.0.1:15432的新库 `DATABASE_URL` 和显式管理员初始化账号/随机密码。`auth-secret.json` 提前建立为有效随机secret对象，避免缺少bind源时Docker把它建成目录。旧管理界面使用的 `llm-config.json` 和 `github-archive-config.json` 也要提前建立，初始内容均为 `{"enabled":false}`。它们只服务此测试环境，不复用旧站密钥；新版API池保存在独立数据库中。将nginx模板里的 `__PRD_API_PORT__` 替换为新API端口，保存到 `state/nginx.conf`。

提前创建独立 `state/uploads`、`state/resources`、`state/packages`、`state/workspaces` 目录；资源路由在服务启动时访问resources，上传/删除也需要写权限。需要教材文件时从已提交源代码复制到新resources目录；不要将旧站资源目录直接挂为可写。正式代码目录只读，运行数据均在state中。

在挂载只读release之前，还须在其 `services/quiz-svc` 下预建空的 `uploads`、`resources` 目录及 `auth-secret.json`、`llm-config.json`、`github-archive-config.json` 文件作为挂载目标。目标文件无需真实配置内容；实际配置由state文件覆盖。缺少目标时，runc可能无法在只读父挂载内创建嵌套文件挂载点而拒绝启动。

按顺序执行：

1. 校验Git提交/标签、归档摘要及目标目录，上传源代码和本地构建的前后端产物；源代码归档不包含业务上传、已有密钥、`.env`或旧node_modules。
2. 使用 `Dockerfile.runtime` 从Node24-bookworm-slim构建测试运行镜像，安装Prisma所需OpenSSL、进程回归测试所需Python3和pnpm11.25.0。在独立发布目录安装锁文件规定的Linux依赖，显式生成Prisma客户端。构建、生成Prisma和运行使用同一glibc镜像，禁止修改旧站依赖或上传Windows node_modules。启动前在该镜像中验证挂载后的 `docker version` 和 `docker compose version`。
3. 预加载获准Python镜像（示例使用 `python:3.12-slim`），记录实际镜像ID/摘要。runner不会自行拉取或构建镜像。
4. `docker compose --env-file deployment.env -f compose.yaml config --quiet`，先只启动database。
5. 使用新api配置运行 `prisma migrate deploy`，新库不运行seed/reset。若演练旧数据，仅针对备份副本，先保存迁移预览报告，再应用重建；不写回业务库。
6. 启动api和web，检查新旧站健康状态。通过真实HTTP自测/发布/提交验证算法、模型参数和动态攻防。
7. 保存验收JSON、版本、容器状态与脱敏日志。真实供应方模型/教师服务另列验证结果，不以模拟上游替代真实服务验收。

本服务器的Docker内部域名解析可能失败，不能以容器启动成功替代真实RPC验收。runner先启动本次任务的隔离worker，再校验容器/网络归属并将其内部IP写入评分上下文；评分容器仍只加入本次任务的internal网络，不依赖Docker DNS，不合并攻防网络，不给学生容器host网络。基础设施通信失败报告`system_error`，学生代码明确返回422才按学生执行错误处理，超时单独报告`timeout`。

远程脚本通过标准输入传给shell时，`docker compose run`等交互命令须使用`</dev/null`，避免吞掉后续部署命令。若官方Prisma引擎下载不可达，可复用同版本、同平台且已验证内部commit与SHA256的本地缓存；必须离线生成客户端并完成启动检查，不能把下载失败视为构建成功。新发布目录可复用上个已验证测试版本的Linux依赖，但必须先确认锁文件完全一致；不要复用Windows依赖。

HTTP验收脚本为 `services/quiz-svc/scripts/acceptancePrd.ts`。设置 `PRD_TEST_URL=http://127.0.0.1:14002/api`、`PRD_TEST_ADMIN_USERNAME`、`PRD_TEST_ADMIN_PASSWORD` 和 `PRD_TEST_REPORT`（可写绝对路径）后运行 `pnpm --filter quiz-svc exec tsx scripts/acceptancePrd.ts`。共42项验收，只创建随机前缀的测试用户/题目/提交，保留证据，不清理旧数据。覆盖三类环境包、6次真实Docker自测、发布门槛、统一提交、最高分/同分排序、模型上传、等于基线通过、无对手100%、正常失败0%、动态重算、版本清零、权限隔离及管理员逐题成绩。任意失败或依赖跳过均返回非零退出码；不能将脚本生成成功当作服务器验收通过。

真实Docker测试可在具有Docker CLI并能看到相同宿主临时目录的环境运行。若测试运行器本身在容器内，应把测试TMPDIR以同一绝对路径bind到宿主，避免测试创建的临时材料路径只存在于运行器容器；不要把正式API的workspace宿主映射套用到测试套件的随机临时目录。

回退只停止这个测试project，保留数据库、包及上传目录，不删除旧站资源，不执行全局prune，不使用 `down --volumes` 清空测试证据。
