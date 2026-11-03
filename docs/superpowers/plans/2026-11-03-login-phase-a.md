# 登录优化首期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. 按任务实施、测试及复核。

**Goal:** 在保留原账号、业务数据和客户端兼容的前提下，完成已批准方案 A 的登录可靠性、密码生命周期、服务端退出、登录保护和审计。

**Architecture:** 沿用 Bearer/HMAC、现有 User 主键及角色。新增认证专用表，不修改题目、提交或成绩定义；保留原密钥及 scoped token 验证。Cookie/MFA 属于后续 B，不在本次启用。

**Tech Stack:** React/TypeScript、Express、Prisma/PostgreSQL、PGlite 隔离测试。

**Spec:** `docs/superpowers/specs/2026-11-03-login-upgrade-proposal.md`

## Global Constraints

- 保留全部 User.id、username 精确匹配、角色、测试账号标识、旧散列及 sv 缺失=0。
- 不轮换持久化签名密钥，不重算成绩，不重发历史提交，不强杀评测任务。
- 旧登录继续接受原请求预算内的长密码，禁止 trim、截断或统一套用新密码上限。
- 新注册/自助改密 15–128 个 Unicode 字符；已有管理员测试账号创建契约保留，设置密码仍需合理上限。
- 认证异常仅明确失效清 token；断网、5xx、超时及普通权限不足不清草稿、任务引用。
- 用户随后确认“人工恢复默认密码”：只允许管理员人工重置；默认初始密码仅 15 分钟有效，重置后必须先改密，撤销旧会话。前端不再保存或硬编码初始密码，管理员仅从本次受保护响应获取。
- 公共自动找回关闭；不虚构联系人、不凭未验证手机号/可编辑资料自动恢复。恢复由管理员确认已线下核验后操作。
- 稳定错误码：40100 登录失效；40300 普通权限不足；42801 必须修改临时密码；42900 登录冷却；50300 身份服务暂不可用。
- 测试只用隔离数据库/测试账号；线上只允许新增隔离测试账号及其记录，不修改正式学生密码、成绩或任务。

## Review Focus

- 异步上传/租约初始化期间退出：落库前重查该凭据撤销及当前账号版本。
- 并发改密/退出其他登录：使用事务守卫，不能覆盖更新的密码或复活旧令牌。
- 旧缓存前端、旧长密码、旧格式令牌：继续兼容；新限权状态明确提示刷新改密。
- 断网恢复及多标签页账号切换：不把过期请求结果写到新账号，不清原草稿。
- 同校园 NAT 及伪造转发头：限流以账号为主、IP 辅助；仅可信入口传来的来源可参与，不影响提交 API。

## Task 1：后端认证安全与兼容

**Files:** `services/quiz-svc/src/lib/auth.ts`、`src/routes/auth.ts`，新增小型认证密码/限流 helper；`prisma/schema.prisma` 及只增迁移；确有需要的提交/租约二次会话检查调用点。测试 `tests/authSecurity.integration.test.ts` 及相关现有回归。

**Interfaces:**

- 保留 `/auth/login`、`/auth/register`、`GET/PUT /auth/me` 和既有响应包。
- `PublicUser` 可选增加 `lastLoginAt: string|null`、`mustChangePassword: boolean`。
- `POST /auth/logout` → `{ok:true}`，撤销当前 token（只存摘要）；幂等，失败不能报成功。
- `POST /auth/logout-others` → `{token,user}`，递增目标自身 sv 并替换当前 token。
- `POST /auth/change-password`，body `{currentPassword,newPassword}` → `{token,user}`。
- 现有 `PUT /admin/users/:id/password` 保留显式设置新密码接口，15–128 字符、目标 sv++、审计、旧凭据及租约失效，设置首次改密及 15 分钟有效期。
- 新增 `POST /admin/users/:id/password-reset`，body `{identityVerified:true}`，恢复原平台初始默认密码；返回 `{ok:true,temporaryPassword,expiresAt}` 仅展示一次，不写日志/浏览器持久化。仅此入口允许旧默认初始密码不满足新长度规则。管理员账号不可由此恢复。
- 限权会话只可读取 `GET /auth/me`、访问改密/退出及必要配置；其余业务/资料更新返回 42801。原始凭据过期拒绝登录或改密，需管理员重新重置；改密后移除限制，目标 sv 再递增并签发新会话。
- `GET /admin/auth-events?userId=...&limit=...` → 事件数组，仅管理员，限 100 条；不含密码/完整 token/请求体。
- `GET /auth/config` → `{manualResetEnabled:true}`。
- `hasCurrentSession` 如保持同步，则必须新增异步有效性检查并用于全部权限入口及上传/租约落库前检查，避免退出仅部分接口生效。

