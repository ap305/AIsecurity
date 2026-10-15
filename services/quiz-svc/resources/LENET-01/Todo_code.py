"""
LeNet 手写数字识别实验

学生代码

需要完成：
1. LeNet网络结构
2. forward函数
3. 训练过程
4. 模型保存
5. loss记录
"""


import torch
import torch.nn as nn

from pathlib import Path

from datasets import Dataset
from torch.utils.data import DataLoader
from torchvision import transforms

import matplotlib.pyplot as plt
import pandas as pd
from PIL import Image


# =========================
# 参数
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


MODEL_PATH = "model.pth"



# =========================
# 数据读取
# =========================


class MNISTDataset(torch.utils.data.Dataset):

    def __init__(self, arrow_file):

        self.data = Dataset.from_file(
            str(arrow_file)
        )

        self.transform = transforms.Compose(
            [
                transforms.ToTensor(),
                transforms.Normalize(
                    (0.1307,),
                    (0.3081,)
                )
            ]
        )


    def __len__(self):

        return len(self.data)



    def __getitem__(self,index):

        item = self.data[index]

        image = item["image"]

        label = item["label"]


        image = self.transform(
            image
        )


        return image,label




# =========================
# LeNet模型
# =========================


class LeNet(nn.Module):

    def __init__(self):
        super().__init__()

        """
        TODO：定义卷积特征提取部分。

        必须使用属性名：
        self.features

        必须按照以下顺序定义：

        1. Conv2d
           输入通道：1
           输出通道：6
           卷积核：5
           padding：2

        2. ReLU

        3. MaxPool2d
           kernel_size：2
           stride：2

        4. Conv2d
           输入通道：6
           输出通道：16
           卷积核：5

        5. ReLU

        6. MaxPool2d
           kernel_size：2
           stride：2

        要求：
        使用 nn.Sequential 定义。
        不得修改属性名 self.features。
        """

        # TODO：在此定义 self.features


        """
        TODO：定义分类部分。

        必须使用属性名：
        self.classifier

        1. Flatten

        2. Linear
           输入维度：16 × 5 × 5
           输出维度：120

        3. ReLU

        4. Linear
           输入维度：120
           输出维度：84

        5. ReLU

        6. Linear
           输入维度：84
           输出维度：10

        要求：
        使用 nn.Sequential 定义。
        不得修改属性名 self.classifier。
        """

        # TODO：在此定义 self.classifier


    def forward(self, x):

        """
        TODO：完成前向传播。

        1. 将 x 输入 self.features
        2. 将结果输入 self.classifier
        3. 返回最终输出

        不要在 forward 中使用 Softmax。
        """

        # TODO：完成前向传播


# =========================
# 训练
# =========================


def train():


    dataset = MNISTDataset(
        TRAIN_ARROW
    )


    loader = DataLoader(
        dataset,
        batch_size=BATCH_SIZE,
        shuffle=True
    )


    model = LeNet()


    criterion = nn.CrossEntropyLoss()


    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=LR
    )



    loss_history=[]


    for epoch in range(EPOCHS):

        total_loss=0


        for images,labels in loader:


            # TODO:
            # 完成训练步骤

            pass



        loss_history.append(
            total_loss
        )


        print(
            f"Epoch {epoch+1}/{EPOCHS}, Loss={total_loss:.4f}"
        )



    # 保存模型

    torch.save(
        model.state_dict(),
        MODEL_PATH
    )


    # 保存loss

    pd.DataFrame(
        {
            "epoch":
            range(1,EPOCHS+1),

            "loss":
            loss_history
        }
    ).to_csv(
        "loss_history.csv",
        index=False
    )


    plt.figure()

    plt.plot(
        range(1,EPOCHS+1),
        loss_history,
        marker="o"
    )

    plt.xticks(
        range(1,EPOCHS+1)
    )

    plt.xlabel(
        "Epoch"
    )

    plt.ylabel(
        "Loss"
    )

    plt.title(
        "Training Loss"
    )

    plt.grid()

    plt.savefig(
        "loss_curve.png"
    )



if __name__=="__main__":

    train()