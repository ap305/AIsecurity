"""基础 RNN 序列分类实验（参考解答）"""

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
import pandas as pd

EPOCHS = 50
BATCH_SIZE = 64
LEARNING_RATE = 0.001

INPUT_SIZE = 1
HIDDEN_SIZE = 64
NUM_CLASSES = 2

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


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
        sequence = torch.tensor(sequence, dtype=torch.float32).unsqueeze(1)
        label = torch.tensor(label, dtype=torch.long)
        return sequence, label


class RNNClassifier(nn.Module):
    def __init__(self):
        super().__init__()
        self.rnn = nn.RNN(input_size=INPUT_SIZE, hidden_size=HIDDEN_SIZE, batch_first=True)
        self.fc = nn.Linear(HIDDEN_SIZE, NUM_CLASSES)

    def forward(self, x):
        output, hidden = self.rnn(x)
        hidden = hidden[-1]
        output = self.fc(hidden)
        return output


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
    train(model, train_loader)

    torch.save(model.state_dict(), "rnn_model.pth")
    results = test(model, test_loader)
    pd.DataFrame(results).to_csv("test_results.csv", index=False)


if __name__ == "__main__":
    main()
