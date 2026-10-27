# 管理员测试账号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 管理员在现有用户管理创建、停用、重新启用和删除测试账号，保留现有学生账号、提交、成绩与正常提交通道。

**Architecture:** 沿用 React 管理页和 Express/Prisma 认证。User 增加兼容默认值的测试标记、状态和会话版本；测试账号角色固定为 student，删除采用逻辑删除，停用/删除撤销登录与教师租约。测试评测保留自己的结果和槽位，但不进入正式排行/学生成绩列表，不增加正式攻防池版本或触发其他学生重评。

**Tech Stack:** React 18, TypeScript, Express, Prisma 5, PostgreSQL, node:test/PGlite.

**Spec:** 本文需求与接口约定；来源为 2026-10-27 用户请求。用户已授权非关键危险步骤自主执行。用户随后明确确认测试账号可提交评测，但不进入正式排行榜和学生成绩汇总。

## Global Constraints

- 不读取 auth-secret.json 签发或伪造管理员令牌；使用正常登录。
- 不使用 Playwright 或截图；通过真实 HTTP/JSON、组件结构、集成测试验收。
- 不改题目、评分公式、历史提交或已有学生成绩；不批量重试。
- 仅增加数据库列，旧用户默认普通、启用、sessionVersion=0，旧令牌保持可用。
- 不把测试账号加入正式攻防分母；停用、删除测试账号不得调用 invalidateArenaUserTx。
- 每个变更按文件提交；annotated tag 后构建部署；生产切换保持学生可提交，活动评测完成后切换 worker，备份并保留回滚。

## Interfaces

- User: `isTestAccount Boolean @default(false)`, `accountStatus String @default("active")`, `sessionVersion Int @default(0)`。
- PublicUser: 额外返回 `isTestAccount`, `accountStatus`，不返回 password/sessionVersion。
- POST `/api/admin/users`: `{username,password,displayName,school?}` -> envelope `{user: PublicUser}`；强制测试学生，禁止客户端角色提升。
- PUT `/api/admin/users/:id/status`: `{status:"active"|"disabled"}` -> `{user:PublicUser}`；仅测试学生。
- DELETE `/api/admin/users/:id`: 测试账号置 deleted、会话版本递增、撤销租约，历史记录和用户名保留；原普通账号语义保持。
- GET `/api/admin/users`: 不展示 deleted，其他合同兼容。
- 所有普通、管理员、资料和教师租约鉴权统一拒绝非 active，停用后再启用仍拒绝旧 token。

## Review Focus

1. 学生或匿名不能创建/停用账号，构造角色/测试标记字段不能越权。
2. 并发创建同名只产生一个账号；非法字段不写入；日志不泄露密码。
3. 停用前已取得的 token 和教师租约不能继续用，重新启用必须重新登录。
4. 测试账号提交、停用、删除不会改变正式池版本/分母、他人成绩或重评队列。
5. 管理页请求失败保留输入、成功后刷新；原用户操作和登录功能保持。

## Tasks

- [x] 1. 后端：先编写失败的账号生命周期/鉴权集成测试；实现增量迁移、管理员合同和审计、租约撤销及会话版本；验证现有认证回归。
- [x] 2. 前端：先编写请求合同/校验测试；实现创建表单、类型/状态标签、停用/启用、测试账号专用删除提示；保留旧操作。
- [x] 3. 隔离：以真实 PGlite 集成测试证明测试基础榜/模块榜/攻防榜/学生汇总过滤，以及攻防提交不触发正式重评；最小修改评分发布分支。
- [x] 4. 集成：Prisma generate/validate、前后端类型检查、相关测试和项目测试；独立审查修复关键问题；提交和 tag。
- [x] 5. 上线：只读复核生产 release/数据库/队列/域名；在隔离 release 生成新客户端和构建，测试迁移，备份后用兼容增量迁移与 worker-free bridge 切换；最后发布公网静态资源。
- [x] 6. 验收：正常管理员登录后创建唯一 smoke 测试账号，验证登录/停用/旧会话/启用/删除和权限拒绝；清理为逻辑删除，不提交正式题目或触发模型调用；比较已有记录指纹、新旧站健康并记录验证。

## Implementation rulings and evidence

- 正式统计隔离问题先采用推荐方案实施，用户随后明确确认。测试账号单向评测正式有效对手，自身不成为对手、不推进正式池版本、不触发其他学生重评。
- 删除保留历史和用户名；现有批量清空入口仅处理普通学生，避免绕过测试账号逻辑删除。普通账号删除语义保持。
- 三项独立审查 Important 均有确定性 RED→GREEN 及复核：批量清空绕过软删除、测试槽位失效推进正式池、教师租约在停用/启用窗口泄露新凭证。后者覆盖准备前、readiness等待及返回新nonce三个阶段。
- 新迁移只增加带常量默认值的三列；使用1000ms锁超时和5000ms语句超时，旧用户及版本0会话兼容。先迁移再启动新桥，旧API继续服务；回滚保留兼容列，禁止回灌旧数据库覆盖新提交。
- 最终本地 `pnpm test`：后端315项，313通过、2项环境跳过；前端55项全部通过。跳过项为真实Docker Compose和POSIX权限，目标Linux另验。前后端TypeScript、Prisma validate、diff检查通过。
- 使用现有功能开发分支派生 `feat/admin-test-accounts-20261027`；保留原有 `.superpowers/` 未跟踪工作，不纳入发布。
- 目标Linux74项回归全部通过；真实生产库副本迁移验证94个原账号及旧客户端兼容。已上线并完成9组公网生命周期验收，160份原提交及各成绩/题目/槽位行指纹保持；详见 `docs/validation/2026-10-27-admin-test-accounts.md`。
