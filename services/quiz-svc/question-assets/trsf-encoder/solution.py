"""
Transformer编码器文本分类实验

教师参考代码


任务：

1. 文本数据加载
2. Token Embedding
3. Position Embedding
4. Multi-Head Self Attention
5. Transformer Encoder
6. 文本分类训练


数据:

data/
└── AGNews/
    ├── train.csv
    └── test.csv


输出:

results/

├── transformer_encoder.pth

└── loss_curve.png

"""


import os
import re
import math
import random


import pandas as pd
import numpy as np


import torch
import torch.nn as nn
import torch.nn.functional as F


from torch.utils.data import Dataset, DataLoader




from collections import Counter





# ============================
# 参数设置
# ============================


DATA_PATH="./data/AGNews"


EPOCHS=10


BATCH_SIZE=64


LR=1e-3


MAX_LEN=64


EMBED_DIM=128


NUM_HEADS=4


NUM_LAYERS=2


HIDDEN_DIM=256


NUM_CLASSES=4


MODEL_PATH="results/transformer_encoder.pth"



device=torch.device(
    "cuda"
    if torch.cuda.is_available()
    else "cpu"
)





# ============================
# 随机种子
# ============================


def set_seed(seed=42):


    random.seed(seed)

    np.random.seed(seed)

    torch.manual_seed(seed)

    if torch.cuda.is_available():

        torch.cuda.manual_seed(seed)



set_seed()





# ============================
# 文本处理
# ============================


def tokenize(text):


    text=text.lower()


    words=re.findall(
        r"\b[a-z]+\b",
        text
    )


    return words





# ============================
# 构建词表
# ============================


def build_vocab(
        texts,
        min_freq=2
):


    counter=Counter()


    for text in texts:


        counter.update(
            tokenize(text)
        )



    vocab={

        "<PAD>":0,

        "<UNK>":1

    }



    for word,count in counter.items():


        if count>=min_freq:

            vocab[word]=len(vocab)



    return vocab





# ============================
# Dataset
# ============================


class AGNewsDataset(Dataset):


    def __init__(
            self,
            dataframe,
            vocab
    ):


        self.texts=dataframe["text"].tolist()


        self.labels=dataframe["label"].tolist()


        self.vocab=vocab



    def __len__(self):

        return len(self.texts)




    def __getitem__(
            self,
            index
    ):


        tokens=tokenize(
            self.texts[index]
        )



        ids=[

            self.vocab.get(
                word,
                1
            )

            for word in tokens

        ]



        ids=ids[:MAX_LEN]



        if len(ids)<MAX_LEN:


            ids += [

                0

            ]*(MAX_LEN-len(ids))



        return (

            torch.tensor(
                ids,
                dtype=torch.long
            ),

            torch.tensor(
                self.labels[index],
                dtype=torch.long
            )

        )







# ============================
# Multi Head Attention
# ============================


class MultiHeadAttention(nn.Module):


    def __init__(
            self,
            embed_dim,
            num_heads
    ):


        super().__init__()


        self.embed_dim=embed_dim

        self.num_heads=num_heads


        self.head_dim=(
            embed_dim//num_heads
        )


        assert (
            self.head_dim*num_heads
            ==
            embed_dim
        )



        self.q_linear=nn.Linear(
            embed_dim,
            embed_dim
        )


        self.k_linear=nn.Linear(
            embed_dim,
            embed_dim
        )


        self.v_linear=nn.Linear(
            embed_dim,
            embed_dim
        )


        self.out_linear=nn.Linear(
            embed_dim,
            embed_dim
        )





    def forward(
            self,
            x
    ):


        batch_size=x.size(0)



        Q=self.q_linear(x)

        K=self.k_linear(x)

        V=self.v_linear(x)



        Q=Q.view(
            batch_size,
            -1,
            self.num_heads,
            self.head_dim
        ).transpose(
            1,
            2
        )


        K=K.view(
            batch_size,
            -1,
            self.num_heads,
            self.head_dim
        ).transpose(
            1,
            2
        )


        V=V.view(
            batch_size,
            -1,
            self.num_heads,
            self.head_dim
        ).transpose(
            1,
            2
        )



        attention=torch.matmul(
            Q,
            K.transpose(
                -2,
                -1
            )
        )


        attention /= math.sqrt(
            self.head_dim
        )



        attention=F.softmax(
            attention,
            dim=-1
        )



        output=torch.matmul(
            attention,
            V
        )



        output=output.transpose(
            1,
            2
        ).contiguous()



        output=output.view(
            batch_size,
            -1,
            self.embed_dim
        )



        return self.out_linear(
            output
        )







