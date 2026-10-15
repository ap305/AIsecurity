"""
LSTM 文本生成实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 LSTMTextGenerator。
- 检查 LSTM 层、Linear 层、forward 输出形状、参数数量，共 4 个测试用例。
- 不依赖数据集与训练；仅做结构与前向形状检测。
"""

import sys
import importlib.util
from pathlib import Path

import torch
import torch.nn as nn

VOCAB_SIZE = 65
EMBED_SIZE = 64
HIDDEN_SIZE = 128
SEQ_LENGTH = 100
BATCH_SIZE = 4


def load_student(code_dir):
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
    if not hasattr(module, "LSTMTextGenerator"):
        print("测试未通过：缺少 LSTMTextGenerator 类")
        return None
    return module


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    torch.manual_seed(42)

    module = load_student(code_dir)
    if module is None:
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    try:
        model = module.LSTMTextGenerator(VOCAB_SIZE, EMBED_SIZE, HIDDEN_SIZE)
    except Exception as e:
        print(f"测试未通过：模型实例化失败：{e}")
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    passed = 0
    total = 4

    # 1) LSTM 层
    ok = (
        hasattr(model, "lstm")
        and isinstance(model.lstm, nn.LSTM)
        and getattr(model.lstm, "batch_first", False) is True
    )
    if ok:
        passed += 1
    else:
        print("LSTM 层检查未通过（需 nn.LSTM 且 batch_first=True）")

    # 2) Linear 输出层
    ok = hasattr(model, "fc") and isinstance(model.fc, nn.Linear)
    if ok:
        passed += 1
    else:
        print("Linear 输出层检查未通过（需 nn.Linear）")

    # 3) forward 输出形状
    try:
        x = torch.randint(0, VOCAB_SIZE, (BATCH_SIZE, SEQ_LENGTH))
        output = model(x)
        expected = (BATCH_SIZE, SEQ_LENGTH, VOCAB_SIZE)
        ok = tuple(output.shape) == expected
    except Exception as e:
        ok = False
        print(f"forward 执行失败：{e}")
    if ok:
        passed += 1
    else:
        print(f"forward 输出形状应为 {expected}，实际 {tuple(output.shape) if 'output' in dir() else 'N/A'}")

    # 4) 参数数量
    try:
        total_params = sum(p.numel() for p in model.parameters())
        ok = total_params > 0
    except Exception:
        ok = False
    if ok:
        passed += 1
    else:
        print("参数数量检查未通过")

    print(f"Tests Passed: {passed}/{total}")
    if passed >= 3:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
