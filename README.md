# AI 安全教学攻防平台

面向学生的基础算法实验与 AI 安全攻防实践平台。当前代码已按 PRD V1.1 重构题目配置、版本、统一提交、基础排行榜、动态攻防评分、平台 API 池及两小时教师 API 租约。

后端为 `services/quiz-svc` 中的 Express/Prisma 服务，前端为 React/Vite 应用。题目评测通过独立 Docker Compose 环境执行，可信评测器与学生、对手程序使用 `platform-rpc-v1` 协议隔离调用；旧宿主 Python 判题入口已停用。

实现和本地测试不等于目标服务器已经上线。真实 Docker 隔离、模型/GPU、供应方服务和专业题库标准样例须按部署说明在目标环境验收。

## 文档

- [PRD V1.1 交付说明](docs/prd-v1.1-delivery.md)：业务规则、迁移和验收记录。
- [独立评测部署与验证](docs/prd-v1.1-evaluation-deployment.md)：Docker CLI、工作目录映射、RPC 协议、自测与真实容器检查。
- [实施记录](docs/prd-v1.1-implementation.md)：需求映射和实施范围。
- [旧题迁移盘点](docs/prd-v1.1-migration-inventory.md)：现有题目、代码/数据/权重依赖及逐题转换阻塞。
- [教学评测包示例](services/quiz-svc/evaluation-examples/README.md)：算法、模型推理与攻防包格式。
- [版本发布流程](docs/RELEASE_WORKFLOW.md)：现有发布管理约定。

## 开发准备

需要 Node.js 20 或更新版本、pnpm 9 或更新版本、独立开发用 PostgreSQL。实际评测另需 Docker Engine、Compose v2 和预先加载的批准镜像。Python 3 用于真实 RPC 进程回归测试。

建议先在宿主机运行后端和 Docker 评测器，数据库可以使用本地服务或独立容器。先配置开发数据库的 `DATABASE_URL`；首次创建管理员须显式设置 `ADMIN_PASSWORD`，已有管理员账号不因该变量缺失而改变。不要把真实凭据提交到仓库。

在仓库根目录执行：

```powershell
pnpm install

# 仅对已经明确选择的开发数据库执行结构迁移
pnpm --filter quiz-svc db:deploy

# 终端一：后端，默认端口 4002
pnpm dev:quiz-svc
```

另开终端启动前端：

```powershell
$env:VITE_API_TARGET = 'http://127.0.0.1:4002'
pnpm dev
```

前端访问 `http://localhost:50080`。显式设置代理目标可以避免沿用历史配置中的后端端口。后端 `PORT` 可单独配置，前端代理应与之保持一致。

`docker/dev-compose.yml` 是旧开发环境：其中 `quiz-svc` 使用普通 Node 镜像，只挂载源码，未提供 Docker CLI、daemon/socket 访问与评测工作目录的宿主路径映射，也未配置首次管理员初始化变量。直接启动它不能完成新判题。后端若需容器化，先按[评测部署说明](docs/prd-v1.1-evaluation-deployment.md)配置可信调度器的 CLI、受保护的 daemon 连接、工作目录映射和环境变量，再验证评分链路。学生容器不获得 Docker socket。

## 测试与构建

```powershell
pnpm test
pnpm build
```

测试使用 PGlite 临时内存 PostgreSQL 和本机回环 HTTP 服务，不连接已有业务数据库。它覆盖评分、版本清零、幂等与并发、租约恢复、权限、环境包和调度契约；真实 Docker 测试须在部署说明中的显式开关下执行。

构建会生成 Prisma 客户端并编译前后端；Windows 下先停止正在持有 Prisma 引擎的开发或预览进程，避免客户端生成时的文件锁冲突。需要单独检查后端类型时可运行 `pnpm --filter quiz-svc exec tsc --noEmit`。

## 题库迁移

旧提交、混合积分和归档材料保留审计。历史攻防算法须经过当前规则的基线和完整对手评测后入池；旧混合总分不直接作为基础排行榜成绩。未转换安全环境包的旧题不会回落到旧判题执行器。

`pnpm --filter quiz-svc migration:prd:preview --report=迁移报告.json` 默认生成只读差异报告。运行前明确配置目标数据库；只有显式 `--apply` 才重建新基础成绩表。生产迁移前备份数据库和材料、暂停提交、检查差异及时间戳估算项，并按交付说明确认回退步骤。

## 主要目录

```text
apps/web/                              前端大厅、解题和管理页面
services/quiz-svc/src/                  认证、题目、提交、评分、API 与租约服务
services/quiz-svc/prisma/               数据模型与迁移
services/quiz-svc/tests/                规则、数据库、HTTP 和评测测试
services/quiz-svc/evaluation-examples/  教学环境包示例
docs/                                  实施、交付与部署说明
docker/                                现有前端/开发容器配置
```
