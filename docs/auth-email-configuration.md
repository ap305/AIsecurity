# 邮箱验证配置与验收

当前交付仅完成本地捕获 sender 模拟测试，未配置 SMTP，未向真实收件人发信。两个功能开关默认关闭；现有账号登录、密码和提交不增加邮箱门槛。真实发送和强制新注册邮箱只在配置及投递验收完成后同时启用。

运行环境要求 Node.js 20 或更高版本（当前生产为 Node.js 24）。邮件依赖固定为 Nodemailer 10.5.0，避免引入已披露旧版本问题；SMTP 配置以[官方文档](https://nodemailer.com/smtp)为准。

环境变量示例（全部凭据仅通过部署环境或 secret 注入；不要提交真实值）：

```dotenv
AUTH_EMAIL_ENABLED=false
AUTH_EMAIL_SEND_ENABLED=false
AUTH_EMAIL_SITE_ORIGIN=https://www.example.edu
SMTP_HOST=smtp.example.edu
SMTP_PORT=465
SMTP_USER=REPLACE_WITH_SMTP_USER
SMTP_PASSWORD=REPLACE_WITH_SMTP_SECRET
SMTP_FROM=teaching@example.edu
```

`AUTH_EMAIL_ENABLED=true` 时新注册必须提交邮件验证 token，旧账号继续原登录。`AUTH_EMAIL_SEND_ENABLED=true` 才允许真实 SMTP 发送；只打开前者但未完成 SMTP 配置会统一返回“尚未开放/尚未配置”错误，不声称已发送。465 使用直接 TLS；其他端口必须 STARTTLS（`requireTLS`），始终校验证书并要求 TLS 1.2 或更高。配置固定 HTTPS 站点 origin 和一个发件邮箱，不接受请求 Host 拼接链接。

申请统一返回受理状态，不代表送达，也不公开邮箱是否已有账号。符合条件的发送在事务外排队，单进程最多 2 个发送并发、16 个处理中/待发送任务。容量已满时仍统一受理并计入相同持久限频，但不签发链接或继续入队，记录不含邮箱/token的 `auth.email.capacity` 事件，避免通过容量错误探测邮箱是否存在。SMTP 失败只记录固定脱敏事件并失效该链接。队列位于内存，进程重启可能丢失尚未发送的任务；未收到邮件时用户可在 60 秒冷却后重试。SMTP 长时间异常应关闭两个开关并保留人工恢复。

Token 使用 32 字节随机数，只存 SHA-256 摘要，15 分钟有效、用途隔离且只能 POST 原子核销。链接凭据放 fragment，页面读取后移除地址栏 fragment；刷新后需重新打开原邮件。不存密码或 token 到 localStorage。恢复密码和绑定成功会递增 sessionVersion 并撤销教师租约，要求重新登录；恢复不能解禁、恢复被删除账号或重置管理员。

删除账号沿用既有逻辑，已验证邮箱不会自动释放或迁移给其他账号，避免误绑。被删除账号的邮箱不能重新注册或绑定；受审计的管理员邮箱释放流程不在本次范围，本次不清理孤立邮箱记录。

激活前由运维确认：

1. SMTP 用户、发件人和 TLS 证书正确；在授权测试邮箱验证实际收件、延迟、失败场景。
2. 按邮箱服务商要求配置并验证 SPF、DKIM、DMARC；核对正确的 HTTPS 站点地址。
3. 确认 SMTP 认证及应用访问日志均不会输出邮件正文、密码、fragment/token 或 SMTP 凭据；监控 `auth.email.send-failure` 脱敏事件。
4. 用授权测试账号走注册、旧用户绑定、换绑、恢复和重放，验证旧登录失效及账号状态不改变。
5. 在非生产环境验证开关关闭后原有注册、登录和提交兼容，再单独批准真实服务启用。

本地测试使用内存 PostgreSQL 和捕获 sender；不会接触业务数据库或真实 SMTP：

```powershell
pnpm --filter quiz-svc exec tsx --test --test-concurrency=1 tests/authEmail.integration.test.ts tests/emailSender.test.ts
pnpm --filter quiz-svc exec tsx --tsconfig ../../apps/web/tsconfig.json --test ../../apps/web/src/lib/authEmail.test.ts
```

实现依据：[Nodemailer SMTP 官方文档](https://nodemailer.com/smtp)。真实投递、域名认证和 SMTP 运维参数仍是外部验收项，模拟通过不证明实际投递成功。
