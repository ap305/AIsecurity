"""
LeNet 手写数字识别——数据增强模型

本文件仅保留“数据增强处理”部分供学生完成。
LeNet 网络、训练流程、结果保存等代码均已给出。

学生需要完成：
1. 在 MNISTDataset.__init__ 中补充训练集数据增强操作；
2. 增强方式必须包括：
   - 随机旋转：±10°
   - 随机平移：水平、垂直方向最大 10%
   - 随机缩放：0.90～1.10
3. 保留 ToTensor 与 Normalize；
"""

from pathlib import Path

import pandas as pd
import torch
import torch.nn as nn
from datasets import Dataset
from torch.utils.data import DataLoader
from torchvision import transforms


# =========================
# 实验参数
# =========================

EPOCHS = 10
BATCH_SIZE = 64
LR = 0.001

BASE_DIR = Path(__file__).resolve().parent
TRAIN_ARROW = (
    BASE_DIR
    / "mnist_huggingface"
    / "train"
    / "data-00000-of-00001.arrow"
)

MODEL_PATH = BASE_DIR / "augmented_model.pth"
LOSS_CSV_PATH = BASE_DIR / "augmented_loss_history.csv"
LOSS_CURVE_PATH = BASE_DIR / "augmented_loss_curve.png"


# =========================
# 数据读取与增强
# =========================

class MNISTDataset(torch.utils.data.Dataset):
    """读取 Arrow 格式 MNIST 训练集，并执行随机数据增强。"""

    def __init__(self, arrow_file: Path):
        if not arrow_file.exists():
            raise FileNotFoundError(f"未找到训练集文件：{arrow_file}")

        self.data = Dataset.from_file(str(arrow_file))

        """
        TODO：完成训练集的数据增强流水线 self.transform。

        必须使用 transforms.Compose，并按以下顺序设置：

        1. RandomAffine
           - 随机旋转范围：-10° 到 10°
           - 水平、垂直平移范围：最大 10%
           - 随机缩放范围：0.90 到 1.10

        2. ToTensor

        3. Normalize
           - mean = 0.1307
           - std = 0.3081

        注意：
        - 不要使用 RandomHorizontalFlip 或 RandomVerticalFlip；
        - 不要删除 ToTensor 和 Normalize；
        - 本实验只在训练集上进行随机数据增强。
        """

        # TODO：在此定义 self.transform
        self.transform = None

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        item = self.data[index]
        image = item["image"]
        label = int(item["label"])

        if self.transform is None:
            raise RuntimeError(
                "尚未完成数据增强：请在 MNISTDataset.__init__ 中定义 self.transform。"
            )

        image = self.transform(image)
        return image, label


# =========================
# LeNet 模型
# =========================

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


# =========================
# 训练函数
# =========================

def train():
    dataset = MNISTDataset(TRAIN_ARROW)
    loader = DataLoader(
        dataset,
        batch_size=BATCH_SIZE,
        shuffle=True,
    )

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"使用设备：{device}")

    model = LeNet().to(device)
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LR)

    loss_history = []

    for epoch in range(EPOCHS):
        model.train()
        running_loss = 0.0
        correct = 0
        total = 0

        for images, labels in loader:
            images = images.to(device)
            labels = labels.to(device)

            optimizer.zero_grad()
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

            running_loss += loss.item() * images.size(0)
            predictions = outputs.argmax(dim=1)
            correct += (predictions == labels).sum().item()
            total += labels.size(0)

        average_loss = running_loss / total
        train_accuracy = 100.0 * correct / total
        loss_history.append(average_loss)

        print(
            f"Epoch {epoch + 1}/{EPOCHS}, "
            f"Loss={average_loss:.4f}, "
            f"Accuracy={train_accuracy:.2f}%"
        )

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), MODEL_PATH)

    pd.DataFrame(
        {
            "epoch": range(1, EPOCHS + 1),
            "loss": loss_history,
        }
    ).to_csv(LOSS_CSV_PATH, index=False)


    print(f"模型已保存：{MODEL_PATH}")
    print(f"损失记录已保存：{LOSS_CSV_PATH}")
    print(f"损失曲线已保存：{LOSS_CURVE_PATH}")


if __name__ == "__main__":
    train()