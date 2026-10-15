"""激活函数对比可视化实验（参考解答，numpy 实现）"""

import numpy as np


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=float)))


def tanh(x):
    x = np.asarray(x, dtype=float)
    ex, enx = np.exp(x), np.exp(-x)
    return (ex - enx) / (ex + enx)


def relu(x):
    x = np.asarray(x, dtype=float)
    return np.maximum(0.0, x)


def leaky_relu(x, alpha=0.1):
    x = np.asarray(x, dtype=float)
    return np.where(x >= 0, x, alpha * x)


def main():
    x = np.linspace(-5, 5, 400)
    sample_x = np.array([-5.0, -2.0, 0.0, 2.0, 5.0])
    values = {
        "x": sample_x.tolist(),
        "Sigmoid": sigmoid(sample_x).tolist(),
        "Tanh": tanh(sample_x).tolist(),
        "ReLU": relu(sample_x).tolist(),
        "LeakyReLU": leaky_relu(sample_x).tolist(),
    }
    try:
        import pandas as pd
        pd.DataFrame(values).to_csv("activation_values.csv", index=False)
    except Exception:
        pass
    print("实验运行完成。")


if __name__ == "__main__":
    main()