# ============================
# Transformer Encoder Layer
# ============================


class TransformerEncoderLayer(nn.Module):


    def __init__(
            self,
            embed_dim,
            num_heads,
            hidden_dim
    ):


        super().__init__()



        self.attention=MultiHeadAttention(
            embed_dim,
            num_heads
        )



        self.norm1=nn.LayerNorm(
            embed_dim
        )


        self.norm2=nn.LayerNorm(
            embed_dim
        )



        self.ffn=nn.Sequential(

            nn.Linear(
                embed_dim,
                hidden_dim
            ),

            nn.ReLU(),

            nn.Linear(
                hidden_dim,
                embed_dim
            )

        )




    def forward(
            self,
            x
    ):


        attn=self.attention(
            x
        )


        x=self.norm1(
            x+attn
        )


        output=self.ffn(
            x
        )


        x=self.norm2(
            x+output
        )


        return x






# ============================
# Transformer Encoder
# ============================


class TransformerEncoder(nn.Module):


    def __init__(
            self,
            vocab_size
    ):


        super().__init__()



        self.embedding=nn.Embedding(
            vocab_size,
            EMBED_DIM
        )


        self.position_embedding=nn.Embedding(
            MAX_LEN,
            EMBED_DIM
        )



        self.layers=nn.ModuleList(

            [

                TransformerEncoderLayer(
                    EMBED_DIM,
                    NUM_HEADS,
                    HIDDEN_DIM
                )

                for _ in range(NUM_LAYERS)

            ]

        )



        self.classifier=nn.Linear(
            EMBED_DIM,
            NUM_CLASSES
        )





    def forward(
            self,
            x
    ):


        batch_size=x.size(0)



        positions=torch.arange(
            MAX_LEN,
            device=x.device
        ).unsqueeze(0)



        x=self.embedding(x)



        x=x+self.position_embedding(
            positions
        )



        for layer in self.layers:


            x=layer(
                x
            )



        x=x.mean(
            dim=1
        )



        return self.classifier(
            x
        )







# ============================
# 数据加载
# ============================


def load_data():


    train_df=pd.read_csv(
        os.path.join(
            DATA_PATH,
            "train.csv"
        )
    )


    test_df=pd.read_csv(
        os.path.join(
            DATA_PATH,
            "test.csv"
        )
    )



    vocab=build_vocab(
        train_df["text"]
    )



    train_dataset=AGNewsDataset(
        train_df,
        vocab
    )


    test_dataset=AGNewsDataset(
        test_df,
        vocab
    )



    train_loader=DataLoader(
        train_dataset,
        batch_size=BATCH_SIZE,
        shuffle=True
    )


    test_loader=DataLoader(
        test_dataset,
        batch_size=BATCH_SIZE
    )



    return (
        train_loader,
        test_loader,
        vocab
    )







# ============================
# 测试
# ============================


def evaluate(
        model,
        loader
):


    model.eval()


    correct=0

    total=0



    with torch.no_grad():


        for x,y in loader:


            x=x.to(device)

            y=y.to(device)



            output=model(
                x
            )



            pred=torch.argmax(
                output,
                dim=1
            )



            correct += (
                pred==y
            ).sum().item()



            total += y.size(0)



    return correct/total






# ============================
# 训练
# ============================


def train():
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib


    train_loader,test_loader,vocab=load_data()



    model=TransformerEncoder(
        len(vocab)
    ).to(device)



    optimizer=torch.optim.Adam(
        model.parameters(),
        lr=LR
    )



    criterion=nn.CrossEntropyLoss()



    loss_history=[]



    for epoch in range(
        EPOCHS
    ):


        model.train()


        total_loss=0



        for x,y in train_loader:


            x=x.to(device)

            y=y.to(device)



            optimizer.zero_grad()



            output=model(
                x
            )



            loss=criterion(
                output,
                y
            )


            loss.backward()


            optimizer.step()



            total_loss+=loss.item()



        avg_loss=(
            total_loss/
            len(train_loader)
        )


        loss_history.append(
            avg_loss
        )


        acc=evaluate(
            model,
            test_loader
        )


        print(
            f"Epoch {epoch+1}/{EPOCHS}, "
            f"Loss:{avg_loss:.4f}, "
            f"Test Acc:{acc:.4f}"
        )



    os.makedirs(
        "results",
        exist_ok=True
    )



    torch.save(
        model.state_dict(),
        MODEL_PATH
    )



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
        "Transformer Encoder Training Loss"
    )



    plt.savefig(
        "results/loss_curve.png"
    )


    plt.close()



    print(
        "Training Finished!"
    )


if __name__=="__main__":

    train()