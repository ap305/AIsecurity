"""DCGAN 图像生成实验 - 参考解答"""

import numpy as np
import os
import torch
import torch.nn as nn
import torch.optim as optim

from datasets import load_from_disk
from torch.utils.data import Dataset, DataLoader
from torchvision.utils import save_image


MNIST_PATH = "./mnist_huggingface"
OUTPUT_DIR = "./results"

EPOCHS = 20
BATCH_SIZE = 128
LR = 0.0002
NOISE_DIM = 100
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


class Generator(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.ConvTranspose2d(100, 256, 7),
            nn.BatchNorm2d(256),
            nn.ReLU(),
            nn.ConvTranspose2d(256, 128, 4, 2, 1),
            nn.BatchNorm2d(128),
            nn.ReLU(),
            nn.ConvTranspose2d(128, 64, 4, 2, 1),
            nn.BatchNorm2d(64),
            nn.ReLU(),
            nn.Conv2d(64, 1, 3, 1, 1),
            nn.Tanh(),
        )

    def forward(self, x):
        return self.net(x)


class Discriminator(nn.Module):
    def __init__(self):
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv2d(1, 64, 4, 2, 1),
            nn.LeakyReLU(0.2),
            nn.Conv2d(64, 128, 4, 2, 1),
            nn.BatchNorm2d(128),
            nn.LeakyReLU(0.2),
            nn.Conv2d(128, 1, 7),
            nn.Sigmoid(),
        )

    def forward(self, x):
        return self.net(x).view(-1)


class MNISTDataset(Dataset):
    def __init__(self, data):
        self.data = data

    def __len__(self):
        return len(self.data)

    def __getitem__(self, i):
        image = self.data[i]["image"]
        image = np.array(image)
        image = torch.tensor(image, dtype=torch.float32)
        image = image.unsqueeze(0)
        image = image / 255.0
        image = image * 2 - 1
        return image, 0


def get_loader():
    data = load_from_disk(MNIST_PATH)
    return DataLoader(
        MNISTDataset(data["train"]),
        batch_size=BATCH_SIZE,
        shuffle=True,
    )


def main():
    import matplotlib.pyplot as plt

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    loader = get_loader()

    G = Generator().to(DEVICE)
    D = Discriminator().to(DEVICE)

    criterion = nn.BCELoss()
    optG = optim.Adam(G.parameters(), lr=LR, betas=(0.5, 0.999))
    optD = optim.Adam(D.parameters(), lr=LR, betas=(0.5, 0.999))

    fixed_noise = torch.randn(64, NOISE_DIM, 1, 1).to(DEVICE)
    g_loss = []
    d_loss = []

    for epoch in range(EPOCHS):
        for img, _ in loader:
            img = img.to(DEVICE)
            n = img.size(0)
            real = torch.ones(n).to(DEVICE)
            fake = torch.zeros(n).to(DEVICE)

            D.zero_grad()
            loss1 = criterion(D(img), real)
            z = torch.randn(n, NOISE_DIM, 1, 1).to(DEVICE)
            fake_img = G(z)
            loss2 = criterion(D(fake_img.detach()), fake)
            lossD = loss1 + loss2
            lossD.backward()
            optD.step()

            G.zero_grad()
            lossG = criterion(D(fake_img), real)
            lossG.backward()
            optG.step()

            g_loss.append(lossG.item())
            d_loss.append(lossD.item())

        print(f"Epoch {epoch + 1}/{EPOCHS} G:{lossG.item():.4f} D:{lossD.item():.4f}")
        save_image(G(fixed_noise).detach().cpu(), f"{OUTPUT_DIR}/epoch_{epoch + 1}.png", nrow=8, normalize=True)

    torch.save(G.state_dict(), OUTPUT_DIR + "/generator.pth")
    torch.save(D.state_dict(), OUTPUT_DIR + "/discriminator.pth")
    save_image(G(fixed_noise).detach().cpu(), OUTPUT_DIR + "/generated_images.png", nrow=8, normalize=True)

    plt.plot(g_loss, label="G")
    plt.plot(d_loss, label="D")
    plt.legend()
    plt.grid()
    plt.savefig(OUTPUT_DIR + "/loss_curve.png")

    print("DCGAN训练完成")


if __name__ == "__main__":
    main()
