"""
人工智能基础实验
前馈神经网络 Iris 分类

Standard Code

功能：
1. 加载 train.csv
2. 构建 FeedForward Neural Network
3. 完成模型训练
4. 记录 Loss变化
5. 保存训练结果
6. 保存模型参数

输出：
    model.pth
    loss_history.csv
    loss_curve.png
"""

import matplotlib.pyplot as plt
import pandas as pd
import torch

from torch import nn
from torch.utils.data import DataLoader, TensorDataset

# ==========================
# 1. 定义前馈神经网络
# ==========================

class FeedForwardNN(nn.Module):

    def __init__(
        self,
        input_dim=4,
        hidden_dim1=16,
        hidden_dim2=8,
        output_dim=3
    ):
        super().__init__()

        self.network = nn.Sequential(

            # 输入层 -> 第一隐藏层
            nn.Linear(
                input_dim,
                hidden_dim1
            ),

            nn.ReLU(),


            # 第一隐藏层 -> 第二隐藏层
            nn.Linear(
                hidden_dim1,
                hidden_dim2
            ),

            nn.ReLU(),


            # 第二隐藏层 -> 输出层
            nn.Linear(
                hidden_dim2,
                output_dim
            )
        )


    def forward(self, x):

        return self.network(x)

# ==========================
# 2. 加载训练数据
# ==========================

def load_train_data():

    data = pd.read_csv(
        "train.csv"
    )


    # 前4列作为输入特征

    x = torch.tensor(
        data.iloc[:, :4].values,
        dtype=torch.float32
    )


    # 第5列作为标签

    y = torch.tensor(
        data.iloc[:, 4].values,
        dtype=torch.long
    )


    return x, y



# ==========================
# 3. 模型训练
# ==========================

def train(
    model,
    train_loader,
    epochs=150
):
    # 分类任务使用交叉熵
    criterion = nn.CrossEntropyLoss()

    # Adam优化器
    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=0.01
    )
    loss_history = []
    model.train()
    for epoch in range(epochs):
        total_loss = 0
        for x_batch, y_batch in train_loader:
            # (1) 清空梯度
            optimizer.zero_grad()
            # (2) 前向传播
            output = model(
                x_batch
            )
            # (3) 计算损失
            loss = criterion(
                output,
                y_batch
            )
            # (4) 反向传播
            loss.backward()
            # (5) 更新参数
            optimizer.step()
            total_loss += (
                loss.item()
                *
                len(x_batch)
            )

        # 当前epoch平均loss
        avg_loss = (
            total_loss
            /
            len(train_loader.dataset)
        )

        loss_history.append(
            avg_loss
        )

        print(
            f"Epoch [{epoch+1}/{epochs}], "
            f"Loss: {avg_loss:.4f}"
        )


    return loss_history

# ==========================
# 4. 保存Loss变化
# ==========================

def save_loss_curve(loss_history):


    # 保存csv

    loss_df = pd.DataFrame(
        {
            "epoch":
            range(
                1,
                len(loss_history)+1
            ),

            "loss":
            loss_history
        }
    )


    loss_df.to_csv(
        "loss_history.csv",
        index=False
    )



    # 绘制Loss曲线

    plt.figure(
        figsize=(7,4)
    )


    plt.plot(
        range(
            1,
            len(loss_history)+1
        ),
        loss_history
    )


    plt.xlabel(
        "Epoch"
    )

    plt.ylabel(
        "Loss"
    )


    plt.title(
        "Training Loss Curve"
    )


    plt.grid()


    plt.savefig(
        "loss_curve.png",
        dpi=300
    )


    plt.close()

# ==========================
# 5. 主函数
# ==========================

def main():
    # 加载训练数据
    x_train, y_train = load_train_data()
    train_dataset = TensorDataset(
        x_train,
        y_train
    )

    train_loader = DataLoader(
        train_dataset,
        batch_size=16,
        shuffle=True
    )
    # 创建模型
    model = FeedForwardNN()
    # 训练
    loss_history = train(
        model,
        train_loader,
        epochs=150
    )

    # 保存loss
    save_loss_curve(
        loss_history
    )

    # 保存模型参数
    torch.save(
        model.state_dict(),
        "model.pth"
    )

    print("====================")
    print("Training Finished!")
    print("Saved:")
    print("model.pth")
    print("loss_history.csv")
    print("loss_curve.png")
    print("====================")

if __name__ == "__main__":

    main()