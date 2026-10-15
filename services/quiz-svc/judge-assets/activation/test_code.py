"""
激活函数对比可视化实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 sigmoid/tanh/relu/leaky_relu。
- 检查函数值（与理论值比对）与梯度（数值差分与解析梯度比对）。
- 不依赖 matplotlib；学生函数可为 numpy 或 torch 实现（统一转 float 比较）。
"""

import sys
import argparse
import importlib.util
from pathlib import Path

import numpy as np


def to_float(v):
    arr = np.asarray(v, dtype=float)
    return float(arr.reshape(-1)[0]) if arr.size == 1 else arr.reshape(-1)


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


def approx(a, b, tol=1e-3):
    return abs(float(a) - float(b)) <= tol


def numerical_grad(f, x, h=1e-5):
    return (float(to_float(f(x + h))) - float(to_float(f(x - h)))) / (2 * h)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("code_dir", help="学生代码目录（含 student_code.py）")
    args = parser.parse_args()

    student = load_student(args.code_dir)
    if student is None:
        print("Tests Passed: 0/10")
        print("测试未通过")
        return 1

    required = ["sigmoid", "tanh", "relu", "leaky_relu"]
    for name in required:
        if not hasattr(student, name):
            print(f"测试未通过：缺少函数 {name}")
            print("Tests Passed: 0/10")
            print("测试未通过")
            return 1

    sig, tan, rel, lre = student.sigmoid, student.tanh, student.relu, student.leaky_relu
    pts = [-2.0, -1.0, 1.0, 2.0]  # 避开 0 点的梯度歧义

    passed = 0
    total = 10

    # 1) sigmoid 值
    ok = all(approx(to_float(sig(x)), 1.0 / (1.0 + np.exp(-x))) for x in pts)
    if ok: passed += 1
    # 2) tanh 值
    ok = all(approx(to_float(tan(x)), np.tanh(x)) for x in pts)
    if ok: passed += 1
    # 3) relu 值
    ok = all(approx(to_float(rel(x)), max(0.0, x)) for x in pts + [0.0])
    if ok: passed += 1
    # 4) leaky_relu 值（默认 alpha=0.1）
    ok = all(approx(to_float(lre(x)), x if x >= 0 else 0.1 * x) for x in pts + [0.0])
    if ok: passed += 1
    # 5) leaky_relu 负区间斜率为 0.1
    ok = approx(to_float(lre(-2.0)), -0.2)
    if ok: passed += 1
    # 6) sigmoid 梯度（数值 vs s(1-s)）
    ok = all(approx(numerical_grad(sig, x), (1.0 / (1.0 + np.exp(-x))) * (1 - 1.0 / (1.0 + np.exp(-x))), tol=1e-2) for x in pts)
    if ok: passed += 1
    # 7) tanh 梯度（1 - tanh^2）
    ok = all(approx(numerical_grad(tan, x), 1 - np.tanh(x) ** 2, tol=1e-2) for x in pts)
    if ok: passed += 1
    # 8) relu 梯度（正区间 1）
    ok = all(approx(numerical_grad(rel, x), 1.0, tol=1e-2) for x in [1.0, 2.0])
    if ok: passed += 1
    # 9) leaky_relu 梯度（负区间 0.1）
    ok = all(approx(numerical_grad(lre, x), 0.1, tol=1e-2) for x in [-2.0, -1.0])
    if ok: passed += 1
    # 10) 向量化：支持数组输入
    try:
        arr = np.array([-2.0, -1.0, 0.0, 1.0, 2.0])
        out = np.asarray(sig(arr), dtype=float).reshape(-1)
        ok = out.shape[0] == 5 and approx(out[0], 1.0 / (1.0 + np.exp(2.0)))
    except Exception:
        ok = False
    if ok: passed += 1

    print(f"Tests Passed: {passed}/{total}")
    if passed >= 6:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
