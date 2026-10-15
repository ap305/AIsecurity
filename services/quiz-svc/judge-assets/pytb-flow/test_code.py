"""
PyTorch 训练流程与 TensorBoard 实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 CNN 类。
- 加载学生上传的模型 <model_path>（mnist_cnn.pth），在 MNIST 测试集上评测准确率。
- 评测数据来自 ./mnist_huggingface（judge-assets/pytb-flow/）。
- 不依赖 matplotlib 与 tensorboard；TensorBoard 日志与 loss_curve.png 检查已移除。
"""

import sys
import importlib.util
import os
from pathlib import Path

import torch
import torch.nn as nn
import numpy as np
from torch.utils.data import DataLoader
from datasets import load_from_disk

DATA_PATH = "./mnist_huggingface"
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


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


def preprocess(batch):
    images = []
    for image in batch["image"]:
        if hasattr(image, "convert"):
            image = image.convert("L")
        arr = np.array(image, dtype=np.float32).reshape(28, 28)
        t = torch.tensor(arr).unsqueeze(0)
        t = t / 255.0
        t = (t - 0.1307) / 0.3081
        images.append(t)
    return {"image": images, "label": batch["label"]}


def main():
    if len(sys.argv) < 3:
        print("测试未通过：缺少参数 <model_path> <student_code_dir>")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    model_path = sys.argv[1]
    code_dir = sys.argv[2]
    torch.manual_seed(42)

    if not os.path.exists(model_path):
        print(f"测试未通过：模型文件未找到 {model_path}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    student = load_student(code_dir)
    if student is None or not hasattr(student, "CNN"):
        print("测试未通过：缺少 CNN 类")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 结构检查
    try:
        model = student.CNN()
        assert isinstance(model, nn.Module)
        assert hasattr(model, "features")
        assert hasattr(model, "classifier")
        model.eval()
        x = torch.randn(2, 1, 28, 28)
        y = model(x)
        assert tuple(y.shape) == (2, 10), f"forward 输出形状应为 (2,10)，实际 {tuple(y.shape)}"
    except Exception as e:
        print(f"测试未通过：CNN 结构/前向检查失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 加载模型
    try:
        model = student.CNN().to(device)
        state = torch.load(model_path, map_location=device)
        model.load_state_dict(state)
        model.eval()
    except Exception as e:
        print(f"测试未通过：模型加载失败（state_dict 不匹配？）：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 评测准确率
    try:
        dataset = load_from_disk(DATA_PATH)
        test_dataset = dataset["test"].with_transform(preprocess)
        loader = DataLoader(test_dataset, batch_size=64)

        correct = 0
        total = 0
        with torch.no_grad():
            for batch in loader:
                images = batch["image"].to(device)
                labels = batch["label"].to(device)
                outputs = model(images)
                pred = torch.argmax(outputs, dim=1)
                correct += (pred == labels).sum().item()
                total += labels.size(0)
        acc = correct / total if total > 0 else 0.0
    except Exception as e:
        print(f"测试未通过：评测执行失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    print(f"Test Accuracy: {acc * 100:.2f}%")
    if acc >= 0.90:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
