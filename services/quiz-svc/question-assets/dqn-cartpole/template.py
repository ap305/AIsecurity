import torch
import torch.nn as nn


class DQN(nn.Module):
    """DQN Q 网络：输入 state (state_dim,) 输出各动作 Q 值 (action_dim,)。

    CartPole-v1：state_dim=4，action_dim=2。
    """

    def __init__(self, state_dim, action_dim):
        super().__init__()
        # TODO：定义 Q 网络（建议 MLP：state_dim -> 128 -> 128 -> action_dim，ReLU 激活）
        # 提示：用 nn.Sequential 定义 self.network
        self.network = nn.Sequential(
            # nn.Linear(state_dim, 128),
            # nn.ReLU(),
            # nn.Linear(128, 128),
            # nn.ReLU(),
            # nn.Linear(128, action_dim),
        )

    def forward(self, x):
        # TODO：前向传播，返回 Q 值 (batch, action_dim)
        return self.network(x)
