#!/usr/bin/env python3
"""
M2 标签投毒攻击 - 评测脚本

学生需在 student_code.py 中实现：
- poison_labels(y, poison_ratio=0.1, target_class=1, seed=42)
- detect_poisoned_samples(model, X, y, threshold=2.0)

调用方式：python3 test_code.py <student_code_dir>
"""

import sys
import os
import importlib.util
import traceback
import numpy as np


def load_student_module(code_dir: str):
    path = os.path.join(code_dir, "student_code.py")
    if not os.path.exists(path):
        raise FileNotFoundError(f"未找到学生代码: {path}")
    spec = importlib.util.spec_from_file_location("student_code", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MockModel:
    """模拟 sklearn LogisticRegression 的关键接口"""

    def __init__(self):
        self.classes_ = np.array([0, 1, 2])

    def predict(self, X):
        rng = np.random.default_rng(hash(str(X.tobytes())[:100]) % (2**32))
        return rng.integers(0, 3, size=len(X))

    def predict_proba(self, X):
        rng = np.random.default_rng(hash(str(X.tobytes())[:100]) % (2**32))
        proba = rng.dirichlet([1, 1, 1], size=len(X))
        return proba


def run_tests():
    results = []

    # 测试 1: poison_labels 函数存在性
    def test_poison_exists():
        try:
            student = load_student_module(sys.argv[1])
            if not hasattr(student, "poison_labels"):
                return False, "poison_labels 函数未定义"
            return True, "poison_labels 函数存在"
        except Exception as e:
            return False, f"加载失败: {e}"
    results.append(test_poison_exists())

    # 测试 2: poison_labels 正确翻转比例
    def test_poison_ratio():
        try:
            student = load_student_module(sys.argv[1])
            rng = np.random.default_rng(0)
            y = rng.integers(0, 3, size=1000)
            y_poisoned, idx = student.poison_labels(y, poison_ratio=0.1, target_class=1)
            y_poisoned = np.asarray(y_poisoned)
            # 检查比例是否接近 10%
            n_changed = np.sum(y != y_poisoned)
            ratio = n_changed / len(y)
            if 0.05 <= ratio <= 0.15:
                return True, f"投毒比例合理 ({ratio:.2%})"
            return False, f"投毒比例异常: {ratio:.2%} (预期~10%)"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_poison_ratio())

    # 测试 3: poison_labels 翻转目标类
    def test_poison_target():
        try:
            student = load_student_module(sys.argv[1])
            y = np.array([0, 2, 0, 2, 0, 2, 0, 2, 0, 2] * 10)
            y_poisoned, idx = student.poison_labels(y, poison_ratio=0.5, target_class=1)
            y_poisoned = np.asarray(y_poisoned)
            # 被翻转的样本应变成 target_class
            changed_mask = y != y_poisoned
            if np.all(y_poisoned[changed_mask] == 1):
                return True, "翻转目标类正确"
            return False, "翻转后标签不全是 target_class"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_poison_target())

    # 测试 4: detect_poisoned_samples 函数存在性
    def test_detect_exists():
        try:
            student = load_student_module(sys.argv[1])
            if not hasattr(student, "detect_poisoned_samples"):
                return False, "detect_poisoned_samples 函数未定义"
            return True, "detect_poisoned_samples 函数存在"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_detect_exists())

    # 测试 5: detect_poisoned_samples 返回布尔数组
    def test_detect_returns_boolean():
        try:
            student = load_student_module(sys.argv[1])
            model = MockModel()
            X = np.random.randn(50, 4)
            y = np.random.randint(0, 3, 50)
            result = student.detect_poisoned_samples(model, X, y)
            result = np.asarray(result)
            if result.dtype == bool and len(result) == len(y):
                return True, f"返回布尔数组 (shape={result.shape})"
            return False, f"返回类型异常: dtype={result.dtype}, len={len(result)}"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_detect_returns_boolean())

    # 输出结果
    passed = sum(1 for ok, _ in results if ok)
    total = len(results)
    print(f"Tests Passed: {passed}/{total}")
    for i, (ok, msg) in enumerate(results, 1):
        marker = "[PASS]" if ok else "[FAIL]"
        print(f"  Test {i}: {marker} {msg}")

    if passed >= total * 0.6:
        print("测试通过")
    else:
        print("测试未通过")
    print(f"Score: {passed / total * 100:.2f}")
    return passed, total, results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 test_code.py <student_code_dir>")
        sys.exit(1)
    try:
        run_tests()
    except Exception:
        traceback.print_exc()
        print("测试未通过")
        print("Tests Passed: 0/5")
