"""
经典 CNN 图像分类架构对比实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <combined_model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 学生上传单个 cnn_models.pth，内容为
  {'LeNet': state_dict, 'AlexNetMini': state_dict, 'VGGNetMini': state_dict}。
- 评测脚本自带三个网络结构（与学生代码一致），仅加载 state_dict，不导入学生代码。
- MNIST 测试集 Arrow 文件位于脚本同目录 mnist_huggingface/test/。
- 通过标准：三个模型测试准确率的最低值 >= 90%。
"""

from __future__ import annotations
import sys
import argparse
from pathlib import Path

import torch
import torch.nn as nn
from datasets import Dataset
from torch.utils.data import DataLoader
from torchvision import transforms


BASE_DIR = Path(__file__).resolve().parent
TEST_ARROW = BASE_DIR / "mnist_huggingface" / "test" / "data-00000-of-00001.arrow"
BATCH_SIZE = 128


class MNISTArrowDataset(torch.utils.data.Dataset):
    def __init__(self, arrow_path):
        self.data = Dataset.from_file(str(arrow_path))
        self.transform = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize((0.1307,), (0.3081,)),
        ])

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        item = self.data[index]
        return self.transform(item["image"]), int(item["label"])


class LeNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 6, 5, padding=2), nn.ReLU(), nn.MaxPool2d(2, 2),
            nn.Conv2d(6, 16, 5), nn.ReLU(), nn.MaxPool2d(2, 2),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(16 * 5 * 5, 120), nn.ReLU(),
            nn.Linear(120, 84), nn.ReLU(), nn.Linear(84, 10),
        )

    def forward(self, x):
        return self.classifier(self.features(x))


class AlexNetMini(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, 5, padding=2), nn.ReLU(), nn.MaxPool2d(2, 2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2, 2),
            nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(),
            nn.AdaptiveAvgPool2d((3, 3)),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(128 * 3 * 3, 256), nn.ReLU(), nn.Dropout(0.5),
            nn.Linear(256, 128), nn.ReLU(), nn.Dropout(0.5),
            nn.Linear(128, 10),
        )

    def forward(self, x):
        return self.classifier(self.features(x))


class VGGNetMini(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 32, 3, padding=1), nn.ReLU(),
            nn.Conv2d(32, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2, 2),
            nn.Conv2d(32, 64, 3, padding=1), nn.ReLU(),
            nn.Conv2d(64, 64, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2, 2),
            nn.Conv2d(64, 128, 3, padding=1), nn.ReLU(),
            nn.Conv2d(128, 128, 3, padding=1), nn.ReLU(),
            nn.AdaptiveAvgPool2d((3, 3)),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(128 * 3 * 3, 256), nn.ReLU(), nn.Dropout(0.5),
            nn.Linear(256, 10),
        )

    def forward(self, x):
        return self.classifier(self.features(x))


MODEL_CLASS = {
    "LeNet": LeNet,
    "AlexNetMini": AlexNetMini,
    "VGGNetMini": VGGNetMini,
}


@torch.no_grad()
def evaluate(model, loader, device):
    model.eval()
    correct = 0
    total = 0
    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)
        pred = model(images).argmax(1)
        correct += (pred == labels).sum().item()
        total += labels.size(0)
    return 100.0 * correct / total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model_path", help="学生上传的 cnn_models.pth（合并 state_dict）")
    parser.add_argument("code_dir", nargs="?", default=None, help="学生代码目录（本题未使用）")
    parser.add_argument("--threshold", type=float, default=90.0)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    try:
        if not TEST_ARROW.exists():
            raise FileNotFoundError(f"未找到 MNIST 测试集：{TEST_ARROW}")
        dataset = MNISTArrowDataset(TEST_ARROW)
        loader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=False)

        checkpoint = torch.load(args.model_path, map_location=device)
        if not isinstance(checkpoint, dict) or "LeNet" not in checkpoint:
            raise ValueError("模型文件格式错误：应为 {'LeNet':..., 'AlexNetMini':..., 'VGGNetMini':...} 合并字典")
    except Exception as e:
        print(f"测试未通过：{e}")
        print("测试未通过")
        return 1

    accuracies = {}
    for name, cls in MODEL_CLASS.items():
        try:
            model = cls().to(device)
            model.load_state_dict(checkpoint[name], strict=True)
            acc = evaluate(model, loader, device)
            accuracies[name] = acc
            print(f"{name} 准确率：{acc:.2f}%")
        except Exception as e:
            print(f"{name} 加载/评测失败：{e}")
            print("测试未通过")
            return 1

    min_acc = min(accuracies.values())
    print(f"Test Accuracy: {min_acc:.2f}%")
    if min_acc >= args.threshold:
        print("测试通过")
        return 0
    else:
        print(f"测试未通过（最低准确率需 >= {args.threshold:.2f}%）")
        return 1


if __name__ == "__main__":
    sys.exit(main())
