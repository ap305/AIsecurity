#!/usr/bin/env python3
"""
M3 成员推断攻击 - 评测脚本

学生需在 student_code.py 中实现：
- compute_loss(model, X, y) - 计算模型在样本上的 loss
- membership_inference(model, X_member, X_non_member, threshold=None)
  返回每个样本是否被判定为成员（布尔数组）

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
    """模拟一个分类模型，提供 predict_proba 接口"""

    def __init__(self, n_classes=3, seed=42):
        rng = np.random.default_rng(seed)
        self.n_classes = n_classes
        self.W = rng.standard_normal((4, n_classes)) * 0.5

    def predict_proba(self, X):
        logits = X @ self.W
        shifted = logits - logits.max(axis=-1, keepdims=True)
        exp = np.exp(shifted)
        return exp / exp.sum(axis=-1, keepdims=True)

    def predict(self, X):
        return self.predict_proba(X).argmax(axis=-1)


def run_tests():
    results = []

    # 测试 1: 函数存在性
    def test_functions_exist():
        try:
            student = load_student_module(sys.argv[1])
            if not hasattr(student, "compute_loss"):
                return False, "compute_loss 未定义"
            if not hasattr(student, "membership_inference"):
                return False, "membership_inference 未定义"
            return True, "两个函数均已定义"
        except Exception as e:
            return False, f"加载失败: {e}"
    results.append(test_functions_exist())

    # 测试 2: compute_loss 返回标量
    def test_loss_scalar():
        try:
            student = load_student_module(sys.argv[1])
            model = MockModel()
            X = np.random.randn(10, 4)
            y = np.array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0])
            loss = student.compute_loss(model, X, y)
            if np.isscalar(loss) or (hasattr(loss, "shape") and loss.shape == ()):
                return True, f"loss 返回标量 (={float(loss):.4f})"
            return False, f"loss 应为标量，实际 shape={getattr(loss, 'shape', type(loss))}"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_loss_scalar())

    # 测试 3: 成员样本 loss 通常低于非成员样本
    def test_member_lower_loss():
        try:
            student = load_student_module(sys.argv[1])
            rng = np.random.default_rng(42)
            model = MockModel()
            # 模拟成员样本（与训练分布相同）和非成员样本（分布偏移）
            X_member = rng.standard_normal((50, 4))
            X_non_member = rng.standard_normal((50, 4)) + 2.0  # 偏移分布
            y_member = rng.integers(0, 3, 50)
            y_non_member = rng.integers(0, 3, 50)
            loss_member = float(student.compute_loss(model, X_member, y_member))
            loss_non_member = float(student.compute_loss(model, X_non_member, y_non_member))
            if loss_non_member > loss_member:
                return True, f"成员 loss ({loss_member:.4f}) < 非成员 loss ({loss_non_member:.4f})"
            return False, f"成员 loss 不低: {loss_member:.4f} vs {loss_non_member:.4f}"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_member_lower_loss())

    # 测试 4: membership_inference 返回布尔数组
    def test_mia_returns_boolean():
        try:
            student = load_student_module(sys.argv[1])
            model = MockModel()
            X_member = np.random.randn(20, 4)
            X_non_member = np.random.randn(20, 4)
            y_member = np.zeros(20, dtype=int)
            y_non_member = np.ones(20, dtype=int)
            result = student.membership_inference(
                model, X_member, y_member, X_non_member, y_non_member
            )
            # 接受 dict 或 array
            if isinstance(result, dict):
                preds = result.get("predictions")
                if preds is None:
                    preds = result.get("member_preds")
                if preds is None:
                    return False, "返回 dict 但缺 predictions 键"
            else:
                preds = result
            preds = np.asarray(preds)
            if (preds.dtype == bool or np.issubdtype(preds.dtype, np.bool_)) and len(preds) == 40:
                return True, f"返回布尔数组 (shape={preds.shape})"
            return False, f"返回类型异常: dtype={preds.dtype}, shape={preds.shape}"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_mia_returns_boolean())

    # 测试 5: MIA 准确率优于随机猜测
    def test_mia_accuracy():
        try:
            student = load_student_module(sys.argv[1])
            rng = np.random.default_rng(42)
            model = MockModel()
            # 构造有明显差异的成员/非成员
            X_member = rng.standard_normal((100, 4))
            X_non_member = rng.standard_normal((100, 4)) + 3.0
            y_member = rng.integers(0, 3, 100)
            y_non_member = rng.integers(0, 3, 100)
            result = student.membership_inference(
                model, X_member, y_member, X_non_member, y_non_member
            )
            if isinstance(result, dict):
                preds = result.get("predictions")
                if preds is None:
                    preds = result.get("member_preds")
                preds = np.asarray(preds)
                acc = result.get("accuracy")
            else:
                preds = np.asarray(result)
                acc = None
            # 真值：前 100 是成员（True），后 100 不是（False）
            truth = np.concatenate([np.ones(100, dtype=bool), np.zeros(100, dtype=bool)])
            if len(preds) != 200:
                return False, f"预测长度异常: {len(preds)} (应=200)"
            computed_acc = np.mean(preds == truth)
            if acc is not None:
                acc = float(acc)
                if abs(acc - computed_acc) > 0.05:
                    return False, f"返回 accuracy ({acc:.2%}) 与实际 ({computed_acc:.2%}) 不符"
            if computed_acc >= 0.6:
                return True, f"MIA 准确率 {computed_acc:.2%} 优于随机"
            return False, f"MIA 准确率 {computed_acc:.2%} 不优于随机 (0.5)"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_mia_accuracy())

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
