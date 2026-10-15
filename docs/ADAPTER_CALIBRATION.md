# Managed Adapter 指标校准记录（v2 参考实现实测）

> 数据来源：v2 受管资产在判题容器内用完整参考实现 `python3 test.py --stage attack|defense` 产出。
> 状态：2026-09-11 已按校准口径放开 5 道模型题 v2 并全部切换为 managed v2；4 道 Agent 题以 v1 资产提升为 v2（代码同源），课堂默认判题版本统一为 v2。

## 切换记录（2026-09-11）

- 模型题：`mnist_poison / watermark_image / patch_attack / deepfake_audio / deepfake_image` 的 `v2/version.json` 置 `ready:true`，`current` 指向 `v2`（`mnist_backdoor` 此前已就绪）。
- Agent 题：`supportbot / agendabot / webbot / chatops` 由 v1 资产复制为 v2 目录（`ready:true`，代码同源，仅版本号提升），`current` 指向 `v2`。
- 题库：20 条对战题目记录统一 `judgeMode=managed, judgeVersion=v2`。
- 学生端：`apps/web/src/lib/managedBlanks.ts` 由服务器 v2 blank 资产导出，Arena 学生模板改为该契约（避免 legacy 模板与 v2 合并判题不匹配），编辑器本地缓存前缀升级为 `arena_code_v3_`。
- 冒烟验证：`supportbot` 攻击 blank 运行返回受管评测结果；`mnist_poison` 攻击用最小有效实现完成受管评测（空 blank 因返回 `None` 会按预期报错）。

## 参考实现基线得分（当前 adapter 口径）

| 场景 | 角色 | 关键实测指标 | adapter 得分（拟） | 备注 |
|---|---|---|---|---|
| mnist_backdoor | 攻击 | attack_qualified=true, attack_score=0.988 | 99 | 参考实现可过线 |
| mnist_backdoor | 防御 | defense_success=true, defense_score=0.988 | 99 | 参考实现可过线 |
| mnist_poison | 攻击 | attack_success=false, acc_drop≈0.011（<0.05 阈值） | 0 | v2 参考攻击未过线，学生需更强投毒 |
| mnist_poison | 防御 | recovery_rate=1.0, effective_asr=0.0 | 100 | 参考防御恢复良好 |
| watermark_image | 攻击 | attack_success=true, attack_strength=0.296 | ~74 | 阈值待按官方口径对齐 |
| watermark_image | 防御 | detect_success_rate_id_d0=1.0 | 100 | 参考检测通过 |
| deepfake_image | 攻击 | qualified=false, mean_asr=0.917（质量约束未过） | 0 | 攻击需同时满足质量/伪装约束 |
| deepfake_image | 防御 | defense_score=0.643 | 64 | 参考防御（Frequency/Pixel pool） |
| deepfake_audio | 攻击 | per_attack AttackScore=97.3/12.2/0 | ~36 | 均值口径，可再按难度加权 |
| deepfake_audio | 防御 | robust AUC/EER（defense 文件） | 按 AUC/EER 换算 | per_attack 无 DefenseScore，用 robust 兜底（已修复） |
| patch_attack | 攻击 | attack_qualified=false, gain=0.185（<0.40） | 0 | 参考攻击未过线 |
| patch_attack | 防御 | GPU（RTX4090）实测 582s 完成；defense_qualified=false、defense_defense_score=0.566、unseen_defense_score=0.512 | 0 | 参考防御未过资格线（FPR 过高），学生需更强防御 |

## 使用说明

- 校准目标是“参考实现/典型基线能给出符合教师预期的分数”，同时学生越强分越高；
- 目前得分口径已在 [managedAdapters/index.ts](../../AIsecurity/services/quiz-svc/src/lib/managedAdapters/index.ts) 实现；
- 待教师确认阈值（尤其 watermark/patch/audio 与 poison）后，再逐题 `ready=true` 并切 managed。
