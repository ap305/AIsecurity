"""
Q-Learning走迷宫实验

Todo_code.py

学生完成文件

实验任务：
1. 完成迷宫环境中的状态转移逻辑；
2. 完成ε-greedy动作选择；
3. 完成Q-Learning更新公式；
4. 训练智能体并保存Q表、最优路径和训练曲线。

运行方式：
    python Todo_code.py

可选参数：
    python Todo_code.py --episodes 2000 --max-steps 200
    python Todo_code.py --seed 42 --output-dir results

输出文件：
results/
├── q_table.npy
├── policy.txt
├── best_path.txt
├── reward_curve.png
├── steps_curve.png
└── maze_solution.png
"""

import argparse
import random
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import numpy as np


# ============================================================
# 常量定义
# ============================================================

FREE = 0
WALL = 1
START = 2
GOAL = 3

UP = 0
RIGHT = 1
DOWN = 2
LEFT = 3

ACTION_NAMES = {
    UP: "UP",
    RIGHT: "RIGHT",
    DOWN: "DOWN",
    LEFT: "LEFT",
}

ACTION_SYMBOLS = {
    UP: "↑",
    RIGHT: "→",
    DOWN: "↓",
    LEFT: "←",
}

ACTION_DELTAS = {
    UP: (-1, 0),
    RIGHT: (0, 1),
    DOWN: (1, 0),
    LEFT: (0, -1),
}


# ============================================================
# 12×12默认迷宫
# ============================================================

