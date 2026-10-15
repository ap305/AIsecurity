"""
前馈神经网络 Iris 分类实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 评测脚本自带与学生代码一致的 FeedForwardNN 结构（4->16->8->3），
  仅加载学生提交的 state_dict，不导入学生代码。
- test.csv 位于脚本同目录（judge-assets/fnn-iris/test.csv）。
"""

from pathlib import Path
import sys
import argparse

import pandas as pd
import torch
from torch import nn


BASE_DIR = Path(__file__).resolve().parent
FEATURE_COLUMNS = ["sepal_length", "sepal_width", "petal_length", "petal_width"]
LABEL_COLUMN = "label"
CLASS_NAMES = ["Setosa", "Versicolor", "Virginica"]


class FeedForwardNN(nn.Module):
    """与学生训练代码保持一致的前馈神经网络。"""

    def __init__(self, input_dim=4, hidden_dim1=16, hidden_dim2=8, output_dim=3):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(input_dim, hidden_dim1),
            nn.ReLU(),
            nn.Linear(hidden_dim1, hidden_dim2),
            nn.ReLU(),
            nn.Linear(hidden_dim2, output_dim),
        )

    def forward(self, x):
        return self.network(x)


def load_test_data(test_file):
    if not test_file.exists():
        print(f"测试未通过：未找到测试数据 {test_file}")
        return None, None
    data = pd.read_csv(test_file)
    features = torch.tensor(data[FEATURE_COLUMNS].to_numpy(), dtype=torch.float32)
    labels = torch.tensor(data[LABEL_COLUMN].to_numpy(), dtype=torch.long)
    return features, labels


def load_student_model(model_file):
    if not model_file.exists():
        print(f"测试未通过：未找到模型文件 {model_file}")
        return None
    model = FeedForwardNN()
    checkpoint = torch.load(model_file, map_location="cpu", weights_only=True)
    if isinstance(checkpoint, dict) and "model_state_dict" in checkpoint:
        state_dict = checkpoint["model_state_dict"]
    else:
        state_dict = checkpoint
    try:
        model.load_state_dict(state_dict, strict=True)
    except RuntimeError as e:
        print(f"测试未通过：模型参数与规定结构(4->16->8->3)不匹配：{e}")
        return None
    model.eval()
    return model


@torch.no_grad()
def evaluate(model, features, labels):
    logits = model(features)
    preds = logits.argmax(dim=1)
    accuracy = (preds == labels).float().mean().item()
    return accuracy, preds


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model_path", help="学生提交的 model.pth")
    parser.add_argument("code_dir", nargs="?", default=None, help="学生代码目录（本题未使用）")
    parser.add_argument("--test-file", default=str(BASE_DIR / "test.csv"))
    parser.add_argument("--threshold", type=float, default=0.90)
    args = parser.parse_args()

    threshold = args.threshold
    features, labels = load_test_data(Path(args.test_file))
    if features is None:
        print("测试未通过")
        return 1

    model = load_student_model(Path(args.model_path))
    if model is None:
        print("测试未通过")
        return 1

    accuracy, _ = evaluate(model, features, labels)

    # 平台约定输出
    print(f"Test Accuracy: {accuracy * 100:.2f}%")
    print(f"总体准确率：{accuracy:.2%}")
    print(f"通过标准：准确率不低于 {threshold:.2%}")
    if accuracy >= threshold:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
