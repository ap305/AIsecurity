# Teacher Workbench Implementation Plan

> For agentic workers: execute scoped parallel tasks with tests and a final independent review.

**Goal:** 实施已确认教学工作台，保持学生练习、成绩与线上任务兼容。

**Architecture:** 复用TeacherGrant、Classroom、QuestionSolution及既有只读逐题成绩服务；只新增受权限约束的读取接口和工作台，不迁移角色或成绩。

**Tech Stack:** React/TypeScript、Express/Prisma/PostgreSQL，现有node:test与HTTP验收工具。

**Spec:** `docs/superpowers/specs/2026-11-18-teacher-workbench-design.md`

## Global Constraints

不修改评分/题目/学生记录；讲解全平台登录可见；无作业功能；TeacherGrant保持附加权限；生产测试账号不进入正式统计；备份恢复与安全发布必做。

## Tasks

- [ ] 1. 班级工作台与成绩接口：classrooms服务/路由、lib/classrooms、Classes及专用组件。先验证权限、零分、最新失败与旧分、筛选导出、分页和草稿保护，再实现；GET `/classrooms/capabilities`返回`{canTeach}`，Classes接受workspace practice/teaching。GET `/classrooms/:id/scores`、POST导出可选filters保持兼容。
- [ ] 2. 角色导航：TeachingContext、ProtectedTeachingRoute、App、Sidebar、Topbar、Login、Help、UserManager及用户列表教师标记。先测会话/撤权/深链接，再接入权限、教学路由与筛选；不改变AuthSession评分身份。
- [ ] 3. 讲解工作台：questionSolutions路由/服务、TeachingSolutions页面、题解展示。先测所有权、撤权、全局公开、编辑冲突、撤回、旧版本，再实现GET `/teaching/solutions`与既有写操作复用。保留原最高分及隐私规则。
- [ ] 4. 集成：更新测试入口，全套前后端、类型检查，独立评审并修复重要发现。按需求逐项核对。
- [ ] 5. 发布：实测现网版本→备份恢复副本→三角色HTTP验证（现有记录不变、测试成绩与题解仅副本）→提交tag→干净构建→冻结候选→兼容桥接/排空→公网静态资源平滑切换→线上专用测试账号验收和清理→正式数据/队列/双域名核验。

## Review Focus

1. 撤权/停用后旧会话及页面不能继续获取班级成绩（任务1、2、3）。
2. 搜索、翻页、切班或账号切换的迟到响应不能覆盖新数据/草稿（任务1、2、3）。
3. 成绩已有有效分但最新任务失败、过期或运行中时，展示和导出不损失旧分（任务1）。
4. 高分题解隐私和旧版本约束不能因集中工作台被绕开（任务3）。
5. 发布期间新提交自然完成，旧静态资源及既有登录持续可用（任务5）。

## Progress

- 2026-11-18：基于干净发布worktree dd50c32 分工；主仓库未发布D02改动不在范围。用户再次确认完整业务方案，教师讲解全平台登录可见。
- 实现及交叉评审完成。最终本地测试后端419通过/2环境跳过，前端206通过；前后端类型检查通过。成员搜索、固定姓名列、权限刷新草稿保护、题解分页边界和撤权按钮已补齐。
- 当前生产仍为旧发布；下一步冻结tag构建，Linux备份副本验收，通过后安全上线。