# 0：可通行区域
# 1：障碍物
# 2：起点
# 3：终点
DEFAULT_MAZE = np.array(
    [
        [2, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
        [1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0],
        [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        [0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0],
        [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
        [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 0],
        [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
        [0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
        [1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0],
        [0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
        [0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 3],
    ],
    dtype=np.int64,
)


# ============================================================
# 随机种子
# ============================================================

def set_random_seed(seed: int) -> None:
    """设置Python与NumPy随机种子。"""
    random.seed(seed)
    np.random.seed(seed)


# ============================================================
# 迷宫环境
# ============================================================

class MazeEnv:
    """二维离散迷宫环境。"""

    def __init__(
        self,
        maze: np.ndarray,
        step_reward: float = -1.0,
        wall_penalty: float = -5.0,
        goal_reward: float = 100.0,
    ) -> None:
        self.maze = np.array(maze, dtype=np.int64)
        self.rows, self.cols = self.maze.shape

        self.step_reward = float(step_reward)
        self.wall_penalty = float(wall_penalty)
        self.goal_reward = float(goal_reward)

        self.start_position = self._find_unique_cell(START, "起点")
        self.goal_position = self._find_unique_cell(GOAL, "终点")

        self.position = self.start_position

    def _find_unique_cell(self, value: int, name: str) -> Tuple[int, int]:
        positions = np.argwhere(self.maze == value)

        if len(positions) != 1:
            raise ValueError(
                f"迷宫中必须且只能包含一个{name}，"
                f"当前数量为{len(positions)}。"
            )

        row, col = positions[0]
        return int(row), int(col)

    @property
    def num_states(self) -> int:
        return self.rows * self.cols

    @property
    def num_actions(self) -> int:
        return len(ACTION_DELTAS)

    def reset(self) -> int:
        """重置环境并返回起点状态编号。"""
        self.position = self.start_position
        return self.position_to_state(self.position)

    def position_to_state(self, position: Tuple[int, int]) -> int:
        """将(row, col)坐标转换为状态编号。"""
        row, col = position
        return row * self.cols + col

    def state_to_position(self, state: int) -> Tuple[int, int]:
        """将状态编号转换为(row, col)坐标。"""
        row = state // self.cols
        col = state % self.cols
        return int(row), int(col)

    def is_valid_position(self, row: int, col: int) -> bool:
        """判断位置是否在迷宫内且不是障碍物。"""
        if row < 0 or row >= self.rows:
            return False

        if col < 0 or col >= self.cols:
            return False

        return self.maze[row, col] != WALL

    def step(
        self,
        action: int,
    ) -> Tuple[int, float, bool, Dict[str, bool]]:
        """
        执行动作。

        返回：
            next_state：下一状态编号
            reward：即时奖励
            done：是否到达终点
            info：附加信息
        """
        if action not in ACTION_DELTAS:
            raise ValueError(f"非法动作：{action}")

        # TODO 1：
        # 1. 获取当前位置；
        # 2. 根据ACTION_DELTAS计算候选位置；
        # 3. 判断是否撞墙或越界；
        # 4. 撞墙时位置不变并给予wall_penalty；
        # 5. 正常移动时给予step_reward；
        # 6. 到达终点时给予goal_reward，并令done=True；
        # 7. 返回next_state、reward、done和info。
        #
        # 提示：
        # info格式为：
        # {"hit_wall": hit_wall}

        raise NotImplementedError("请完成MazeEnv.step()方法。")


# ============================================================
# Q-Learning智能体
# ============================================================

class QLearningAgent:
    """表格型Q-Learning智能体。"""

    def __init__(
        self,
        num_states: int,
        num_actions: int,
        learning_rate: float = 0.1,
        discount_factor: float = 0.95,
        epsilon: float = 1.0,
        epsilon_min: float = 0.05,
        epsilon_decay: float = 0.998,
    ) -> None:
        self.num_states = int(num_states)
        self.num_actions = int(num_actions)

        self.learning_rate = float(learning_rate)
        self.discount_factor = float(discount_factor)

        self.epsilon = float(epsilon)
        self.epsilon_min = float(epsilon_min)
        self.epsilon_decay = float(epsilon_decay)

        self.q_table = np.zeros(
            (self.num_states, self.num_actions),
            dtype=np.float64,
        )

    def choose_action(
        self,
        state: int,
        training: bool = True,
    ) -> int:
        """
        使用ε-greedy策略选择动作。

        训练阶段：
        - 以epsilon概率随机探索；
        - 以1-epsilon概率选择Q值最大的动作。

        测试阶段：
        - 直接选择Q值最大的动作。
        """

        # TODO 2：
        # 完成ε-greedy动作选择。
        #
        # 要求：
        # 1. training=True且随机数小于epsilon时，随机选择动作；
        # 2. 其他情况下选择Q值最大的动作；
        # 3. 如果多个动作Q值相同且都是最大值，应随机选择其中一个；
        # 4. 返回int类型动作编号。

        raise NotImplementedError("请完成choose_action()方法。")

    def update(
        self,
        state: int,
        action: int,
        reward: float,
        next_state: int,
        done: bool,
    ) -> None:
        """
        根据Q-Learning更新公式更新Q表。

        终止状态：
            target = reward

        非终止状态：
            target = reward
                     + discount_factor
                     * max(Q[next_state])
        """

        # TODO 3：
        # 完成Q-Learning更新。
        #
        # 更新公式：
        # Q(s,a) = Q(s,a)
        #          + learning_rate
        #          * (target - Q(s,a))

        raise NotImplementedError("请完成update()方法。")

    def decay_epsilon(self) -> None:
        """衰减探索率，但不能低于epsilon_min。"""
        self.epsilon = max(
            self.epsilon_min,
            self.epsilon * self.epsilon_decay,
        )


# ============================================================
# 训练与测试
# ============================================================

def train_agent(
    env: MazeEnv,
    agent: QLearningAgent,
    episodes: int,
    max_steps: int,
    log_interval: int = 100,
) -> Tuple[List[float], List[int], List[int]]:
    """
    训练Q-Learning智能体。

    返回：
        episode_rewards：每轮累计奖励
        episode_steps：每轮步数
        success_history：每轮是否成功到达终点
    """
    episode_rewards: List[float] = []
    episode_steps: List[int] = []
    success_history: List[int] = []

    for episode in range(1, episodes + 1):
        state = env.reset()

        total_reward = 0.0
        success = 0
        steps_taken = max_steps

        for step in range(1, max_steps + 1):
            action = agent.choose_action(
                state,
                training=True,
            )

            next_state, reward, done, _ = env.step(action)

            agent.update(
                state=state,
                action=action,
                reward=reward,
                next_state=next_state,
                done=done,
            )

            state = next_state
            total_reward += reward

            if done:
                success = 1
                steps_taken = step
                break

        agent.decay_epsilon()

        episode_rewards.append(total_reward)
        episode_steps.append(steps_taken)
        success_history.append(success)

        if episode == 1 or episode % log_interval == 0:
            recent_start = max(
                0,
                len(success_history) - log_interval,
            )

            recent_success = success_history[recent_start:]
            success_rate = 100.0 * np.mean(recent_success)

            recent_rewards = episode_rewards[recent_start:]
            mean_reward = float(np.mean(recent_rewards))

            print(
                f"Episode {episode:4d}/{episodes} | "
                f"Reward: {total_reward:8.2f} | "
                f"Steps: {steps_taken:3d} | "
                f"Epsilon: {agent.epsilon:.4f} | "
                f"Recent Success: {success_rate:6.2f}% | "
                f"Recent Mean Reward: {mean_reward:8.2f}"
            )

    return episode_rewards, episode_steps, success_history


def extract_greedy_path(
    env: MazeEnv,
    agent: QLearningAgent,
    max_steps: int,
) -> Tuple[List[Tuple[int, int]], List[int], bool]:
    """
    根据训练后的Q表提取贪心路径。

    返回：
        path：位置序列
        actions：动作序列
        success：是否到达终点
    """
    state = env.reset()

    path = [env.position]
    actions: List[int] = []

    visited_counts: Dict[int, int] = {
        state: 1
    }

    for _ in range(max_steps):
        action = agent.choose_action(
            state,
            training=False,
        )

        next_state, _, done, _ = env.step(action)

        actions.append(action)
        path.append(env.position)

        if done:
            return path, actions, True

        visited_counts[next_state] = (
            visited_counts.get(next_state, 0) + 1
        )

        # 防止局部循环
        if visited_counts[next_state] > 4:
            return path, actions, False

        state = next_state

    return path, actions, False


# ============================================================
# 保存结果
# ============================================================

def moving_average(
    values: Sequence[float],
    window_size: int = 50,
) -> np.ndarray:
    values_array = np.asarray(
        values,
        dtype=np.float64,
    )

    if len(values_array) < window_size:
        return values_array

    kernel = (
        np.ones(window_size, dtype=np.float64)
        / window_size
    )

    return np.convolve(
        values_array,
        kernel,
        mode="valid",
    )


def save_training_curves(
    episode_rewards: Sequence[float],
    episode_steps: Sequence[int],
    output_dir: Path,
) -> None:
    """保存奖励曲线和步数曲线。"""
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib
    reward_average = moving_average(
        episode_rewards,
        window_size=50,
    )

    reward_offset = (
        len(episode_rewards)
        - len(reward_average)
    )

    plt.figure(figsize=(9, 5))

    plt.plot(
        range(1, len(episode_rewards) + 1),
        episode_rewards,
        alpha=0.35,
        label="Episode Reward",
    )

    plt.plot(
        range(
            1 + reward_offset,
            len(episode_rewards) + 1,
        ),
        reward_average,
        linewidth=2,
        label="Moving Average (50)",
    )

    plt.xlabel("Episode")
    plt.ylabel("Total Reward")
    plt.title("Q-Learning Training Reward")
    plt.legend()
    plt.tight_layout()

    plt.savefig(
        output_dir / "reward_curve.png",
        dpi=150,
    )

    plt.close()

    steps_average = moving_average(
        episode_steps,
        window_size=50,
    )

    steps_offset = (
        len(episode_steps)
        - len(steps_average)
    )

    plt.figure(figsize=(9, 5))

    plt.plot(
        range(1, len(episode_steps) + 1),
        episode_steps,
        alpha=0.35,
        label="Episode Steps",
    )

    plt.plot(
        range(
            1 + steps_offset,
            len(episode_steps) + 1,
        ),
        steps_average,
        linewidth=2,
        label="Moving Average (50)",
    )

    plt.xlabel("Episode")
    plt.ylabel("Steps")
    plt.title("Q-Learning Episode Steps")
    plt.legend()
    plt.tight_layout()

    plt.savefig(
        output_dir / "steps_curve.png",
        dpi=150,
    )

    plt.close()


def save_policy(
    env: MazeEnv,
    agent: QLearningAgent,
    output_path: Path,
) -> None:
    """将训练后的贪心策略保存为文本文件。"""
    lines: List[str] = []

    for row in range(env.rows):
        symbols: List[str] = []

        for col in range(env.cols):
            cell = env.maze[row, col]

            if cell == WALL:
                symbol = "■"
            elif cell == START:
                symbol = "S"
            elif cell == GOAL:
                symbol = "G"
            else:
                state = env.position_to_state(
                    (row, col)
                )

                action = int(
                    np.argmax(
                        agent.q_table[state]
                    )
                )

                symbol = ACTION_SYMBOLS[action]

            symbols.append(symbol)

        lines.append(" ".join(symbols))

    output_path.write_text(
        "\n".join(lines),
        encoding="utf-8",
    )


def save_best_path(
    path: Sequence[Tuple[int, int]],
    actions: Sequence[int],
    success: bool,
    output_path: Path,
) -> None:
    """保存最优路径文本。"""
    lines = [
        f"Success: {success}",
        f"Path length: {max(0, len(path) - 1)}",
        "",
        "Positions:",
    ]

    for index, position in enumerate(path):
        lines.append(
            f"{index:03d}: {position}"
        )

    lines.append("")
    lines.append("Actions:")

    for index, action in enumerate(actions):
        lines.append(
            f"{index:03d}: {ACTION_NAMES[action]}"
        )

    output_path.write_text(
        "\n".join(lines),
        encoding="utf-8",
    )


def save_maze_solution(
    env: MazeEnv,
    path: Sequence[Tuple[int, int]],
    success: bool,
    output_path: Path,
) -> None:
    """保存迷宫和最优路径可视化图片。"""
    import matplotlib.pyplot as plt  # 懒加载：评测环境无 matplotlib
    display = np.ones(
        (env.rows, env.cols, 3),
        dtype=np.float64,
    )

    for row in range(env.rows):
        for col in range(env.cols):
            cell = env.maze[row, col]

            if cell == WALL:
                display[row, col] = [0.1, 0.1, 0.1]
            elif cell == START:
                display[row, col] = [0.2, 0.7, 0.2]
            elif cell == GOAL:
                display[row, col] = [0.9, 0.2, 0.2]
            else:
                display[row, col] = [0.95, 0.95, 0.95]

    plt.figure(figsize=(8, 8))
    plt.imshow(display)

    if len(path) > 1:
        path_rows = [
            position[0]
            for position in path
        ]

        path_cols = [
            position[1]
            for position in path
        ]

        plt.plot(
            path_cols,
            path_rows,
            marker="o",
            linewidth=2,
            markersize=4,
            label="Greedy Path",
        )

    plt.text(
        env.start_position[1],
        env.start_position[0],
        "S",
        ha="center",
        va="center",
        fontsize=14,
        fontweight="bold",
    )

    plt.text(
        env.goal_position[1],
        env.goal_position[0],
        "G",
        ha="center",
        va="center",
        fontsize=14,
        fontweight="bold",
    )

    plt.xticks(range(env.cols))
    plt.yticks(range(env.rows))
    plt.grid(True, linewidth=0.6)

    plt.title(
        "Q-Learning Maze Solution | "
        f"Success={success} | "
        f"Steps={max(0, len(path) - 1)}"
    )

    plt.legend(loc="upper right")
    plt.tight_layout()

    plt.savefig(
        output_path,
        dpi=150,
    )

    plt.close()


# ============================================================
# 参数
# ============================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Q-Learning走迷宫实验学生代码"
    )

    parser.add_argument(
        "--episodes",
        type=int,
        default=2000,
        help="训练回合数，默认2000",
    )

    parser.add_argument(
        "--max-steps",
        type=int,
        default=200,
        help="每轮最大步数，默认200",
    )

    parser.add_argument(
        "--learning-rate",
        type=float,
        default=0.1,
        help="学习率，默认0.1",
    )

    parser.add_argument(
        "--discount-factor",
        type=float,
        default=0.95,
        help="折扣因子，默认0.95",
    )

    parser.add_argument(
        "--epsilon",
        type=float,
        default=1.0,
        help="初始探索率，默认1.0",
    )

    parser.add_argument(
        "--epsilon-min",
        type=float,
        default=0.05,
        help="最小探索率，默认0.05",
    )

    parser.add_argument(
        "--epsilon-decay",
        type=float,
        default=0.998,
        help="探索率衰减系数，默认0.998",
    )

    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="随机种子，默认42",
    )

    parser.add_argument(
        "--output-dir",
        type=str,
        default="results",
        help="结果目录，默认results",
    )

    return parser.parse_args()


def validate_args(
    args: argparse.Namespace,
) -> None:
    if args.episodes <= 0:
        raise ValueError(
            "episodes必须大于0。"
        )

    if args.max_steps <= 0:
        raise ValueError(
            "max-steps必须大于0。"
        )

    if not 0 < args.learning_rate <= 1:
        raise ValueError(
            "learning-rate必须位于(0, 1]。"
        )

    if not 0 <= args.discount_factor <= 1:
        raise ValueError(
            "discount-factor必须位于[0, 1]。"
        )

    if not 0 <= args.epsilon <= 1:
        raise ValueError(
            "epsilon必须位于[0, 1]。"
        )

    if not 0 <= args.epsilon_min <= 1:
        raise ValueError(
            "epsilon-min必须位于[0, 1]。"
        )

    if not 0 < args.epsilon_decay <= 1:
        raise ValueError(
            "epsilon-decay必须位于(0, 1]。"
        )


# ============================================================
# 主程序
# ============================================================

def main() -> None:
    args = parse_args()
    validate_args(args)
    set_random_seed(args.seed)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    env = MazeEnv(DEFAULT_MAZE)

    agent = QLearningAgent(
        num_states=env.num_states,
        num_actions=env.num_actions,
        learning_rate=args.learning_rate,
        discount_factor=args.discount_factor,
        epsilon=args.epsilon,
        epsilon_min=args.epsilon_min,
        epsilon_decay=args.epsilon_decay,
    )

    print("=" * 72)
    print("Q-Learning走迷宫实验")
    print("=" * 72)
    print(f"Maze Size: {env.rows} × {env.cols}")
    print(f"States: {env.num_states}")
    print(f"Actions: {env.num_actions}")
    print(f"Episodes: {args.episodes}")
    print(f"Max Steps: {args.max_steps}")
    print(f"Learning Rate: {args.learning_rate}")
    print(f"Discount Factor: {args.discount_factor}")
    print(f"Initial Epsilon: {args.epsilon}")
    print(f"Output Directory: {output_dir}")
    print("=" * 72)

    rewards, steps, success_history = train_agent(
        env=env,
        agent=agent,
        episodes=args.episodes,
        max_steps=args.max_steps,
    )

    path, actions, success = extract_greedy_path(
        env=env,
        agent=agent,
        max_steps=args.max_steps,
    )

    np.save(
        output_dir / "q_table.npy",
        agent.q_table,
    )

    save_policy(
        env=env,
        agent=agent,
        output_path=output_dir / "policy.txt",
    )

    save_best_path(
        path=path,
        actions=actions,
        success=success,
        output_path=output_dir / "best_path.txt",
    )

    save_training_curves(
        episode_rewards=rewards,
        episode_steps=steps,
        output_dir=output_dir,
    )

    save_maze_solution(
        env=env,
        path=path,
        success=success,
        output_path=output_dir / "maze_solution.png",
    )

    final_window = min(
        100,
        len(success_history),
    )

    final_success_rate = (
        100.0
        * np.mean(
            success_history[-final_window:]
        )
    )

    print("\n" + "=" * 72)
    print("训练完成")
    print("=" * 72)
    print(f"最终探索率：{agent.epsilon:.4f}")
    print(
        f"最近{final_window}轮成功率："
        f"{final_success_rate:.2f}%"
    )
    print(
        f"贪心路径是否到达终点：{success}"
    )
    print(
        f"贪心路径步数："
        f"{max(0, len(path) - 1)}"
    )
    print(
        f"结果保存目录："
        f"{output_dir.resolve()}"
    )
    print("=" * 72)


if __name__ == "__main__":
    main()