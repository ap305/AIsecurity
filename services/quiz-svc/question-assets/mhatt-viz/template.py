"""
多头注意力可视化实验（学生代码）

任务：完成 MultiHeadAttention 模块
1. 定义 Q/K/V 映射层与输出 Linear 层
2. 完成 Multi-Head 拆分
3. 完成 Scaled Dot-Product Attention
4. 返回 Attention 权重用于可视化

注意：评测环境不安装 matplotlib。本题评测通过导入本模块、检查 MultiHeadAttention
的结构与前向输出来完成，无需生成图片。matplotlib 仅在 visualize_attention 内部
懒加载，供本地可视化使用；提交前不要在顶层 import matplotlib。
"""

import math

import torch
import torch.nn as nn
import torch.nn.functional as F


# ============================
# 参数
# ============================

EMBED_DIM = 128
NUM_HEADS = 4
SEQ_LEN = 10

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ============================
# Multi Head Attention
# ============================

class MultiHeadAttention(nn.Module):
    def __init__(self, embed_dim, num_heads):
        super().__init__()
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.head_dim = embed_dim // num_heads
        assert self.head_dim * num_heads == embed_dim

        # TODO: 定义以下四个 Linear 层
        # 1. self.q_linear  (embed_dim -> embed_dim)
        # 2. self.k_linear  (embed_dim -> embed_dim)
        # 3. self.v_linear  (embed_dim -> embed_dim)
        # 4. self.out_linear(embed_dim -> embed_dim)
        pass

    def forward(self, x):
        batch_size = x.size(0)

        # TODO: 完成 Multi-Head Attention 计算
        # 1. 计算 Q、K、V
        # 2. 拆分为多个 head: (batch, num_heads, seq, head_dim)
        # 3. scores = Q @ K^T / sqrt(head_dim)
        # 4. attention = softmax(scores, dim=-1)
        # 5. out = attention @ V
        # 6. 合并 head -> (batch, seq, embed_dim)
        # 7. output = out_linear(out)
        # 返回: output, attention
        pass


# ============================
# Attention 可视化（本地使用，评测不执行）
# ============================

def visualize_attention(attention, tokens):
    """attention: [batch, heads, seq, seq]"""
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib
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


# ============================
# 主程序
# ============================

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
