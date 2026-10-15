"""多头注意力可视化实验 - 参考解答"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F

EMBED_DIM = 128
NUM_HEADS = 4
SEQ_LEN = 10

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


class MultiHeadAttention(nn.Module):
    def __init__(self, embed_dim, num_heads):
        super().__init__()
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.head_dim = embed_dim // num_heads
        assert self.head_dim * num_heads == embed_dim

        self.q_linear = nn.Linear(embed_dim, embed_dim)
        self.k_linear = nn.Linear(embed_dim, embed_dim)
        self.v_linear = nn.Linear(embed_dim, embed_dim)
        self.out_linear = nn.Linear(embed_dim, embed_dim)

    def forward(self, x):
        batch_size = x.size(0)

        Q = self.q_linear(x)
        K = self.k_linear(x)
        V = self.v_linear(x)

        Q = Q.view(batch_size, -1, self.num_heads, self.head_dim).transpose(1, 2)
        K = K.view(batch_size, -1, self.num_heads, self.head_dim).transpose(1, 2)
        V = V.view(batch_size, -1, self.num_heads, self.head_dim).transpose(1, 2)

        scores = torch.matmul(Q, K.transpose(-2, -1)) / math.sqrt(self.head_dim)
        attention = F.softmax(scores, dim=-1)

        out = torch.matmul(attention, V)
        out = out.transpose(1, 2).contiguous().view(batch_size, -1, self.embed_dim)
        output = self.out_linear(out)

        return output, attention


def visualize_attention(attention, tokens):
    import matplotlib.pyplot as plt
    import os

    os.makedirs("results", exist_ok=True)
    attention = attention[0]
    for head in range(attention.size(0)):
        matrix = attention[head].detach().cpu()
        plt.figure(figsize=(8, 6))
        plt.imshow(matrix, cmap="viridis")
        plt.xticks(range(len(tokens)), tokens, rotation=45)
        plt.yticks(range(len(tokens)), tokens)
        plt.xlabel("Key Tokens")
        plt.ylabel("Query Tokens")
        plt.title(f"Attention Head {head + 1}")
        plt.colorbar()
        plt.tight_layout()
        plt.savefig(f"results/attention_head_{head + 1}.png")
        plt.close()


def main():
    tokens = [
        "deep", "learning", "models", "can", "learn",
        "complex", "feature", "representations", "from", "data",
    ]
    vocab_size = 100
    token_ids = torch.randint(0, vocab_size, (1, SEQ_LEN))
    embedding = nn.Embedding(vocab_size, EMBED_DIM)
    x = embedding(token_ids)

    model = MultiHeadAttention(EMBED_DIM, NUM_HEADS).to(device)
    x = x.to(device)
    model.eval()
    with torch.no_grad():
        output, attention = model(x)
    print("Output shape:", output.shape)
    print("Attention shape:", attention.shape)
    visualize_attention(attention, tokens)
    print("Visualization finished!")


if __name__ == "__main__":
    main()
