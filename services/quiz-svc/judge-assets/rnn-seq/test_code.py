"""
基础 RNN 序列分类实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 动态导入 SequenceDataset 与 RNNClassifier。
- 加载学生提交的 rnn_model.pth（第 1 个参数）。
- 在脚本同目录的 sequence_dataset.csv 上做整体推理并计算准确率。
- 注意：学生代码不得在顶层 import matplotlib（评测环境无该库）。
"""

import sys
import argparse
import importlib.util
from pathlib import Path

import torch
from torch.utils.data import DataLoader


BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR / "sequence_dataset.csv"
BATCH_SIZE = 64
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_student_module(code_dir):
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
    parser = argparse.ArgumentParser()
    parser.add_argument("model_path", help="学生提交的 rnn_model.pth")
    parser.add_argument("code_dir", help="学生代码目录（含 student_code.py）")
    parser.add_argument("--threshold", type=float, default=0.85)
    args = parser.parse_args()

    threshold = args.threshold

    student = load_student_module(args.code_dir)
    if student is None:
        print("测试未通过")
        return 1

    if not hasattr(student, "SequenceDataset") or not hasattr(student, "RNNClassifier"):
        print("测试未通过：学生代码缺少 SequenceDataset 或 RNNClassifier")
        return 1

    # 数据
    try:
        dataset = student.SequenceDataset(str(DATA_PATH))
        loader = DataLoader(dataset, batch_size=BATCH_SIZE)
    except Exception as e:
        print(f"测试未通过：数据加载失败：{e}")
        print("测试未通过")
        return 1

    # 模型
    try:
        model = student.RNNClassifier()
        model.to(DEVICE)
        state = torch.load(args.model_path, map_location=DEVICE)
        model.load_state_dict(state)
        model.eval()
    except Exception as e:
        print(f"测试未通过：模型加载失败：{e}")
        print("测试未通过")
        return 1

    # 推理
    correct = 0
    total = 0
    try:
        with torch.no_grad():
            for x, y in loader:
                x = x.to(DEVICE)
                y = y.to(DEVICE)
                output = model(x)
                pred = torch.argmax(output, dim=1)
                correct += (pred == y).sum().item()
                total += len(y)
    except Exception as e:
        print(f"测试未通过：推理失败：{e}")
        print("测试未通过")
        return 1

    acc = correct / total if total > 0 else 0.0
    print(f"Test Accuracy: {acc * 100:.2f}%")
    print(f"测试准确率: {round(acc, 4)}")
    if acc >= threshold:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
