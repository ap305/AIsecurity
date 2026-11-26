# 只读演示账号

演示入口使用独立的 `/api/demo/` 服务。班级、学员和评测流程使用前端自带的合成示例。该服务只处理演示登录、恢复会话、退出与健康检查。运行它只需要 Python 3.10 或更高版本。

公网部署将 `server.py` 安装在 `/opt/ai-security-demo/`，将 systemd 单元安装在 `/etc/systemd/system/`。由主机在回环地址 18476 提供服务。`nginx-demo-maps.conf` 置于 Nginx 的 http 上下文，`nginx-demo-location.conf` 置于平台 HTTPS 的 server 上下文。演示登录令牌访问正式 API 时由网关返回 403。

开通或轮换时，由运维在仅限本人的目录中执行以下命令。工具会随机生成新口令，并独占创建两个文件。

```sh
umask 077
python3 create-credential.py credential.hash.json demo --generate handoff.json
```

将哈希文件以 root 所有、0600 权限安装到 `/etc/ai-security-demo/credential.json`。通过私密渠道交付 `handoff.json`。重启 `ai-security-demo.service` 即可启用新凭据并结束已有演示会话。停用时运行 `systemctl disable --now ai-security-demo.service`。演示服务独立运行，正式平台沿用自己的身份认证和评测队列。

回归测试使用 `python3 -m unittest discover -s services/demo-svc -p 'test_*.py'`。
