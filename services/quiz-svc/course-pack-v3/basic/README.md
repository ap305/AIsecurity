# v3 基础 17 题隔离适配

`build(source_root, output, image, reference_weights=None)` 静态构建17个`platform-rpc-v1`环境包，返回供全局构建器归一化的中间清单，并生成`manifest.json`与`questions.json`。`output`必须为空；`reference_weights`可提供`B17.pt`等教师标准权重。构建只读取、解析和复制原题，不导入或执行原题Python。

```text
python build.py --source <解包根目录> --output <新输出目录> --image <批准镜像摘要> --reference-weights <标准权重目录>
python -m unittest discover -s tests -v
```

可信评分端保留原`basic_evaluator.py`、原数据集及教师参考实现，通过课程专属桥接调用隔离worker。`grade.py`不加载学生模块或权重；`bootstrap.py`只在学生worker里执行提交、以`weights_only=True`读取参数并strict加载。张量转换成平台已有受限NumPy协议；对象只以本次worker的随机句柄标识，不使用pickle或跨边界执行代码。公共平台RPC不需修改。

| 题目 | 隔离方式与原口径 |
| --- | --- |
| B01/B03/B05/B11/B12/B14/B16 | worker构建学生网络、严格加载自己的参数；可信端保留数据、标签及原准确率聚合 |
| B02 | 激活函数与输入梯度在worker运行；函数值/梯度的8项解析参考比较在可信端 |
| B04 | COCO教师模型只在可信端加载；学生通过有界模型调用能力执行原run_inference，框/标签/置信度与独立参考数值比较；不暴露其他教师资产 |
| B06 | worker提供参数形状及字符表，可信端形成heldout输入及下一字符标签；上传参数不进入可信端 |
| B07/B08 | 学生生成器/判别器在worker，教师对照与质量聚合留在可信端；B08输入梯度检验只给worker公开判别器结构和数值参数，不执行教师任意对象 |
| B09 | 数据形式的Q表赋给学生代理；真实迷宫环境与最短路算法留在可信端；只调用choose_action，不训练 |
| B10 | 固定20回合CartPole环境在可信端，学生DQN仅返回Q值；不用mock环境 |
| B13 | 数值state_dict从worker传到可信参考网络，原五项数值/形状对照保持 |
| B15 | 两个学生模型准确率平均；增强变换诊断在worker执行，仅传公开单图，不影响评分公式 |
| B17 | 真实Bert结构、本地配置和tokenizer在worker；测试文本按原固定随机子集送入学生Dataset，真实标签留在可信端，避免原单进程实现把标签交给学生Dataset |

原题的基础分数均为0–100。正常错误答案可以得到0分；接口错误、权重损坏、超时和平台故障使用平台现有不计分错误状态。B08梯度算法错误仍按原0.85系数处理。B17不把随机初始化权重伪装为已微调的标准参考权重；原包缺该文件时清单明确`missingAssets`，发布门禁不能略过。

资源以`student/`为候选范围，逐题派生安全下载包：Iris/MNIST/RNN/AGNews正式test文件替换为训练集抽样；RNN混合总CSV移除；LSTM只导出原seed42划分的训练文本块；Cora移除全部节点标签源文件，并只保留60%训练节点标签、用`label_mask`声明有效位置。改变逐项写入清单`resourceTransformations`和ZIP内说明，本地自测指标明确不代表正式评分。后台标准答案、测试脚本及`backend/weights`不进入资源ZIP。评测worker只挂模板依赖的公开代码/配置，不挂数据集、隐藏评分代码或整份学生下载包。

本地已用真实Torch 2.13、torchvision 0.28及生产RPC协议，以独立grader/worker进程完成B01–B17参考验收：分数依次为100、100、95.55、100、92.85、52.49、50.90、46.11、100、100、86.74、89.92、100、99.22、96.20、95.93、89.74609375。低于100的参考分数来自原题真实模型表现，并未提高或伪造。B17在真实AGNews训练集4000条上微调2轮；训练流程自检1024条子集准确率90.91796875%，正式评分原固定随机1024/7600子集得分89.74609375，两者子集不同，保留正式实测分数。权重437992817字节，SHA256为`17d44684774dbebf4b74079c42c921602d9bfef854888c994bb1518c9e5f945c`，训练出处记录在预处理目录`B17-provenance.json`。`tests/rpc_smoke.py`用于此数值集成验证，不代表Docker挂载/网络隔离已经验证；上线仍须逐题运行平台容器自测。B10真实20回合平均奖励500，manifest明确高频RPC预算。

`result_contract.py`把原题诊断转为最多100个扁平有限数值，布尔指标转0/1、说明字符串不进入平台协议。所有保留的真实推理结果经同一formatter重放并调用TypeScript `validateEvaluationResult`验证；新的RPC harness直接传完整`definition.evaluation`并逐次调用该校验器。`tests/local_resource_smoke.py`已检查全部17份下载包的学生模块/数据模块导入，且所有需权重题的真实训练参数都通过原本地导出脚本成功生成并读回平台参数格式；B17真实微调产物也已完成同一导出验收。这验证本地路径和导出格式，不宣称重复训练了全部模型。

RPC harness每次创建空Torch/HF缓存，并在grader和worker中禁止非loopback的Python socket连接。B04、B16、B17已在此条件下通过，分数为100、95.9333、89.74609375，TS协议校验通过。B04构造明确`weights=None, weights_backbone=None`，仅加载私包COCO权重；B16使用自定义网络，不依赖预训练下载。B17从随包配置构造BertModel并加载上传权重，tokenizer明确`local_files_only=True`。
