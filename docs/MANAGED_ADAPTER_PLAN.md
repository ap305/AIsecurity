# 模型类六题 Managed Adapter 设计方案（backend+blank 合并判题）

> 状态：设计稿，尚未切换任何课堂题目；六题仍走 legacy 引擎。
> 目标：在不影响课堂的前提下，把 6 道模型类场景（patch_attack / mnist_backdoor /
> mnist_poison / watermark_image / deepfake_image / deepfake_audio）接入
> “backend + blank 合并 → 跑 7z test.py → metrics → 平台成绩”的受管判题。

## 0. 原则与红线

1. 默认版本与默认行为不变：六题 `judgeMode=legacy` 保持不动；
2. 每个场景的受管版本只有通过“metrics 对齐验收”后才置为 ready 并允许切换；
3. 每题都可一键回退 legacy（已有能力）；
4. 学生代码一律非 root 运行（uid/gid=1000、HOME=/tmp、无网络、tmpfs），禁止以容器 root 执行合并产物；
5. 判题超时与并发有明确上限，不能因学生并发把课堂服务打挂。

## 1. 现状（已核实，来自 7z 实际代码）

| 场景 | attack blank 符号 | defense blank 符号 | backend 是否含 MARKER | test.py 期望导入 | metrics 关键字段（样例） |
|---|---|---|---|---|---|
| mnist_backdoor | `def attack` | `def defend` | 是 | `from attack import attack` / `from defense import defend` | attack_score, attack_qualified, defense_score, defense_success_asr_thresh |
| mnist_poison | `def attack` | `def defend` | 是 | 同上 | effective_asr, recovery_rate, untargeted_asr, actual_poison_rate, poison_rate_limit（无现成 score 字段，需按规则换算） |
| patch_attack | `class GradientPatchAttack` | `class ResNet18Classifier` | 是 | ATTACKS/GradientPatchAttack/…; ResNet18Classifier | final_attack_score, final_defense_score, attack_qualified/valid, defense_qualified, AUROC/FPR |
| watermark_image | `def attack` | `def defense, detect` | 是 | `from attack import attack`; `from defense import defense, detect` | 包内 results/metrics.json 为空，需实际跑出后再定映射 |
| deepfake_image | `class JPEGReencodeAttack` 等 | `class Defense` 等 | 是 | build_attack_pool/JPEGReencodeAttack; Defense/PixelStatDefense/FIXED_DEFENSE_POOL | defense_score, per_attack_asr |
| deepfake_audio | `class CodecAttack` | `class Defense` | 是 | build_attack/default_pool; Defense | 输出为嵌套 scores，需按 EER/AUC/门槛换算 |

结论：
- 四道 MNIST/Agent 类可用“顶层函数”契约，但函数名/模块名不同（backdoor/poison 的 defend 与 agent 的 defend 签名不同但同名为函数）；
- patch/DeepFake/watermark 是**类对象契约**（attack 池、Defense 池），blank 不是“一个函数”而是“一个类”，合并位置与校验方式不同；
- 全部场景 backend 均带同一标记行，因此“合并”本身可复用，差异集中在：
  1) 期望符号校验；2) 合并产物模块名/内容；3) test.py 调用参数；4) metrics→成绩映射；5) 运行时间与资源。

## 2. 架构：在通用 runner 之上加 adapter 注册表

### 2.1 目录结构

```
judge-assets/managed/<scenario>/
├── v1/code/…            # 已导入的 7z 资产（数据在服务器，不入 git）
├── v2/code/…            # 后续版本（含修正/适配后的参考资产）
├── current              # 场景默认版本
└── version.json         # 增加 adapter 字段
```

代码侧：
```
services/quiz-svc/src/lib/
├── managedJudge.ts          # 通用 runner（已有）
└── managedAdapters/
    ├── index.ts             # scenario -> adapter 注册表
    ├── mnist_backdoor.ts    # 示例
    ├── mnist_poison.ts
    ├── patch_attack.ts
    ├── watermark_image.ts
    ├── deepfake_image.ts
    └── deepfake_audio.ts
```

### 2.2 version.json 扩展

```json
{
  "scenario": "patch_attack",
  "version": "v1",
  "ready": false,
  "adapter": "patch_attack",
  "timeoutMs": { "attack": 420000, "defense": 900000 },
  "stage": { "attack": ["--stage", "attack"], "defense": ["--stage", "defense"] },
  "scoreMapping": {
    "attack": "…（等 metrics 实跑后填）",
    "defense": "…"
  }
}
```

`listManagedVersions()` 仅把 `ready:true` 的版本展示为可切换；六题在 ready=false 阶段列表可见但标“未就绪/不可切换”，保证不误操作。

### 2.3 Adapter 接口（草案）

