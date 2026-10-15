"""
基础 RNN 序列分类实验（学生代码）

实验任务：判断数字序列中是否包含模式 [7, 5]

学生完成：
1. RNN 网络结构（self.rnn）
2. 分类层结构（self.fc）
3. forward 前向传播

已提供：数据读取、Dataset、训练流程、测试流程、模型保存

注意：评测环境不安装 matplotlib，请勿在顶层 import matplotlib，
     否则评测程序导入本模块时会失败。如需绘制 loss 曲线，请在本地
     训练时自行添加，提交前删除相关 import。
"""

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import pandas as pd

# =========================
# 参数设置
# =========================
EPOCHS = 10
BATCH_SIZE = 64
LEARNING_RATE = 0.001

SEQ_LEN = 20
INPUT_SIZE = 1
HIDDEN_SIZE = 64
NUM_CLASSES = 2

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# =========================
# Dataset
# =========================
class SequenceDataset(Dataset):
    def __init__(self, csv_file):
        data = pd.read_csv(csv_file)
        self.sequences = []
        self.labels = []
        for _, row in data.iterrows():
            seq = [int(x) for x in row["sequence"].split()]
            self.sequences.append(seq)
            self.labels.append(int(row["label"]))

    def __len__(self):
        return len(self.labels)

    def __getitem__(self, index):
        sequence = self.sequences[index]
        label = self.labels[index]
        # 转换为 RNN 输入格式: (sequence_length, input_size)，input_size = 1
        sequence = torch.tensor(sequence, dtype=torch.float32).unsqueeze(1)
        label = torch.tensor(label, dtype=torch.long)
        return sequence, label


# =========================
# RNN 模型
# =========================
class RNNClassifier(nn.Module):
    def __init__(self):
        super().__init__()

        # TODO 1: 定义 RNN 层
        # 输入序列形状: (batch_size, sequence_length, input_size)
        # input_size = INPUT_SIZE, hidden_size = HIDDEN_SIZE, batch_first=True
        # 使用 nn.RNN()
        self.rnn = None

        # TODO 2: 定义分类层
        # 输入: RNN 最后隐藏状态；输出: 2 个类别
        # 使用 nn.Linear()
        self.fc = None

    def forward(self, x):
        # TODO 3: 使用 RNN 处理输入序列
        # output, hidden = self.rnn(x)
        output = None
        hidden = None

        # TODO 4: 获取最后隐藏状态
        # hidden 形状: (1, batch_size, hidden_size)，需转换为 (batch_size, hidden_size)
        # 提示: hidden[-1]
        hidden = None

        # TODO 5: 使用分类层输出结果，输出形状 (batch_size, 2)
        output = None
        return output


# =========================
# 训练函数
# =========================
def train(model, loader):
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    losses = []
    model.train()
    for epoch in range(EPOCHS):
        total_loss = 0
        for x, y in loader:
            x = x.to(DEVICE)
            y = y.to(DEVICE)
            optimizer.zero_grad()
            output = model(x)
            loss = criterion(output, y)
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        avg_loss = total_loss / len(loader)
        losses.append(avg_loss)
        print(f"Epoch {epoch + 1}/{EPOCHS} Loss:{avg_loss:.4f}")
    return losses


# =========================
# 测试函数
# =========================
def test(model, loader):
    model.eval()
    correct = 0
    total = 0
    results = []
    with torch.no_grad():
        for x, y in loader:
            x = x.to(DEVICE)
            output = model(x)
            pred = torch.argmax(output, dim=1)
            correct += (pred.cpu() == y).sum().item()
            total += len(y)
            for p, t in zip(pred.cpu(), y):
                results.append({"prediction": int(p), "label": int(t)})
    acc = correct / total
    print("Accuracy:", acc)
    return results


# =========================
# 主程序
# =========================
def main():
    dataset = SequenceDataset("sequence_dataset.csv")
    train_size = int(len(dataset) * 0.8)
    test_size = len(dataset) - train_size
    train_dataset, test_dataset = torch.utils.data.random_split(
        dataset, [train_size, test_size],
        generator=torch.Generator().manual_seed(42),
    )
    train_loader = DataLoader(train_dataset, batch_size=BATCH_SIZE, shuffle=True)
    test_loader = DataLoader(test_dataset, batch_size=BATCH_SIZE)

    model = RNNClassifier()
    model.to(DEVICE)
    losses = train(model, train_loader)

    torch.save(model.state_dict(), "rnn_model.pth")

    results = test(model, test_loader)
    pd.DataFrame(results).to_csv("test_results.csv", index=False)


if __name__ == "__main__":
    main()
