#!/usr/bin/env python3
"""
M1 FGSM 对抗样本生成 - 评测脚本

学生需在 student_code.py 中实现 fgsm_attack(model, images, labels, epsilon) 函数。
本脚本使用一个简化的 MockModel 来验证学生实现的逻辑正确性。

调用方式：python3 test_code.py <student_code_dir>
"""

import sys
import os
import importlib.util
import traceback
import numpy as np


def load_student_module(code_dir: str):
    """从指定目录加载 student_code.py"""
    path = os.path.join(code_dir, "student_code.py")
    if not os.path.exists(path):
        raise FileNotFoundError(f"未找到学生代码: {path}")
    spec = importlib.util.spec_from_file_location("student_code", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MockModel:
    """简化的 MockModel，模拟 PyTorch model 的 gradient 接口
    学生代码应使用 model.parameters() 获取权重，并用链式法则计算梯度。
    为了兼容，MockModel 提供 .W 和 .b 属性（numpy 数组），并提供 .backward() 接口。
    """

    def __init__(self, n_features=4, n_classes=3):
        rng = np.random.default_rng(42)
        self.W = rng.standard_normal((n_features, n_classes)) * 0.5
        self.b = rng.standard_normal(n_classes) * 0.1
        self.n_features = n_features
        self.n_classes = n_classes
        # 模拟 PyTorch style 的参数访问
        self._params = {"W": self.W, "b": self.b}

    def parameters(self):
        return [self.W, self.b]

    def forward(self, x):
        """线性层 + softmax"""
        logits = x @ self.W + self.b
        # 数值稳定的 softmax
        shifted = logits - logits.max(axis=-1, keepdims=True)
        exp = np.exp(shifted)
        return exp / exp.sum(axis=-1, keepdims=True)

    def __call__(self, x):
        return self.forward(x)


class MockTensor:
    """模拟 PyTorch Tensor 的关键接口，使 FGSM 实现可以跨框架。
    学生代码使用 sign() 方法即可。
    """

    def __init__(self, data: np.ndarray, requires_grad: bool = False):
        self.data = np.asarray(data, dtype=np.float64)
        self.requires_grad = requires_grad
        self.grad = None

    def sign(self):
        return MockTensor(np.sign(self.data))

    def __mul__(self, other):
        if isinstance(other, MockTensor):
            return MockTensor(self.data * other.data)
        return MockTensor(self.data * other)

    __rmul__ = __mul__

    def __add__(self, other):
        if isinstance(other, MockTensor):
            return MockTensor(self.data + other.data)
        return MockTensor(self.data + other)

    __radd__ = __add__

    def numpy(self):
        return self.data

    def __repr__(self):
        return f"MockTensor({self.data})"


def run_tests():
    """运行所有测试用例，返回 (passed, total, details)"""
    results = []

    # 测试 1: 函数存在性
    def test_function_exists():
        try:
            student = load_student_module(sys.argv[1])
            if not hasattr(student, "fgsm_attack"):
                return False, "fgsm_attack 函数未定义"
            return True, "fgsm_attack 函数存在"
        except Exception as e:
            return False, f"加载学生代码失败: {e}"
    results.append(test_function_exists())

    # 测试 2: 基本功能 - 扰动方向正确
    def test_perturbation_direction():
        try:
            student = load_student_module(sys.argv[1])
            # 构造一个简单的梯度场景：用 numpy 模拟
            model = MockModel(n_features=4, n_classes=3)
            images = np.array([[0.5, -0.3, 0.8, 0.1]])
            labels = np.array([1])

            # 调用学生实现的 fgsm_attack
            # 兼容两种签名：fgsm_attack(model, images, labels, epsilon) 或返回扰动后图像
            adv = student.fgsm_attack(model, images, labels, epsilon=0.1)

            if adv is None:
                return False, "函数返回 None"

            adv = np.asarray(adv.data if hasattr(adv, "data") else adv, dtype=np.float64)
            diff = adv - images.astype(np.float64)
            # FGSM 应该使扰动幅度 = epsilon（每个非零维度）
            max_diff = np.abs(diff).max()
            if max_diff > 0.15:  # 允许浮点误差
                return False, f"扰动幅度过大: {max_diff:.4f} (应≈0.1)"
            if np.abs(diff).max() < 0.05:
                return False, "扰动幅度过小，可能未应用 epsilon"
            return True, f"扰动幅度合理 (max={max_diff:.4f})"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_perturbation_direction())

    # 测试 3: epsilon=0 时输出等于输入
    def test_zero_epsilon():
        try:
            student = load_student_module(sys.argv[1])
            model = MockModel()
            images = np.array([[0.5, -0.3, 0.8, 0.1]])
            labels = np.array([1])
            adv = student.fgsm_attack(model, images, labels, epsilon=0.0)
            adv = np.asarray(adv.data if hasattr(adv, "data") else adv, dtype=np.float64)
            if np.allclose(adv, images, atol=1e-6):
                return True, "epsilon=0 时输出=输入"
            return False, "epsilon=0 时输出不应改变"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_zero_epsilon())

    # 测试 4: 批量输入支持
    def test_batch_input():
        try:
            student = load_student_module(sys.argv[1])
            model = MockModel(n_features=4, n_classes=3)
            images = np.array([
                [0.5, -0.3, 0.8, 0.1],
                [-0.2, 0.6, 0.4, -0.7],
                [0.1, 0.2, 0.3, 0.4],
            ])
            labels = np.array([1, 0, 2])
            adv = student.fgsm_attack(model, images, labels, epsilon=0.1)
            adv = np.asarray(adv.data if hasattr(adv, "data") else adv, dtype=np.float64)
            if adv.shape != images.shape:
                return False, f"输出形状不匹配: {adv.shape} vs {images.shape}"
            return True, f"批量输入支持正常 (shape={adv.shape})"
        except Exception as e:
            return False, f"测试异常: {e}"
    results.append(test_batch_input())

    # 输出结果
    passed = sum(1 for ok, _ in results if ok)
    total = len(results)
    print(f"Tests Passed: {passed}/{total}")
    for i, (ok, msg) in enumerate(results, 1):
        marker = "[PASS]" if ok else "[FAIL]"
        print(f"  Test {i}: {marker} {msg}")

    if passed >= total * 0.75:
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
        print("Tests Passed: 0/4")
