"""
Transformer 编码器文本分类实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 TransformerEncoder 等类与 load_data/evaluate。
- 加载学生上传的模型 <model_path>（transformer_encoder.pth）。
- 调用 student.load_data() 读取 ./data/AGNews（judge-assets/trsf-encoder/）构建词表与测试集，
  再用 student.evaluate 在测试集上评测准确率。
- 不依赖 matplotlib；loss_curve.png 检查已移除。
"""

import sys
import importlib.util
import os
from pathlib import Path

import torch
import torch.nn as nn


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
    if student is None:
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 结构检查（诊断信息）
    try:
        att = student.MultiHeadAttention(128, 4)
        assert hasattr(att, "q_linear") and hasattr(att, "k_linear")
        assert hasattr(att, "v_linear") and hasattr(att, "out_linear")

        layer = student.TransformerEncoderLayer(128, 4, 256)
        assert hasattr(layer, "attention") and hasattr(layer, "ffn")
        assert hasattr(layer, "norm1") and hasattr(layer, "norm2")

        dev = getattr(student, "device", torch.device("cpu"))
        max_len = getattr(student, "MAX_LEN", 64)
        num_classes = getattr(student, "NUM_CLASSES", 4)
        model = student.TransformerEncoder(10000).to(dev)
        assert hasattr(model, "embedding") and hasattr(model, "classifier")
        model.eval()
        x = torch.randint(0, 10000, (4, max_len), device=dev)
        with torch.no_grad():
            out = model(x)
        assert tuple(out.shape) == (4, num_classes), f"forward 输出形状应为 (4,{num_classes})，实际 {tuple(out.shape)}"
    except Exception as e:
        print(f"测试未通过：结构/前向检查失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 加载测试数据与词表（vocab.json 预构建自 train.csv，与训练时一致；避免在评测时重建词表）
    try:
        import json
        import pandas as pd
        from torch.utils.data import DataLoader

        test_df = pd.read_csv("./data/AGNews/test.csv")
        with open("./vocab.json", "r", encoding="utf-8") as f:
            vocab = json.load(f)

        test_dataset = student.AGNewsDataset(test_df, vocab)
        batch_size = getattr(student, "BATCH_SIZE", 64)
        test_loader = DataLoader(test_dataset, batch_size=batch_size)
    except Exception as e:
        print(f"测试未通过：数据加载失败（检查 ./data/AGNews/test.csv 与 ./vocab.json）：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 加载模型并评测
    try:
        dev = getattr(student, "device", torch.device("cpu"))
        model = student.TransformerEncoder(len(vocab)).to(dev)
        state = torch.load(model_path, map_location=dev)
        model.load_state_dict(state)
        acc = student.evaluate(model, test_loader)
    except Exception as e:
        print(f"测试未通过：模型加载/评测失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    acc = float(acc)
    print(f"Test Accuracy: {acc * 100:.2f}%")
    if acc >= 0.85:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
