"""
Transformer编码器文本分类实验

学生代码


任务：

1. 完成 MultiHeadAttention
2. 完成 TransformerEncoderLayer
3. 完成 TransformerEncoder


数据：

data/
└── AGNews/
    ├── train.csv
    └── test.csv


输出：

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







# ======================================================
# 学生任务1：MultiHeadAttention
# ======================================================


class MultiHeadAttention(nn.Module):


    def __init__(
            self,
            embed_dim,
            num_heads
    ):


        super().__init__()



        #################################################
        #
        # TODO:
        #
        # 定义多头注意力参数
        #
        # 需要包含：
        #
        # self.q_linear
        # self.k_linear
        # self.v_linear
        # self.out_linear
        #
        #################################################


        self.embed_dim=embed_dim

        self.num_heads=num_heads


        self.head_dim=embed_dim//num_heads



        pass






    def forward(
            self,
            x
    ):


        #################################################
        #
        # TODO:
        #
        # 完成Self-Attention计算
        #
        # 流程：
        #
        # 1. Q,K,V映射
        # 2. 多头拆分
        # 3. Attention计算
        # 4. 多头合并
        # 5. 输出映射
        #
        #################################################



        pass







# ======================================================
# 学生任务2：Transformer Encoder Layer
# ======================================================


class TransformerEncoderLayer(nn.Module):


    def __init__(
            self,
            embed_dim,
            num_heads,
            hidden_dim
    ):


        super().__init__()



        #################################################
        #
        # TODO:
        #
        # 定义Encoder Layer结构
        #
        # 包括：
        #
        # attention
        # norm1
        # norm2
        # ffn
        #
        #################################################


        pass





    def forward(
            self,
            x
    ):


        #################################################
        #
        # TODO:
        #
        # 完成Encoder Layer前向传播
        #
        # attention residual
        #
        # FFN residual
        #
        #################################################


        pass







# ======================================================
# 学生任务3：Transformer Encoder
# ======================================================


class TransformerEncoder(nn.Module):


    def __init__(
            self,
            vocab_size
    ):


        super().__init__()



        #################################################
        #
        # TODO:
        #
        # 定义Transformer Encoder
        #
        # 包括：
        #
        # embedding
        # position_embedding
        # encoder layers
        # classifier
        #
        #################################################



        pass





    def forward(
            self,
            x
    ):


        #################################################
        #
        # TODO:
        #
        # 前向传播：
        #
        # token embedding
        # position embedding
        # encoder layers
        # pooling
        # classifier
        #
        #################################################


        pass







# ============================
# 以下代码禁止修改
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




    for epoch in range(EPOCHS):


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
            total_loss /
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