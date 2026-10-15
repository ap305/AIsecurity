"""
经典 CNN 图像分类架构对比实验 - 教师参考代码

学生任务：仅完成 AlexNetMini 和 VGGNetMini 两个模型类中的 TODO。
LeNet、数据读取、训练、测试、保存和可视化流程均已给出。
不得修改模型类名和指定属性名。
"""

from __future__ import annotations

from pathlib import Path
import time
import pandas as pd
import torch
import torch.nn as nn
from datasets import Dataset
from torch.utils.data import DataLoader
from torchvision import transforms
BASE_DIR = Path(__file__).resolve().parent
TRAIN_ARROW = BASE_DIR / "mnist_huggingface" / "train" / "data-00000-of-00001.arrow"
TEST_ARROW = BASE_DIR / "mnist_huggingface" / "test" / "data-00000-of-00001.arrow"
EPOCHS = 5
BATCH_SIZE = 64
LEARNING_RATE = 0.001

class MNISTArrowDataset(torch.utils.data.Dataset):
    def __init__(self, arrow_path: Path):
        if not arrow_path.exists():
            raise FileNotFoundError(f"未找到数据文件：{arrow_path}")
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
            nn.Flatten(), nn.Linear(16*5*5, 120), nn.ReLU(),
            nn.Linear(120, 84), nn.ReLU(), nn.Linear(84, 10),
        )
    def forward(self, x):
        return self.classifier(self.features(x))


class AlexNetMini(nn.Module):
    """适配 1x28x28 MNIST 图像的 AlexNet 风格网络。"""
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1,32,5,padding=2), nn.ReLU(), nn.MaxPool2d(2,2),
            nn.Conv2d(32,64,3,padding=1), nn.ReLU(), nn.MaxPool2d(2,2),
            nn.Conv2d(64,128,3,padding=1), nn.ReLU(),
            nn.AdaptiveAvgPool2d((3,3)),
        )

        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(128*3*3,256), nn.ReLU(), nn.Dropout(0.5),
            nn.Linear(256,128), nn.ReLU(), nn.Dropout(0.5), nn.Linear(128,10),
        )

    def forward(self, x):
        return self.classifier(self.features(x))

class VGGNetMini(nn.Module):
    """适配 1x28x28 MNIST 图像的 VGG 风格网络。"""
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1,32,3,padding=1), nn.ReLU(),
            nn.Conv2d(32,32,3,padding=1), nn.ReLU(), nn.MaxPool2d(2,2),
            nn.Conv2d(32,64,3,padding=1), nn.ReLU(),
            nn.Conv2d(64,64,3,padding=1), nn.ReLU(), nn.MaxPool2d(2,2),
            nn.Conv2d(64,128,3,padding=1), nn.ReLU(),
            nn.Conv2d(128,128,3,padding=1), nn.ReLU(),
            nn.AdaptiveAvgPool2d((3,3)),
        )

        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(128*3*3,256), nn.ReLU(), nn.Dropout(0.5), nn.Linear(256,10),
        )

    def forward(self, x):
        return self.classifier(self.features(x))


def count_parameters(model):
    return sum(p.numel() for p in model.parameters() if p.requires_grad)

@torch.no_grad()
def evaluate(model, loader, device):
    model.eval(); correct=0; total=0
    start=time.perf_counter()
    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)
        pred=model(images).argmax(1)
        correct += (pred==labels).sum().item(); total += labels.size(0)
    elapsed=time.perf_counter()-start
    return 100*correct/total, elapsed*1000/total

def train_one_model(name, model, train_loader, test_loader, device):
    model=model.to(device)
    criterion=nn.CrossEntropyLoss()
    optimizer=torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    losses=[]; train_accs=[]
    for epoch in range(1,EPOCHS+1):
        model.train(); total_loss=0.0; correct=0; total=0
        for images, labels in train_loader:
            images, labels=images.to(device), labels.to(device)
            optimizer.zero_grad(); outputs=model(images); loss=criterion(outputs,labels)
            loss.backward(); optimizer.step()
            total_loss += loss.item()*labels.size(0)
            correct += (outputs.argmax(1)==labels).sum().item(); total += labels.size(0)
        avg_loss=total_loss/total; acc=100*correct/total
        losses.append(avg_loss); train_accs.append(acc)
        print(f"{name} Epoch {epoch}/{EPOCHS}, Loss={avg_loss:.4f}, Accuracy={acc:.2f}%")
    test_acc, ms_per_sample=evaluate(model,test_loader,device)
    model_path = BASE_DIR / f"{name.lower()}_model.pth"
    model_path.parent.mkdir(parents=True, exist_ok=True)

    # 使用 Python 文件对象保存，兼容旧版 PyTorch 的 Windows 中文路径。
    with open(model_path, "wb") as file:
        torch.save(model.state_dict(), file)

    print(f"{name} 模型已保存：{model_path}")
    return losses, train_accs, test_acc, ms_per_sample, count_parameters(model)

def main():
    train_ds=MNISTArrowDataset(TRAIN_ARROW); test_ds=MNISTArrowDataset(TEST_ARROW)
    train_loader=DataLoader(train_ds,batch_size=BATCH_SIZE,shuffle=True)
    test_loader=DataLoader(test_ds,batch_size=128,shuffle=False)
    device=torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print('使用设备：',device)
    models={'LeNet':LeNet(),'AlexNetMini':AlexNetMini(),'VGGNetMini':VGGNetMini()}
    histories={}; rows=[]
    for name,model in models.items():
        losses,accs,test_acc,ms,params=train_one_model(name,model,train_loader,test_loader,device)
        histories[name]=losses
        rows.append({'model':name,'parameters':params,'test_accuracy':test_acc,'ms_per_sample':ms})
    # 平台提交：将三个模型的 state_dict 合并保存为单个文件 cnn_models.pth
    combined_path = BASE_DIR / 'cnn_models.pth'
    with open(combined_path, 'wb') as _f:
        torch.save({name: m.state_dict() for name, m in models.items()}, _f)
    print(f'合并模型已保存：{combined_path}（请上传此文件）')

    pd.DataFrame(rows).to_csv(BASE_DIR/'cnn_comparison_results.csv',index=False,encoding='utf-8-sig')
    print('实验完成，结果已保存。')

if __name__=='__main__':
    main()