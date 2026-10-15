"""
GAN训练稳定性对比实验

Todo_code.py

学生完成文件


任务：

1. 完成 Generator 网络结构

2. 完成 Discriminator 网络结构

3. 完成 Gradient Penalty

4. 完成 GAN训练过程


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


        image = np.array(image)


        image = torch.tensor(
            image,
            dtype=torch.float32
        )


        image = image / 127.5 - 1


        image = image.unsqueeze(0)


        return image, item["label"]




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



        # TODO:
        #
        # 补充Generator网络结构
        #
        # 输入:
        # [batch,100]
        #
        # 输出:
        # [batch,1,28,28]
        #


        self.model = nn.Sequential(

            # TODO


        )



    def forward(self,z):


        # TODO:
        #
        # 完成前向传播
        #
        # 要求输出:
        # [batch,1,28,28]


        pass





# =========================
# Discriminator
# =========================


class Discriminator(nn.Module):

    def __init__(self):

        super().__init__()



        # TODO:
        #
        # 补充判别器网络
        #
        # 输入:
        # [batch,1,28,28]
        #
        # 输出:
        # [batch,1]
        #


        self.model = nn.Sequential(


            # TODO


        )




    def forward(self,img):


        # TODO:
        #
        # 完成前向传播
        #
        # 注意:
        # 输入需要Flatten


        pass





# =========================
# Gradient Penalty
# =========================


def gradient_penalty(

        D,

        real,

        fake

):


    """

    TODO:

    实现Gradient Penalty


    返回:

    gp

    """


    pass







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





            # =====================
            # Train Discriminator
            # =====================


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



            # TODO:
            #
            # 计算Discriminator loss
            #


            loss_D = None




            if method=="Gradient Penalty":


                # TODO:
                #
                # 添加Gradient Penalty
                #


                pass




            optimizer_D.zero_grad()


            loss_D.backward()


            optimizer_D.step()





            # =====================
            # Train Generator
            # =====================



            z=torch.randn(

                batch_size,

                LATENT_DIM

            ).to(DEVICE)



            fake=G(z)



            output=D(fake)



            # TODO:
            #
            # 计算Generator loss
            #


            loss_G=None



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