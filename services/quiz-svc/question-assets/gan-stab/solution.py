"""
GAN训练稳定性对比实验

Reference_code.py

使用:
HuggingFace MNIST 本地数据

数据结构:

mnist/
├── train/
│   └── data-00000-of-00001.arrow
│
└── test/
    └── data-00000-of-00001.arrow


实验方法:

1. Vanilla GAN
2. Label Smoothing GAN
3. Gradient Penalty GAN


"""

import os
import torch
import torch.nn as nn
import torch.optim as optim


from torch.utils.data import DataLoader, Dataset
from torchvision.utils import save_image, make_grid

from datasets import load_from_disk

import numpy as np



# =========================
# 参数
# =========================


DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


BATCH_SIZE = 128

LATENT_DIM = 100

IMAGE_SIZE = 28

EPOCHS = 50

LR = 0.0002


RESULT_DIR = "results"

os.makedirs(
    RESULT_DIR,
    exist_ok=True
)



# =========================
# HuggingFace MNIST Dataset
# =========================


class MNISTDataset(Dataset):

    def __init__(self, data):

        self.data = data


    def __len__(self):

        return len(self.data)


    def __getitem__(self,index):

        item = self.data[index]


        image = item["image"]


        # PIL -> numpy

        image = np.array(image)


        image = torch.tensor(
            image,
            dtype=torch.float32
        )


        # [0,255]
        # -> [-1,1]

        image = image / 127.5 - 1


        image = image.unsqueeze(0)


        return image, item["label"]



# 加载本地MNIST

def get_train_loader():
    """加载本地 MNIST 训练集 DataLoader（懒加载，避免导入时触发）。"""
    dataset = load_from_disk("./mnist_huggingface")
    train_dataset = MNISTDataset(dataset["train"])
    return DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)


# =========================
# Generator
# =========================


class Generator(nn.Module):

    def __init__(self):

        super().__init__()


        self.model = nn.Sequential(


            nn.Linear(
                LATENT_DIM,
                256
            ),

            nn.BatchNorm1d(
                256
            ),

            nn.ReLU(True),



            nn.Linear(
                256,
                512
            ),

            nn.BatchNorm1d(
                512
            ),

            nn.ReLU(True),



            nn.Linear(
                512,
                1024
            ),

            nn.BatchNorm1d(
                1024
            ),

            nn.ReLU(True),



            nn.Linear(
                1024,
                IMAGE_SIZE*IMAGE_SIZE
            ),

            nn.Tanh()

        )



    def forward(self,z):

        x=self.model(z)


        return x.view(
            z.size(0),
            1,
            IMAGE_SIZE,
            IMAGE_SIZE
        )





# =========================
# Discriminator
# =========================


class Discriminator(nn.Module):

    def __init__(self):

        super().__init__()


        self.model = nn.Sequential(

            nn.Linear(
                IMAGE_SIZE*IMAGE_SIZE,
                512
            ),

            nn.LeakyReLU(
                0.2
            ),


            nn.Linear(
                512,
                256
            ),

            nn.LeakyReLU(
                0.2
            ),


            nn.Linear(
                256,
                1
            ),

            nn.Sigmoid()

        )



    def forward(self,img):

        img = img.view(
            img.size(0),
            -1
        )


        return self.model(img)




# =========================
# Gradient Penalty
# =========================


def gradient_penalty(
        D,
        real,
        fake
):


    batch_size = real.size(0)



    alpha=torch.rand(

        batch_size,
        1,
        1,
        1

    ).to(DEVICE)



    interpolates = (

        alpha*real

        +

        (1-alpha)*fake

    )



    interpolates.requires_grad_(True)



    d_interpolates=D(
        interpolates
    )



    gradients=torch.autograd.grad(

        outputs=d_interpolates,

        inputs=interpolates,

        grad_outputs=torch.ones_like(
            d_interpolates
        ),

        create_graph=True,

        retain_graph=True

    )[0]



    gradients=gradients.view(

        batch_size,

        -1

    )



    gp=(

        gradients.norm(
            2,
            dim=1
        )

        -

        1

    ).pow(2).mean()



    return gp





# =========================
# GAN训练
# =========================


def train_gan(method):


    print(
        "\nTraining:",
        method
    )



    G=Generator().to(
        DEVICE
    )


    D=Discriminator().to(
        DEVICE
    )



    criterion=nn.BCELoss()



    optimizer_G=optim.Adam(

        G.parameters(),

        lr=LR,

        betas=(0.5,0.999)

    )



    optimizer_D=optim.Adam(

        D.parameters(),

        lr=LR,

        betas=(0.5,0.999)

    )



    G_losses=[]

    D_losses=[]



    for epoch in range(EPOCHS):


        for real,_ in get_train_loader():


            real=real.to(
                DEVICE
            )


            batch_size=real.size(0)



            real_label=torch.ones(

                batch_size,
                1

            ).to(DEVICE)



            fake_label=torch.zeros(

                batch_size,
                1

            ).to(DEVICE)



            # -----------------
            # Train D
            # -----------------


            z=torch.randn(

                batch_size,

                LATENT_DIM

            ).to(DEVICE)



            fake=G(z)



            output_real=D(real)

            output_fake=D(
                fake.detach()
            )



            if method=="Label Smoothing":

                real_label*=0.9



            loss_D=(

                criterion(
                    output_real,
                    real_label
                )

                +

                criterion(
                    output_fake,
                    fake_label
                )

            )/2



            if method=="Gradient Penalty":


                gp=gradient_penalty(

                    D,

                    real,

                    fake.detach()

                )


                loss_D += 10*gp



            optimizer_D.zero_grad()

            loss_D.backward()

            optimizer_D.step()



            # -----------------
            # Train G
            # -----------------


            z=torch.randn(

                batch_size,

                LATENT_DIM

            ).to(DEVICE)



            fake=G(z)



            output=D(fake)



            loss_G=criterion(

                output,

                real_label

            )



            optimizer_G.zero_grad()

            loss_G.backward()

            optimizer_G.step()



        G_losses.append(
            loss_G.item()
        )


        D_losses.append(
            loss_D.item()
        )



        print(

            f"Epoch {epoch+1}/{EPOCHS}"

            f" D:{loss_D.item():.4f}"

            f" G:{loss_G.item():.4f}"

        )



    return G,D,G_losses,D_losses





# =========================
# main
# =========================


def main():
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib


    methods=[

        "Vanilla",

        "Label Smoothing",

        "Gradient Penalty"

    ]


    images=[]


    plt.figure()



    for method in methods:


        G,D,G_loss,D_loss=train_gan(
            method
        )



        torch.save(

            G.state_dict(),

            f"{RESULT_DIR}/{method}_generator.pth"

        )



        torch.save(

            D.state_dict(),

            f"{RESULT_DIR}/{method}_discriminator.pth"

        )



        plt.plot(

            G_loss,

            label=method

        )



        z=torch.randn(

            64,

            LATENT_DIM

        ).to(DEVICE)



        fake=G(z)



        grid=make_grid(

            fake,

            nrow=8,

            normalize=True

        )



        save_image(

            grid,

            f"{RESULT_DIR}/{method}.png"

        )



        images.append(grid)



    plt.xlabel(
        "Epoch"
    )

    plt.ylabel(
        "Generator Loss"
    )


    plt.legend()


    plt.savefig(

        f"{RESULT_DIR}/loss_curve.png"

    )



    comparison=torch.cat(

        images,

        dim=2

    )


    save_image(

        comparison,

        f"{RESULT_DIR}/comparison.png"

    )




if __name__=="__main__":

    main()