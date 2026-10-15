import torch
import torch.nn as nn


class DQN(nn.Module):
    """参考实现：与 dqn_model.pth 架构一致（Linear 4-128-128-2 + ReLU）。"""

    def __init__(self, state_dim, action_dim):
        super().__init__()
        self.network = nn.Sequential(
            nn.Linear(state_dim, 128),
            nn.ReLU(),
            nn.Linear(128, 128),
            nn.ReLU(),
            nn.Linear(128, action_dim),
        )

    def forward(self, x):
        return self.network(x)
