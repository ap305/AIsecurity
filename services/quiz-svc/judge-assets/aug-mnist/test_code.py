"""
LeNet 数据增强对比实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <augmented_model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 第 1 个参数为学生上传的 augmented_model.pth；基线 model.pth 作为资产
  放在脚本同目录（judge-assets/aug-mnist/model.pth）。
- 评测脚本自带 LeNet 结构（self.features / self.classifier），仅加载
  state_dict，不导入学生代码。
- MNIST 测试集 Arrow 文件位于脚本同目录 mnist_huggingface/test/。
- 通过标准：数据增强模型测试准确率 >= 95%。
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
BASELINE_MODEL = BASE_DIR / "model.pth"
BATCH_SIZE = 128
NUM_CLASSES = 10


class MNISTTestDataset(torch.utils.data.Dataset):
    def __init__(self, arrow_file):
        if not arrow_file.exists():
            raise FileNotFoundError(f"未找到测试集文件：{arrow_file}")
        self.data = Dataset.from_file(str(arrow_file))
        self.transform = transforms.Compose([
            transforms.ToTensor(),
            transforms.Normalize((0.1307,), (0.3081,)),
        ])

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        item = self.data[index]
        image = self.transform(item["image"])
        label = int(item["label"])
        return image, label


class LeNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 6, kernel_size=5, padding=2),
            nn.ReLU(),
            nn.MaxPool2d(kernel_size=2, stride=2),
            nn.Conv2d(6, 16, kernel_size=5),
            nn.ReLU(),
            nn.MaxPool2d(kernel_size=2, stride=2),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(16 * 5 * 5, 120),
            nn.ReLU(),
            nn.Linear(120, 84),
            nn.ReLU(),
            nn.Linear(84, 10),
        )

    def forward(self, x):
        x = self.features(x)
        x = self.classifier(x)
        return x


def load_model(model_path, device):
    if not model_path.exists():
        raise FileNotFoundError(f"未找到模型文件：{model_path}")
    model = LeNet().to(device)
    state_dict = torch.load(model_path, map_location=device)
    if isinstance(state_dict, dict) and "state_dict" in state_dict:
        state_dict = state_dict["state_dict"]
    if isinstance(state_dict, dict):
        state_dict = {k.replace("module.", ""): v for k, v in state_dict.items()}
    model.load_state_dict(state_dict, strict=True)
    model.eval()
    return model


@torch.no_grad()
def evaluate(model, loader, device):
    correct = 0
    total = 0
    for images, labels in loader:
        images = images.to(device)
        labels = labels.to(device)
        outputs = model(images)
        preds = outputs.argmax(dim=1)
        correct += (preds == labels).sum().item()
        total += labels.size(0)
    return 100.0 * correct / total


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("augmented_model", help="学生上传的 augmented_model.pth")
    parser.add_argument("code_dir", nargs="?", default=None, help="学生代码目录（本题未使用）")
    parser.add_argument("--threshold", type=float, default=95.0)
    args = parser.parse_args()

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    try:
        test_dataset = MNISTTestDataset(TEST_ARROW)
        test_loader = DataLoader(test_dataset, batch_size=BATCH_SIZE, shuffle=False)
        augmented_model = load_model(Path(args.augmented_model), device)
    except Exception as e:
        print(f"测试未通过：{e}")
        print("测试未通过")
        return 1

    aug_acc = evaluate(augmented_model, test_loader, device)

    # 同时评估基线模型（若存在）用于对比展示
    baseline_acc = None
    try:
        baseline_model = load_model(BASELINE_MODEL, device)
        baseline_acc = evaluate(baseline_model, test_loader, device)
    except Exception:
        pass

    print(f"Test Accuracy: {aug_acc:.2f}%")
    print(f"数据增强模型准确率：{aug_acc:.2f}%")
    if baseline_acc is not None:
        print(f"基线模型准确率：{baseline_acc:.2f}%")
        print(f"准确率差值：{aug_acc - baseline_acc:+.2f} 个百分点")

    if aug_acc >= args.threshold:
        print("测试通过")
        return 0
    else:
        print(f"测试未通过（需 >= {args.threshold:.2f}%）")
        return 1


if __name__ == "__main__":
    sys.exit(main())
