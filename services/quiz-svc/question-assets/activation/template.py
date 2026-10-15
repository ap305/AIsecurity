"""
激活函数对比可视化实验（学生代码）

任务：
1. 实现四种激活函数：Sigmoid、Tanh、ReLU、LeakyReLU
2. 计算并保存函数值与梯度（用于教师自动测试）

实现要求：
- 输入区间 [-5, 5]
- LeakyReLU 的负斜率 alpha = 0.1
- 不直接调用 torch.nn / torch.nn.functional 的激活层，自行按公式实现
- 函数需支持标量与 numpy 数组输入（向量化）

注意：评测环境不安装 matplotlib。本题评测通过导入本模块、检查函数值与梯度
     的数值正确性来完成，无需生成图片。如需本地可视化，请自行绘制并提交前
     删除 matplotlib 相关 import。
"""

import numpy as np


def sigmoid(x):
    # TODO: 实现 Sigmoid: 1 / (1 + exp(-x))
    pass


def tanh(x):
    # TODO: 实现 Tanh: (exp(x) - exp(-x)) / (exp(x) + exp(-x))
    pass


def relu(x):
    # TODO: 实现 ReLU: max(0, x)
    pass


def leaky_relu(x, alpha=0.1):
    # TODO: 实现 LeakyReLU: x if x >= 0 else alpha * x
    pass


def main():
    x = np.linspace(-5, 5, 400)
    sample_x = np.array([-5.0, -2.0, 0.0, 2.0, 5.0])

    # 计算四种激活函数在采样点上的输出
    values = {
        "x": sample_x.tolist(),
        "Sigmoid": sigmoid(sample_x),
        "Tanh": tanh(sample_x),
        "ReLU": relu(sample_x),
        "LeakyReLU": leaky_relu(sample_x),
    }

    # 保存为 CSV（可选，便于本地分析）
    try:
        import pandas as pd
        pd.DataFrame(values).to_csv("activation_values.csv", index=False)
    except Exception:
        np.savetxt("activation_values.csv",
                   np.column_stack([values["x"], values["Sigmoid"], values["Tanh"],
                                    values["ReLU"], values["LeakyReLU"]]),
                   delimiter=",",
                   header="x,Sigmoid,Tanh,ReLU,LeakyReLU",
                   comments="")

    print("实验运行完成。")


if __name__ == "__main__":
    main()
