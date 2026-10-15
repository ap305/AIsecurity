"""
GCN节点分类实验

教师参考代码

任务：
1. 本地加载Cora citation network
2. 构建GCN模型
3. 完成节点分类训练
4. 保存模型
5. 绘制训练loss曲线


数据：

data/
└── Cora/
    └── cora/
        ├── cora.content
        └── cora.cites


输出：

results/
├── gcn_model.pth
└── loss_curve.png

"""


import os
import torch
import torch.nn as nn
import torch.nn.functional as F

import numpy as np





# ============================
# 参数设置
# ============================


DATA_PATH = "./data/Cora/cora"


EPOCHS = 200


LR = 0.01


WEIGHT_DECAY = 5e-4


HIDDEN_DIM = 16


MODEL_PATH = "results/gcn_model.pth"



device = torch.device(
    "cuda"
    if torch.cuda.is_available()
    else "cpu"
)




# ============================
# 简单GCN Layer
# ============================


class GraphConvolution(nn.Module):


    def __init__(
            self,
            input_dim,
            output_dim
    ):

        super().__init__()


        self.weight = nn.Parameter(
            torch.FloatTensor(
                input_dim,
                output_dim
            )
        )


        self.bias = nn.Parameter(
            torch.FloatTensor(
                output_dim
            )
        )


        self.reset_parameters()



    def reset_parameters(self):

        nn.init.xavier_uniform_(
            self.weight
        )


        nn.init.zeros_(
            self.bias
        )



    def forward(
            self,
            x,
            adj
    ):


        support = torch.mm(
            x,
            self.weight
        )


        output = torch.mm(
            adj,
            support
        )


        return output + self.bias






# ============================
# GCN模型
# ============================


class GCN(nn.Module):


    def __init__(
            self,
            input_dim,
            hidden_dim,
            output_dim
    ):


        super().__init__()


        self.gc1 = GraphConvolution(
            input_dim,
            hidden_dim
        )


        self.gc2 = GraphConvolution(
            hidden_dim,
            output_dim
        )



    def forward(
            self,
            x,
            adj
    ):


        x = self.gc1(
            x,
            adj
        )


        x = F.relu(
            x
        )


        x = F.dropout(
            x,
            training=self.training
        )


        x = self.gc2(
            x,
            adj
        )


        return x





# ============================
# 加载Cora数据
# ============================


def load_cora():



    content_file = os.path.join(
        DATA_PATH,
        "cora.content"
    )


    cites_file = os.path.join(
        DATA_PATH,
        "cora.cites"
    )



    features = []

    labels = []

    node_ids = []



    # -------------------------
    # 读取节点
    # -------------------------


    with open(
        content_file,
        "r"
    ) as f:


        for line in f:


            values=line.strip().split()


            node_ids.append(
                values[0]
            )


            features.append(
                [
                    int(x)
                    for x in values[1:-1]
                ]
            )


            labels.append(
                values[-1]
            )




    node_map={

        node:i

        for i,node in enumerate(node_ids)

    }



    x=torch.tensor(
        features,
        dtype=torch.float32
    )



    unique_labels = sorted(set(labels))
    label_to_idx = {lab: i for i, lab in enumerate(unique_labels)}
    y = torch.tensor(
        [label_to_idx[lab] for lab in labels],
        dtype=torch.long,
    )





    # -------------------------
    # 构建邻接矩阵
    # -------------------------


    num_nodes=len(
        node_ids
    )


    adj=torch.zeros(
        (
            num_nodes,
            num_nodes
        )
    )



    with open(
        cites_file,
        "r"
    ) as f:


        for line in f:


            src,dst=line.strip().split()



            if (
                src in node_map
                and
                dst in node_map
            ):


                i=node_map[src]

                j=node_map[dst]



                # 无向图

                adj[i][j]=1

                adj[j][i]=1





    # 添加自环

    adj += torch.eye(
        num_nodes
    )



    # 归一化邻接矩阵

    degree=torch.sum(
        adj,
        dim=1
    )


    degree_inv=torch.pow(
        degree,
        -0.5
    )


    degree_inv[
        torch.isinf(
            degree_inv
        )
    ]=0



    degree_matrix=torch.diag(
        degree_inv
    )


    adj=torch.mm(
        torch.mm(
            degree_matrix,
            adj
        ),
        degree_matrix
    )



    return x,adj,y





# ============================
# 数据划分
# ============================


def split_data(
        num_nodes
):


    torch.manual_seed(
        42
    )


    index=torch.randperm(
        num_nodes
    )



    train_size=int(
        num_nodes*0.6
    )


    val_size=int(
        num_nodes*0.2
    )



    train_mask=torch.zeros(
        num_nodes,
        dtype=torch.bool
    )


    val_mask=torch.zeros(
        num_nodes,
        dtype=torch.bool
    )


    test_mask=torch.zeros(
        num_nodes,
        dtype=torch.bool
    )



    train_mask[
        index[:train_size]
    ]=True



    val_mask[
        index[
            train_size:
            train_size+val_size
        ]
    ]=True



    test_mask[
        index[
            train_size+val_size:
        ]
    ]=True



    return (
        train_mask,
        val_mask,
        test_mask
    )





# ============================
# 测试准确率
# ============================


def test(
        model,
        x,
        adj,
        y,
        mask
):


    model.eval()


    with torch.no_grad():


        output=model(
            x,
            adj
        )


        pred=torch.argmax(
            output,
            dim=1
        )


        correct=(
            pred[mask]
            ==
            y[mask]
        ).sum()



    acc=(
        correct.item()
        /
        mask.sum().item()
    )


    return acc





# ============================
# 训练
# ============================


def train():
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib



    x,adj,y=load_cora()



    train_mask,val_mask,test_mask=split_data(
        x.shape[0]
    )



    x=x.to(device)

    adj=adj.to(device)

    y=y.to(device)



    train_mask=train_mask.to(device)

    test_mask=test_mask.to(device)




    model=GCN(
        x.shape[1],
        HIDDEN_DIM,
        len(torch.unique(y))
    ).to(device)



    optimizer=torch.optim.Adam(
        model.parameters(),
        lr=LR,
        weight_decay=WEIGHT_DECAY
    )



    loss_history=[]



    for epoch in range(
        EPOCHS
    ):


        model.train()



        optimizer.zero_grad()



        output=model(
            x,
            adj
        )



        loss=F.cross_entropy(
            output[train_mask],
            y[train_mask]
        )



        loss.backward()


        optimizer.step()



        loss_history.append(
            loss.item()
        )



        if (
            epoch+1
        )%20==0:


            acc=test(
                model,
                x,
                adj,
                y,
                test_mask
            )


            print(
                f"Epoch {epoch+1}/{EPOCHS}, "
                f"Loss:{loss.item():.4f}, "
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
        "GCN Training Loss"
    )



    plt.savefig(
        "results/loss_curve.png"
    )


    plt.close()



    final_acc=test(
        model,
        x,
        adj,
        y,
        test_mask
    )


    print(
        "Final Test Accuracy:",
        round(final_acc,4)
    )


    print(
        "Training Finished!"
    )





if __name__=="__main__":


    train()