"""
前馈神经网络 Iris 分类实验

学生完成:
1. 网络结构
2. forward
3. 训练过程

训练完成后生成:
    model.pth
    loss_history.csv
    loss_curve.png
"""

import pandas as pd
import torch
import matplotlib.pyplot as plt

from torch import nn
from torch.utils.data import DataLoader, TensorDataset


class FeedForwardNN(nn.Module):

    def __init__(self):
        super().__init__()

        # TODO 1:
        # Linear(4,16)
        # ReLU
        # Linear(16,8)
        # ReLU
        # Linear(8,3)

        self.network = None


    def forward(self, x):

        # TODO 2
        pass

def load_data():

    data = pd.read_csv("train.csv")

    x = torch.tensor(
        data.iloc[:,:4].values,
        dtype=torch.float32
    )

    y = torch.tensor(
        data.iloc[:,4].values,
        dtype=torch.long
    )

    return x,y



def train(model, loader):

    criterion = nn.CrossEntropyLoss()

    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=0.01
    )

    losses = []

    model.train()

    for epoch in range(150):

        total_loss = 0

        for x,y in loader:

            # TODO 3:
            # zero_grad
            # forward
            # loss
            # backward
            # step

            pass


        avg_loss = total_loss / len(loader.dataset)

        losses.append(avg_loss)

        print(
            f"Epoch {epoch+1}, Loss={avg_loss:.4f}"
        )


    return losses



def save_loss(losses):

    pd.DataFrame(
        {
            "epoch": range(1,len(losses)+1),
            "loss": losses
        }
    ).to_csv(
        "loss_history.csv",
        index=False
    )


    plt.figure(figsize=(6,4))

    plt.plot(
        range(1,len(losses)+1),
        losses
    )

    plt.xlabel("Epoch")

    plt.ylabel("Loss")

    plt.title(
        "Training Loss Curve"
    )

    plt.grid()

    plt.savefig(
        "loss_curve.png"
    )

    plt.close()



def main():

    x,y = load_data()

    loader = DataLoader(
        TensorDataset(x,y),
        batch_size=16,
        shuffle=True
    )


    model=FeedForwardNN()

    losses=train(
        model,
        loader
    )


    save_loss(losses)


    torch.save(
        model.state_dict(),
        "model.pth"
    )

    print("训练完成")
    print("生成 model.pth")
    print("生成 loss_history.csv")
    print("生成 loss_curve.png")



if __name__=="__main__":
    main()