```ts
export interface ManagedAdapter {
  scenario: string
  roleFiles: Record<Role, string>            // 读取哪个 blank
  requiredSymbols: Record<Role, RegExp[]>    // 校验 blank 必须包含的符号
  moduleOut: Record<Role, string>            // 合并后写成 attack.py / defense.py / …
  buildBlank?: (raw: string) => string       // 若 blank 需要包装/类池化
  buildArgs: (role, versionMeta) => string[] // test.py 参数
  parseMetrics: (raw) => { score, status, detail }
}
```

### 2.4 六题 adapter 要点（逐题）

1. **mnist_backdoor / mnist_poison（最简单，先做）**
   - 与 Agent 一致：把 blank 的 `attack/defend` 插入 backend MARKER，写 `attack.py/defense.py`；
   - 差异仅在 metrics 字段与资格判定：
     - backdoor：`attack_qualified ? round(100*attack_score) : 0`；`defense_success_asr_thresh ? round(100*defense_score) : 0`；
     - poison：metrics 没有现成 score，需要从 `effective_asr/recovery_rate/untargeted_asr/poison_rate_limit` 按赛题规则换算，先用“与 7z 自带结果一致”作为验收基准；
   - 运行时：CPU 训练 8000/2000 样本，数十秒级；需评估并写 timeout。

2. **watermark_image**
   - blank 为 `defense(sample)+detect(request)`（注意不是 defend）；`defense` 在这里是“嵌入端”，`detect` 是检测端；
   - 包内附带 full defense.py 与 blank 不一致（full 用 embed/detect），以 blank+backend 合并后为准；
   - 需要先用合并产物实际跑出 metrics（当前包内 results 为空），才能定 scoreMapping；
   - 验收时还要解决“参考实现从哪里来”：blank 默认是 pass，需要参考实现用于对照（可来自平台现有 watermark engine 或赛题文档）。

3. **patch_attack**
   - blank 为类：攻击 `class GradientPatchAttack`，防御 `class ResNet18Classifier`；
   - 合并后 test.py 才能解析 ATTACKS / ResNet18Classifier；需校验类名并做 AST 安全检查；
   - metrics 用 `final_attack_score / final_defense_score`（0~1，×100）并检查 `attack_valid/qualified`、`defense_qualified`；
   - 运行重：贴片优化 250 iter + ResNet18 8 epochs（CPU 分钟级），timeout 建议 attack 7 分钟、defense 15 分钟；需要 nginx/网关超时配合调大。

4. **deepfake_image / deepfake_audio**
   - blank 为类（JPEGReencodeAttack / CodecAttack、Defense）；
   - 后端已有攻击池/防御池与 FIXED_DEFENSE_POOL，学生类作为池成员被引用；
   - audio metrics 是嵌套 scores，需在 adapter 内计算 EER/AUC/门槛后给平台成绩，不能直接拿 score 字段；
   - 运行数据量大（image 35MB、audio 11MB），需数据缓存策略，避免每次判题重复拷贝大目录。

## 3. 运行与安全改造（任何一题切换前必须先完成）

1. **降权**：`runPython` 增加 `uid/gid=1000`、`HOME=/tmp`、白名单环境；禁止 root 执行学生合并产物（当前 Agent 已上线但为容器内 root，需一并修正）；
2. **数据缓存**：受管 code 目录只读挂载/复制一次，每次判题仅复制学生模块与写 results 的临时目录；用文件锁限制同场景并发（如每场景最多 2 个并发判题进程）；
3. **超时与队列**：version.json 提供 attack/defense timeout；超时按 error 处理并释放锁；nginx `proxy_read_timeout` 提升到覆盖最大判题时长（如 600s）；
4. **metrics 解析失败处理**：无 metrics 或字段缺失 → error 返回，不当作 0 分（避免误判学生）；
5. **一致性**：判题脚本固定 seed/版本、禁随机，保证同代码同分。

## 4. 迁移与验收流程（每题）

1. Adapter 落地 + 单测（blank 校验、合并产物可在本地跑通）；
2. 用“合并产物 + 参考实现”跑该题 attack/defense，记录 metrics；
3. 与 7z 自带结果（或平台现有引擎同输入结果）对照：score/资格/胜负一致；
4. 生成 scoreMapping 与 timeout，version.json 置 ready=false；
5. 沙箱回归（非 root、无网络、并发、超时）；
6. 在后台把该题 judgeMode 从 legacy 切到 managed，先由教师用测试账号复核；
7. 复核通过后才视为上线，失败随时回退 legacy（DB 一项切换，无代码变更）。

## 5. 实施顺序建议

1. 安全改造（降权+缓存+超时+队列），先修 Agent 四题的 root 运行问题；
2. mnist_backdoor、mnist_poison（函数式、最快见效果）；
3. watermark_image（补齐参考实现与 metrics）；
4. patch_attack（较重，单独验收）；
5. deepfake_image、deepfake_audio（对象式 + 自定义指标计算）。

## 6. 交付物

- 每题一个 adapter + version.json + 验收对照表；
- 文档更新：管理员后台显示各版本 ready/状态与最近一次自检；
- 全程默认不影响课堂：六题 legacy 保持不变，直到逐题验收通过并人工确认切换。
