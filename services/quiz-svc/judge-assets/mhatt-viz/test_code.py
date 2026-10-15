"""
多头注意力可视化实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 MultiHeadAttention 及参数常量。
- 检查：代码导入、MHA 结构（q/k/v/out_linear + num_heads）、前向输出形状、
  attention 权重 softmax 归一化，共 4 个测试用例。
- 不依赖 matplotlib；可视化图片检查已移除（评测环境无 matplotlib）。
"""

import sys
import importlib.util
from pathlib import Path

import torch


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
    return module


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    torch.manual_seed(42)

    student = load_student(code_dir)
    if student is None:
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    embed_dim = getattr(student, "EMBED_DIM", 128)
    num_heads = getattr(student, "NUM_HEADS", 4)
    seq_len = getattr(student, "SEQ_LEN", 10)

    passed = 0
    total = 4

    # 1) 代码导入成功（到这里即成功）
    passed += 1

    # 2) MultiHeadAttention 结构
    try:
        model = student.MultiHeadAttention(embed_dim, num_heads)
        ok = (
            hasattr(model, "q_linear")
            and hasattr(model, "k_linear")
            and hasattr(model, "v_linear")
            and hasattr(model, "out_linear")
            and getattr(model, "num_heads", None) == num_heads
        )
    except Exception as e:
        ok = False
        print(f"MHA 结构检查异常：{e}")
    if ok:
        passed += 1
    else:
        print("MHA 结构错误：需 q_linear/k_linear/v_linear/out_linear 且 num_heads 正确")

    # 3) 前向输出形状
    output, attention = None, None
    try:
        model.eval()
        x = torch.randn(1, seq_len, embed_dim)
        with torch.no_grad():
            output, attention = model(x)
        ok = (
            tuple(output.shape) == (1, seq_len, embed_dim)
            and tuple(attention.shape) == (1, num_heads, seq_len, seq_len)
        )
    except Exception as e:
        ok = False
        print(f"前向输出测试异常：{e}")
    if ok:
        passed += 1
    else:
        print(
            "前向输出形状错误：output 应为 "
            f"{(1, seq_len, embed_dim)}，attention 应为 "
            f"{(1, num_heads, seq_len, seq_len)}"
        )

    # 4) attention 权重 softmax 归一化（每行和为 1）
    try:
        row_sum = attention.sum(dim=-1)
        ok = torch.allclose(row_sum, torch.ones_like(row_sum), atol=1e-5)
    except Exception as e:
        ok = False
        print(f"归一化检查异常：{e}")
    if ok:
        passed += 1
    else:
        print("Attention 权重未正确 softmax 归一化")

    print(f"Tests Passed: {passed}/{total}")
    if passed >= 3:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
