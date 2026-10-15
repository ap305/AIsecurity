# 可运行教学环境包

三个目录可分别打包为 ZIP，根目录必须包含 `manifest.json`、`compose.yaml` 和 `main.py`；manifest 必须声明 `protocol: "platform-rpc-v1"`。旧脚本直接导入学生模块的包会被拒绝。
管理员可调用 `POST /api/admin/evaluation-packages/examples/:name` 导入示例，再保存返回的包 ID 到题目配置。

- `basic-algorithm`：学生实现 `def solve(values): return sum(values)`，覆盖空数组、负数和大数。
- `model-inference`：学生本地拟合线性函数，上传 JSON 权重 `{"weight":2,"bias":1}`；学生代码在 worker 中加载 `/materials/weights.bin`，实现 `def predict(x): return parameters['weight'] * x + parameters['bias']`。这是逐题指定 JSON 格式的真实参数推理样例；`.pt` 课程题需选择平台已允许且安装 PyTorch 的镜像，不自动把 JSON 权重当作 `.pt`。
- `attack-defense`：攻击题实现 `def attack(): return 'SECRET'`，防御题实现 `def defend(text): return 'BLOCKED' if 'secret' in text.lower() else text`。包内提供相反角色基线；正式单对手结果为布尔成功，资格门槛与跨用户百分比由平台计算。

入口接受 `main.py /input/context.json /output/result.json`。输入包含提交、尝试、题目版本、评测版本、阶段、固定参数和双方 worker 描述。可信入口使用 `from platform_student import invoke`，调用 `invoke(context['student'], 'solve', [values])` 或相反角色 `invoke(context['opponent'], 'defend', [payload])`。学生只执行自身代码；不在 grader 中导入学生模块。结果须原样带回所有绑定字段；基线返回数值 `qualificationMetric`，单对手返回布尔 `success` 和数值 `successMetric`，基础题返回合法 `score/maxScore`。平台仅收集 grader 的结果协议，学生日志不计分。

平台生成最终 Compose：每次评测独立项目、非 root、只读根文件系统、无额外 capabilities、禁止提权、限制内存/CPU/进程数；可信 grader、学生 worker、对手 worker 分开。两个 worker 分属不同 internal 网络，分别只挂自身材料和 RPC runtime；不挂题目隐藏包、grader context 或结果目录。grader 持双方 RPC token；学生不能读取另一 worker 的 token。模型调用只经过独立可信 relay，真实网关凭证不挂给学生或对手。RPC输入输出为按题目限大小的JSON，不自动支持任意张量对象；大型数据与GPU由具体题目和部署参数配置。

部署前由管理员准备允许的镜像，例如 `docker pull python:3.12-slim`。每次评测使用 `--no-build --pull never`，不会按学生或环境包命令在宿主机安装软件。GPU/新镜像加入允许列表须由部署配置完成。
