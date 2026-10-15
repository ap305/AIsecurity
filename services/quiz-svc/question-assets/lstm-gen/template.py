"""
LSTM 文本生成实验（学生代码）

任务：
1. 定义 LSTM 层（nn.LSTM，batch_first=True）
2. 定义 Linear 输出层（hidden_size -> vocab_size）
3. 完成 forward：embedding -> lstm -> fc

模型类 LSTMTextGenerator 的 embedding 已提供，只需完成 TODO 1/2/3。
评测仅检查模型结构与前向输出形状，无需训练或数据集。
"""

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader


# ==========================
# 参数设置
# ==========================

DATA_PATH = "dataset/tiny_shakespeare.txt"
MODEL_PATH = "lstm_model.pth"

SEQ_LENGTH = 100
BATCH_SIZE = 64
EPOCHS = 10
EMBED_SIZE = 64
HIDDEN_SIZE = 128
LEARNING_RATE = 0.001

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ==========================
# 数据读取与数据集
# ==========================

def load_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


class TextDataset(Dataset):
    def __init__(self, text, seq_length):
        self.seq_length = seq_length
        chars = sorted(list(set(text)))
        self.char_to_idx = {ch: i for i, ch in enumerate(chars)}
        self.idx_to_char = {i: ch for i, ch in enumerate(chars)}
        self.data = [self.char_to_idx[ch] for ch in text]

    def __len__(self):
        return len(self.data) - self.seq_length

    def __getitem__(self, index):
        x = self.data[index:index + self.seq_length]
        y = self.data[index + 1:index + self.seq_length + 1]
        return (
            torch.tensor(x, dtype=torch.long),
            torch.tensor(y, dtype=torch.long),
        )


# ==========================
# LSTM 文本生成模型
# ==========================

class LSTMTextGenerator(nn.Module):
    def __init__(self, vocab_size, embed_size, hidden_size):
        super().__init__()

        # 已提供：Embedding 层
        self.embedding = nn.Embedding(vocab_size, embed_size)

        # TODO 1: 定义 LSTM 层
        # self.lstm = nn.LSTM(embed_size, hidden_size, batch_first=True)
        pass

        # TODO 2: 定义 Linear 输出层
        # self.fc = nn.Linear(hidden_size, vocab_size)
        pass

    def forward(self, x):
        # TODO 3: 完成前向传播 embedding -> lstm -> fc
        pass


# ==========================
# 训练函数
# ==========================

def train(model, dataloader):
    criterion = nn.CrossEntropyLoss()
    optimizer = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    model.train()

    for epoch in range(EPOCHS):
        total_loss = 0
        for x, y in dataloader:
            x = x.to(DEVICE)
            y = y.to(DEVICE)
            output = model(x)
            loss = criterion(
                output.reshape(-1, output.size(-1)),
                y.reshape(-1),
            )
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        print(f"Epoch [{epoch + 1}/{EPOCHS}] Loss:{total_loss / len(dataloader):.4f}")


# ==========================
# 文本生成
# ==========================

def generate_text(model, start_text, char_to_idx, idx_to_char, length=200):
    model.eval()
    input_ids = [char_to_idx[c] for c in start_text]
    input_tensor = torch.tensor(input_ids).unsqueeze(0).to(DEVICE)
    result = start_text

    with torch.no_grad():
        for _ in range(length):
            output = model(input_tensor)
            next_id = torch.argmax(output[:, -1, :], dim=-1).item()
            result += idx_to_char[next_id]
            next_tensor = torch.tensor([[next_id]]).to(DEVICE)
            input_tensor = torch.cat([input_tensor, next_tensor], dim=1)

    return result


# ==========================
# 主函数
# ==========================

def main():
    text = load_text(DATA_PATH)
    dataset = TextDataset(text, SEQ_LENGTH)
    dataloader = DataLoader(dataset, batch_size=BATCH_SIZE, shuffle=True)

    model = LSTMTextGenerator(
        len(dataset.char_to_idx), EMBED_SIZE, HIDDEN_SIZE
    ).to(DEVICE)

    train(model, dataloader)

    torch.save(
        {
            "model": model.state_dict(),
            "char_to_idx": dataset.char_to_idx,
            "idx_to_char": dataset.idx_to_char,
        },
        MODEL_PATH,
    )

    print(generate_text(model, "ROMEO:", dataset.char_to_idx, dataset.idx_to_char))


if __name__ == "__main__":
    main()
