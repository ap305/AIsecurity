"""
PyTorch与TensorBoard训练流程实验

Reference_code.py

功能：
1. PyTorch CNN训练流程
2. TensorBoard训练过程可视化

TensorBoard记录：
- Loss
- Accuracy
- Graph
- Histogram
- Images

数据：
mnist_huggingface

输出：
results/
├── mnist_cnn.pth
└── loss_curve.png

runs/
└── mnist_tensorboard/
"""


import os

import torch
import torch.nn as nn
import torch.optim as optim

from torch.utils.data import DataLoader

from datasets import load_from_disk





# ==========================
# 参数
# ==========================

BATCH_SIZE = 64

EPOCHS = 10

LR = 0.001


DATA_PATH = "./mnist_huggingface"

MODEL_PATH = "results/mnist_cnn.pth"

LOG_DIR = "runs/mnist_tensorboard"


device = torch.device(
    "cuda"
    if torch.cuda.is_available()
    else "cpu"
)


os.makedirs(
    "results",
    exist_ok=True
)



# ==========================
# CNN模型
# ==========================


class CNN(nn.Module):

    def __init__(self):

        super().__init__()


        self.features = nn.Sequential(

            nn.Conv2d(
                1,
                16,
                kernel_size=3,
                padding=1
            ),

            nn.ReLU(),

            nn.MaxPool2d(2),


            nn.Conv2d(
                16,
                32,
                kernel_size=3,
                padding=1
            ),

            nn.ReLU(),

            nn.MaxPool2d(2)

        )


        self.classifier = nn.Sequential(

            nn.Flatten(),

            nn.Linear(
                32 * 7 * 7,
                128
            ),

            nn.ReLU(),


            nn.Linear(
                128,
                10
            )

        )


    def forward(self, x):

        x = self.features(x)

        x = self.classifier(x)

        return x



# ==========================
# 数据加载
# ==========================


def load_data():


    dataset = load_from_disk(
        DATA_PATH
    )


    train_dataset = dataset["train"]

    test_dataset = dataset["test"]



    def preprocess(batch):


        images = []

        labels = batch["label"]



        for image in batch["image"]:


            # ----------------------
            # PIL Image
            # ----------------------

            if hasattr(image, "convert"):


                image = image.convert("L")


                image = torch.tensor(

                    list(image.getdata()),

                    dtype=torch.float32

                )


            # ----------------------
            # list
            # ----------------------

            else:


                image = torch.tensor(

                    image,

                    dtype=torch.float32

                )



            image = image.reshape(
                28,
                28
            )


            image = image.unsqueeze(0)


            image = image / 255.0


            image = (
                image - 0.1307
            ) / 0.3081



            images.append(image)



        return {

            "image": images,

            "label": labels

        }



    train_dataset = train_dataset.with_transform(
        preprocess
    )


    test_dataset = test_dataset.with_transform(
        preprocess
    )



    train_loader = DataLoader(

        train_dataset,

        batch_size=BATCH_SIZE,

        shuffle=True,

        num_workers=0

    )


    test_loader = DataLoader(

        test_dataset,

        batch_size=BATCH_SIZE,

        shuffle=False,

        num_workers=0

    )


    return train_loader, test_loader



# ==========================
# 测试
# ==========================


def evaluate(model, loader):


    model.eval()


    correct = 0

    total = 0



    with torch.no_grad():


        for batch in loader:


            images = batch["image"].to(device)


            labels = batch["label"].to(device)



            outputs = model(images)


            pred = torch.argmax(
                outputs,
                dim=1
            )


            correct += (
                pred == labels
            ).sum().item()


            total += labels.size(0)



    return correct / total



# ==========================
# 训练
# ==========================


def train():
    from torch.utils.tensorboard import SummaryWriter  # 懒加载：评测环境无 tensorboard
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib


    train_loader, test_loader = load_data()



    model = CNN().to(device)


    criterion = nn.CrossEntropyLoss()


    optimizer = optim.Adam(

        model.parameters(),

        lr=LR

    )



    # TensorBoard

    writer = SummaryWriter(
        LOG_DIR
    )



    # Graph

    dummy_input = torch.randn(

        1,

        1,

        28,

        28

    ).to(device)



    writer.add_graph(

        model,

        dummy_input

    )



    loss_history = []



    for epoch in range(EPOCHS):


        model.train()


        total_loss = 0



        for batch in train_loader:


            images = batch["image"].to(device)


            labels = batch["label"].to(device)



            optimizer.zero_grad()


            outputs = model(images)


            loss = criterion(

                outputs,

                labels

            )


            loss.backward()


            optimizer.step()


            total_loss += loss.item()



        avg_loss = (

            total_loss /

            len(train_loader)

        )


        acc = evaluate(

            model,

            test_loader

        )


        loss_history.append(
            avg_loss
        )



        print(

            f"Epoch {epoch+1}/{EPOCHS}, "

            f"Loss:{avg_loss:.4f}, "

            f"Accuracy:{acc:.4f}"

        )



        # TensorBoard Loss

        writer.add_scalar(

            "Train/Loss",

            avg_loss,

            epoch

        )


        # TensorBoard Accuracy

        writer.add_scalar(

            "Test/Accuracy",

            acc,

            epoch

        )



        # Histogram

        for name, param in model.named_parameters():

            writer.add_histogram(

                name,

                param,

                epoch

            )



        # Images

        batch = next(

            iter(train_loader)

        )


        writer.add_images(

            "MNIST/Samples",

            batch["image"][:16],

            epoch

        )



    # 保存模型

    torch.save(

        model.state_dict(),

        MODEL_PATH

    )


    writer.close()



    # Loss曲线

    plt.figure()


    plt.plot(

        loss_history

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


    plt.savefig(

        "results/loss_curve.png"

    )


    plt.close()


    print(
        "Training Finished!"
    )



if __name__ == "__main__":

    train()