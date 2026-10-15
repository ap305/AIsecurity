#!/usr/bin/env python3
"""
M5 公平性评估 - 评测脚本

学生需在 student_code.py 中实现：
- demographic_parity(y_pred, sensitive_attr) -> dict
  返回 {"diff": <组间正预测率差异>, "ratio": <比率>}
- equalized_odds(y_true, y_pred, sensitive_attr) -> dict
  返回 {"tpr_diff": ..., "fpr_diff": ...}

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


def run_tests():
    results = []

    # 测试 1: 函数存在性
    def test_functions_exist():
        try:
            student = load_student_module(sys.argv[1])
            if not hasattr(student, "demographic_parity"):
                return False, "demographic_parity 未定义"
            if not hasattr(student, "equalized_odds"):
                return False, "equalized_odds 未定义"
            return True, "两个函数均已定义"
        except Exception as e:
            return False, f"加载失败: {e}"
    results.append(test_functions_exist())

    # 测试 2: demographic_parity 完美公平场景应返回 0 差异
    def test_dp_fair():
        try:
            student = load_student_module(sys.argv[1])
            # 完美公平：两组正预测率相同
            y_pred = np.array([1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0])
            sensitive = np.array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1])
            result = student.demographic_parity(y_pred, sensitive)
            if isinstance(result, dict):
                diff = result.get("diff", 0)
            else:
                diff = float(result)
            if abs(diff) < 0.01:
                return True, f"公平场景差异={diff:.4f} (应≈0)"
            return False, f"公平场景差异={diff:.4f} 应≈0"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_dp_fair())

    # 测试 3: demographic_parity 不公平场景应检测到差异
    def test_dp_unfair():
        try:
            student = load_student_module(sys.argv[1])
            # 明显不公平：组0 正预测率 0.9，组1 正预测率 0.1
            y_pred = np.array([1] * 9 + [0] * 1 + [0] * 9 + [1] * 1)
            sensitive = np.array([0] * 10 + [1] * 10)
            result = student.demographic_parity(y_pred, sensitive)
            if isinstance(result, dict):
                diff = result.get("diff", 0)
            else:
                diff = float(result)
            if diff >= 0.7:
                return True, f"检测到明显不公平 (diff={diff:.4f})"
            return False, f"差异过小 (diff={diff:.4f}) 应>=0.7"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_dp_unfair())

    # 测试 4: equalized_odds 返回 tpr_diff 和 fpr_diff
    def test_eo_returns_keys():
        try:
            student = load_student_module(sys.argv[1])
            rng = np.random.default_rng(0)
            y_true = rng.integers(0, 2, 200)
            y_pred = rng.integers(0, 2, 200)
            sensitive = rng.integers(0, 2, 200)
            result = student.equalized_odds(y_true, y_pred, sensitive)
            if isinstance(result, dict):
                if "tpr_diff" in result and "fpr_diff" in result:
                    return True, f"返回 tpr_diff={result['tpr_diff']:.4f}, fpr_diff={result['fpr_diff']:.4f}"
                return False, f"返回字典缺少键: {result.keys()}"
            return False, "应返回 dict"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_eo_returns_keys())

    # 测试 5: equalized_odds 完美公平场景
    def test_eo_fair():
        try:
            student = load_student_module(sys.argv[1])
            # 构造完美公平场景：两组的 TPR 和 FPR 都相同
            y_true = np.array([0, 0, 0, 0, 1, 1, 1, 1] * 2)
            y_pred = np.array([0, 0, 1, 1, 1, 1, 0, 0] * 2)
            # 组0: 前8个，组1: 后8个 - TPR 和 FPR 完全一致
            sensitive = np.array([0] * 8 + [1] * 8)
            result = student.equalized_odds(y_true, y_pred, sensitive)
            if isinstance(result, dict):
                tpr_diff = result.get("tpr_diff", 1)
                fpr_diff = result.get("fpr_diff", 1)
                if abs(tpr_diff) < 0.01 and abs(fpr_diff) < 0.01:
                    return True, f"公平场景: tpr_diff={tpr_diff:.4f}, fpr_diff={fpr_diff:.4f}"
                return False, f"差异过大: tpr_diff={tpr_diff:.4f}, fpr_diff={fpr_diff:.4f}"
            return False, "返回类型异常"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_eo_fair())

    # 测试 6: 真实数据场景
    def test_real_scenario():
        try:
            student = load_student_module(sys.argv[1])
            rng = np.random.default_rng(42)
            n = 1000
            y_true = rng.integers(0, 2, n)
            # 模拟模型对组1更准确
            sensitive = rng.integers(0, 2, n)
            y_pred = y_true.copy()
            # 给组0注入更多错误
            mask = (sensitive == 0) & (rng.random(n) < 0.3)
            y_pred[mask] = 1 - y_pred[mask]
            result_dp = student.demographic_parity(y_pred, sensitive)
            result_eo = student.equalized_odds(y_true, y_pred, sensitive)
            dp_diff = result_dp.get("diff", 0) if isinstance(result_dp, dict) else float(result_dp)
            eo_tpr = result_eo.get("tpr_diff", 0) if isinstance(result_eo, dict) else 0
            if dp_diff > 0.05 or eo_tpr > 0.05:
                return True, f"检测到真实场景中的偏差 (dp_diff={dp_diff:.4f}, tpr_diff={eo_tpr:.4f})"
            return False, f"未检测到明显偏差 (dp={dp_diff:.4f}, tpr={eo_tpr:.4f})"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_real_scenario())

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
        print("Tests Passed: 0/6")
