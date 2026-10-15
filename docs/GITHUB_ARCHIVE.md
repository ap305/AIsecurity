# GitHub 作品归档与贡献者机制

## 目标

- 对战大厅「工程上传」的作品**全部归档**到平台指定的 GitHub 仓库（特定账号下）。
- 学生上传时必须填写自己的 **GitHub 账号**，归档提交以**学生本人身份**署名，
  从而让学生成为该项目/归档仓库的真实贡献者。

## GitHub 开源贡献机制（依据）

1. **贡献归属按 Commit 作者邮箱**：GitHub 在推送时按提交的 author email 归属到用户账户。
   - 2017-07-18 之后注册的账号，官方 noreply 邮箱格式为 `<user_id>+<login>@users.noreply.github.com`，
     该邮箱自动与该账号关联，因此用此邮箱作为 author 的提交会记入学生的贡献图谱，
     并显示在仓库 **Contributors** 页面。
2. **Contents API 支持指定 author/committer**：平台机器人（PAT）提交文件时，
   通过 `author: {name, email}` 将提交作者设为学生本人，`committer` 为机器人，
   形成「学生作者 + 机器人提交」的合法 Git 提交。
3. **标准开源贡献路径**（用于主平台仓库）：**Fork → 分支 → Pull Request → 合并**。
   - 学生 fork `AIsecurity` 仓库，创建分支提交改动，发起 PR，由教师审核合并；
   - 合并后学生即出现在主仓库 Contributors 列表；
   - 归档仓库的自动提交（以学生身份为 author）同时让学生成为归档仓库的贡献者。
4. **CONTRIBUTORS.md**：归档仓库自动维护贡献者名单（每位账号首次提交时追加一行）。

## 归档目录结构

```
<GITHUB_ARCHIVE_REPO>/
├── CONTRIBUTORS.md
└── submissions/
    └── <github账号>/
        └── <workDirId>/
            ├── solution.py
            ├── ... (学生作品文件，meta.json 与 __pycache__/node_modules/.git 除外)
            └── meta.json   # 归档元数据（账号/姓名/场景/角色/时间/文件清单）
```

## 配置（quiz-svc 环境变量）

| 变量 | 说明 | 默认 |
|---|---|---|
| `GITHUB_ARCHIVE_ENABLED` | `true`/`1` 启用归档 | `false`（关闭） |
| `GITHUB_ARCHIVE_TOKEN` | 机器人 PAT（需 `repo` 写权限；自动建仓库再加 `public_repo`） | 空 |
| `GITHUB_ARCHIVE_REPO` | 归档仓库，格式 `owner/repo` | 空 |
| `GITHUB_ARCHIVE_BRANCH` | 归档分支 | `main` |
| `GITHUB_ARCHIVE_BASE_PATH` | 归档根目录 | `submissions` |
| `GITHUB_ARCHIVE_CREATE_REPO` | `true` 时仓库不存在自动创建（公开） | `false` |
| `GITHUB_ARCHIVE_COMMIT_AS_STUDENT` | `true` 时以学生身份作为 commit author | `true` |
| `GITHUB_ARCHIVE_MAX_FILE_BYTES` | 单文件上限（GitHub API 100MB 限制） | 95MB |

严格模式：归档启用后，若 GitHub 写入失败，本次上传直接失败并提示重试，保证「全部归档」。

## 学生端流程

1. 学生在「工程上传」填写 GitHub 账号（用户名或主页链接，必填）；
2. 上传 zip → 平台解压/预检 → 自动归档到 `submissions/<账号>/<id>/`；
3. 归档成功后前端展示 GitHub 链接；
4. 学生 GitHub 主页出现该 Commit，归档仓库 Contributors 中出现该学生。

## 管理员启用步骤

1. 创建 GitHub 账号/机器人（或复用现有账号），生成 PAT：`classic` 需勾选 `repo`（写内容）+ `public_repo`（自动建仓库）+ `user`（读学生 id）；`fine-grained` 需给归档仓库勾选 **Contents: Read and write**（自动建仓库需勾选对应仓库的 Administration/写入权限），并在「测试连接」确认写权限探测通过；
2. 在 quiz-svc 容器环境变量中配置 `GITHUB_ARCHIVE_ENABLED=true`、`GITHUB_ARCHIVE_TOKEN`、`GITHUB_ARCHIVE_REPO`；
3. 重启 quiz-svc；学生上传后到仓库 `submissions/` 检查归档与 Contributors。

## 注意事项

- PAT 属于敏感凭据：只写入服务器环境变量，严禁提交到 git。
- 学生账号必须是真实存在的 GitHub 账号（平台会调用 `GET /users/{login}` 校验并获取 user_id）。
- 超过 95MB 的单个文件不会归档（会记录到 meta.json 的 `skippedLargeFiles`）。
- 若希望学生同时成为**主平台仓库**的贡献者：教师可在 GitHub 仓库 Settings → Collaborators
  邀请学生（Contributor 角色），或让学生按 Fork → PR 流程提交改进。