- [x] 先写失败测试：复制 token 退出失效、仅目标账号改密失效、旧 sv=0/长密码兼容、服务存储故障不误授权、在途评测 token 不受影响。
- [x] 执行失败用例并记录，再实现只增迁移、异步有界 scrypt、令牌撤销、事务改密、账号主导的短期冷却与脱敏事件。
- [x] 校验所有 requireUser/requireAdmin/userByPayload 及 hasCurrentSession 调用点；旧令牌未撤销且无新记录仍然有效。
- [x] 执行新增测试及原后端整套测试，报告具体命令/数量和任何未覆盖项。

## Task 2：前端认证恢复与账号安全交互

**Files:** `apps/web/src/contexts/AuthContext.tsx`、`src/components/ProtectedRoute.tsx`、`Topbar.tsx`、`src/pages/Login.tsx`、`Register.tsx`、`Profile.tsx`、`SolveQuestion.tsx`、`admin/UserManager.tsx`、`src/lib/api.ts`，新增必要的纯逻辑测试 helper 与样式。

**Interfaces:** 使用 Task 1 的 endpoint/字段；保留 AuthProvider/useAuth，新增 `sessionStatus`、`retrySession`、`changePassword`、`logoutOthers`。`logout` 改为异步并在 Topbar await；服务端不可达仍可本地退出但明确撤销未确认。

- [x] 先写失败测试：明确失效 vs 5xx/断网、returnTo 拒绝外站/反斜杠/编码绕过、跨标签页切换、请求过时不覆盖新身份。
- [x] 实现恢复中/已认证/匿名/暂不可验证的明确状态与可重试页面，恢复超时有界，失败按钮可重试。
- [x] 登录显隐/可访问标签/移动端布局；不限制旧密码长度；安全 returnTo 包含 pathname/search/hash，题目重登链接也带回原题。
- [x] 注册新密码 15–128，个人中心改密与退出其他登录，服务端确认后更新当前 token；保留原资料编辑。
- [x] 管理员保留手动输入独立新密码及确认，新增人工恢复初始密码（须确认核验身份），只从本次响应展示初始密码和到期时间；最近登录和安全事件查询。忘记密码仅提示联系授课老师/平台管理员，不虚构联系人或短信能力。
- [x] 新限权改密路由先于业务页面生效，保留 returnTo，首次改密后再进入题库。旧缓存页访问业务会明确提示刷新后改密，不能为兼容旧前端放宽权限。
- [x] 执行前端测试及 TypeScript 检查，确认所有 logout 调用点、fetch/XHR 认证契约、草稿和任务键未改变。

## Task 3：整体验证、版本控制和安全发布

**Files:** root `package.json` test:web 收录新测试；`docs/validation/2026-11-03-login-phase-a.md`；部署辅助脚本在本地忽略目录，不提交运行数据或凭证。

- [x] 核对当前生产版本/队列与正式数据快照，确定增量来源摘要；备份并在隔离库验证恢复。
- [x] 后端测试、前端测试、前后端类型检查、Prisma validate；新独立环境正式 API 测试登录→提交→结果、改密、退出、停启用和重登恢复，正式数据保持不变。
- [x] 独立代码审查：权限入口覆盖、撤销/改密竞态、限流与上游 scoped token 边界、旧客户端兼容和发布回退。
- [x] 只暂存明确源码/测试/文档，Git 提交与 annotated tag 后构建；净化 GitHub 只同步明确文件，不推私有历史/数据。
- [x] 使用既有桥接/排空，保留正在运行 worker 与原网关；迁移只有新增认证对象，失败不覆盖整库。
- [x] 公网 API JSON 验收与测试账号全流程，正式用户/成绩/题目原记录比对，记录实际结果后完成。

## 范围说明

此次先交付 A；B 的 Cookie/CSRF、设备列表、管理员 MFA 在 A 稳定后实施，不在本次突然切换。用户补充“人工恢复默认密码”已纳入首期：管理员人工操作，受限登录、短期有效、强制改密；不开放自动恢复或虚构核验联系方式。该补充覆盖原方案中人工恢复配置未齐全时暂缓的默认安排。
