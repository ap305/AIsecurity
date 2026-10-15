"""
DQN CartPole 强化学习实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    Score: XX
    测试通过 / 测试未通过

说明：
- 评测环境无 gymnasium / matplotlib（DNS 限制无法安装）。学生代码顶层若 import
  这些库，本脚本先注入 mock 模块使导入成功，再仅用 torch 评测 DQN 网络结构。
- 从 <student_code_dir>/student_code.py 中查找 nn.Module 子类 DQN(state_dim, action_dim)。
- 用 judge-assets/dqn-cartpole/dqn_model.pth（参考模型）验证学生 DQN 架构兼容性，
  并检查前向输出、动作选择、Q 值合理性，共 7 个测试用例（满分 100）。
- 不运行 CartPole 环境（无需 gymnasium），reward 维度改为前向/Q 值检查。
"""

import sys
import os
import types
import importlib.util
from pathlib import Path

import torch
import torch.nn as nn

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
# 参考模型位于本资产目录下（judge.ts 以 cwd=assetDir 调用）
MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dqn_model.pth")
STATE_DIM = 4
ACTION_DIM = 2


def _install_mocks():
    """注入 gymnasium / matplotlib 的空 mock，使学生代码顶层 import 不报错。"""
    for name in ("gymnasium", "gym", "matplotlib", "matplotlib.pyplot"):
        if name not in sys.modules:
            mod = types.ModuleType(name)
            # gym.make 等在学生代码中仅在训练函数内调用，评测不会触发
            mod.make = lambda *a, **k: None
            sys.modules[name] = mod


def load_student(code_dir):
    _install_mocks()
    code_file = Path(code_dir) / "student_code.py"
    if not code_file.exists():
        print(f"测试未通过：未找到学生代码 {code_file}")
        return None
    spec = importlib.util.spec_from_file_location("student_code", str(code_file))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        print(f"测试未通过：学生代码加载失败：{e}")
        return None
    return module


def find_dqn(module):
    """在学生模块中查找 nn.Module 子类（优先名为 DQN 的）。"""
    candidates = []
    for name in dir(module):
        obj = getattr(module, name)
        if isinstance(obj, type):
            try:
                if issubclass(obj, nn.Module) and obj is not nn.Module:
                    candidates.append(obj)
            except Exception:
                pass
    # 优先名为 DQN 的类
    for c in candidates:
        if c.__name__ == "DQN":
            return c
    return candidates[0] if candidates else None


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/7")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    torch.manual_seed(42)
    total = 7
    passed = 0
    score = 0

    # 1) 学生代码导入（10 分）
    module = load_student(code_dir)
    if module is None:
        print("Tests Passed: 0/7")
        print("Score: 0")
        print("测试未通过")
        return 1
    passed += 1
    score += 10
    print("[√] 学生代码导入成功 (+10)")

    # 2) DQN 网络结构（20 分）
    DQN = find_dqn(module)
    if DQN is None:
        print("[×] 未找到 nn.Module 子类 DQN")
        print(f"Tests Passed: {passed}/{total}")
        print(f"Score: {score}")
        print("测试未通过")
        return 1
    try:
        model = DQN(STATE_DIM, ACTION_DIM)
        ok = isinstance(model, nn.Module)
    except Exception as e:
        ok = False
        print(f"[×] DQN(4,2) 实例化失败：{e}")
    if ok:
        passed += 1
        score += 20
        print("[√] DQN 网络结构正确 (+20)")
    else:
        print("[×] DQN 网络结构错误")

    # 3) 前向输出形状（15 分）：输入 (1,4) -> 输出 (1,2)
    try:
        m = DQN(STATE_DIM, ACTION_DIM).to(DEVICE)
        state = torch.randn(1, STATE_DIM, dtype=torch.float32).to(DEVICE)
        q = m(state)
        ok = tuple(q.shape) == (1, ACTION_DIM)
    except Exception as e:
        ok = False
        print(f"[×] 前向传播失败：{e}")
    if ok:
        passed += 1
        score += 15
        print("[√] 前向输出形状正确 (1,2) (+15)")
    else:
        print("[×] 前向输出形状应为 (1,2)")

    # 4) 参考模型文件存在（10 分）
    if os.path.exists(MODEL_PATH):
        passed += 1
        score += 10
        print("[√] 参考模型文件存在 (+10)")
    else:
        print(f"[×] 未找到参考模型 {MODEL_PATH}")

    # 5) 参考模型可加载进学生 DQN（15 分）—— 验证架构兼容
    loaded = None
    if os.path.exists(MODEL_PATH):
        try:
            m = DQN(STATE_DIM, ACTION_DIM).to(DEVICE)
            state_dict = torch.load(MODEL_PATH, map_location=DEVICE)
            m.load_state_dict(state_dict)
            m.eval()
            loaded = m
            passed += 1
            score += 15
            print("[√] 参考模型参数加载成功 (+15)")
        except Exception as e:
            print(f"[×] 参考模型加载失败（架构不兼容）：{e}")
    else:
        print("[×] 跳过模型加载（无模型文件）")

    # 6) 动作选择（15 分）：argmax 输出有效动作
    try:
        if loaded is None:
            loaded = DQN(STATE_DIM, ACTION_DIM).to(DEVICE).eval()
        state = torch.randn(1, STATE_DIM, dtype=torch.float32).to(DEVICE)
        with torch.no_grad():
            q = loaded(state)
        action = int(q.argmax().item())
        ok = action in (0, 1)
    except Exception as e:
        ok = False
        print(f"[×] 动作选择失败：{e}")
    if ok:
        passed += 1
        score += 15
        print("[√] 动作选择正常 (argmax -> 0/1) (+15)")
    else:
        print("[×] 动作选择异常")

    # 7) Q 值合理性（15 分）：批量前向输出为有限值且非全零
    try:
        states = torch.randn(8, STATE_DIM, dtype=torch.float32).to(DEVICE)
        with torch.no_grad():
            qs = loaded(states)
        ok = torch.isfinite(qs).all() and qs.abs().sum().item() > 0
    except Exception as e:
        ok = False
        print(f"[×] Q 值检查失败：{e}")
    if ok:
        passed += 1
        score += 15
        print("[√] Q 值合理（有限且非全零）(+15)")
    else:
        print("[×] Q 值异常")

    print(f"Tests Passed: {passed}/{total}")
    print(f"Score: {score}")
    if score >= 60:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
