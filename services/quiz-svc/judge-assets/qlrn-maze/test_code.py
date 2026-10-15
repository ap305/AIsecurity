"""
Q-Learning 走迷宫实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入学生代码。
- 检查 12×12 迷宫、MazeEnv、状态转移 step、QLearningAgent 与 Q 表、
  ε-greedy 动作选择、Q-Learning 更新公式、必要函数是否齐全，共 8 个测试用例。
- 不依赖 matplotlib；训练产物（q_table.npy/policy.txt/png）检查已移除，
  因评测环境无 matplotlib，且本测试聚焦 Q-Learning 核心机制的正确性。
"""

import sys
import importlib.util
from pathlib import Path

import numpy as np

EXPECTED_ROWS = 12
EXPECTED_COLS = 12
EXPECTED_STATES = 144
EXPECTED_ACTIONS = 4


def load_student(code_dir):
    code_file = Path(code_dir) / "student_code.py"
    if not code_file.is_file():
        print(f"测试未通过：未找到学生代码 {code_file}")
        return None
    spec = importlib.util.spec_from_file_location("student_code", str(code_file))
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as e:
        print(f"测试未通过：学生代码加载失败：{e}")
        return None
    return module


def check_maze(student):
    if not hasattr(student, "DEFAULT_MAZE"):
        raise AttributeError("缺少 DEFAULT_MAZE。")
    maze = np.asarray(student.DEFAULT_MAZE)
    if maze.shape != (EXPECTED_ROWS, EXPECTED_COLS):
        raise ValueError(f"迷宫尺寸应为 (12, 12)，实际为 {maze.shape}。")
    values = set(np.unique(maze).tolist())
    if not values.issubset({0, 1, 2, 3}):
        raise ValueError(f"迷宫只能包含 0/1/2/3，实际包含 {values}。")
    if np.sum(maze == 2) != 1:
        raise ValueError("迷宫中必须且只能有一个起点 2。")
    if np.sum(maze == 3) != 1:
        raise ValueError("迷宫中必须且只能有一个终点 3。")
    return maze


def check_environment(student, maze):
    if not hasattr(student, "MazeEnv"):
        raise AttributeError("缺少 MazeEnv 类。")
    env = student.MazeEnv(maze)
    if env.rows != EXPECTED_ROWS or env.cols != EXPECTED_COLS:
        raise ValueError("MazeEnv 未正确读取 12×12 迷宫。")
    if env.num_states != EXPECTED_STATES:
        raise ValueError(f"状态数应为 144，实际为 {env.num_states}。")
    if env.num_actions != EXPECTED_ACTIONS:
        raise ValueError(f"动作数应为 4，实际为 {env.num_actions}。")
    state = env.reset()
    if not isinstance(state, (int, np.integer)):
        raise TypeError("reset() 应返回整数状态编号。")
    position = env.state_to_position(state)
    if tuple(position) != tuple(env.start_position):
        raise ValueError("reset() 返回的状态不是起点状态。")
    if env.position_to_state(position) != state:
        raise ValueError("position_to_state 和 state_to_position 不一致。")
    return env


def check_step(student, env):
    for name in ["UP", "RIGHT", "DOWN", "LEFT"]:
        if not hasattr(student, name):
            raise AttributeError(f"缺少动作常量 {name}。")
    env.reset()
    next_state, reward, done, info = env.step(student.RIGHT)
    if not isinstance(next_state, (int, np.integer)):
        raise TypeError("step() 返回的 next_state 应为整数。")
    if not isinstance(reward, (int, float, np.number)):
        raise TypeError("step() 返回的 reward 应为数值。")
    if not isinstance(done, (bool, np.bool_)):
        raise TypeError("step() 返回的 done 应为布尔值。")
    if not isinstance(info, dict):
        raise TypeError("step() 返回的 info 应为字典。")


def check_agent(student, env):
    if not hasattr(student, "QLearningAgent"):
        raise AttributeError("缺少 QLearningAgent 类。")
    agent = student.QLearningAgent(
        num_states=env.num_states,
        num_actions=env.num_actions,
        learning_rate=0.1,
        discount_factor=0.95,
        epsilon=0.0,
        epsilon_min=0.0,
        epsilon_decay=1.0,
    )
    if not isinstance(agent.q_table, np.ndarray):
        raise TypeError("q_table 应为 NumPy 数组。")
    if agent.q_table.shape != (EXPECTED_STATES, EXPECTED_ACTIONS):
        raise ValueError(f"Q 表尺寸应为 (144, 4)，实际为 {agent.q_table.shape}。")
    return agent


def check_greedy_action(agent):
    state = 0
    agent.q_table[state] = np.array([0.0, 1.0, 5.0, 2.0])
    action = agent.choose_action(state, training=False)
    if action != 2:
        raise ValueError(f"贪心策略应选择动作 2，实际选择动作 {action}。")


def check_q_update(student, env):
    agent = student.QLearningAgent(
        num_states=env.num_states,
        num_actions=env.num_actions,
        learning_rate=0.5,
        discount_factor=0.9,
        epsilon=0.0,
        epsilon_min=0.0,
        epsilon_decay=1.0,
    )
    state, action, next_state, reward = 0, 1, 1, 10.0
    agent.q_table[state, action] = 2.0
    agent.q_table[next_state] = np.array([1.0, 4.0, 3.0, 2.0])
    expected = 2.0 + 0.5 * (10.0 + 0.9 * 4.0 - 2.0)
    agent.update(state=state, action=action, reward=reward, next_state=next_state, done=False)
    actual = agent.q_table[state, action]
    if not np.isclose(actual, expected):
        raise ValueError(f"Q 值更新错误，应为 {expected:.6f}，实际为 {actual:.6f}。")
    agent.q_table[state, action] = 2.0
    expected_terminal = 2.0 + 0.5 * (10.0 - 2.0)
    agent.update(state=state, action=action, reward=10.0, next_state=next_state, done=True)
    if not np.isclose(agent.q_table[state, action], expected_terminal):
        raise ValueError("终止状态 Q 值更新错误。")


def check_required_functions(student):
    required = [
        "train_agent", "extract_greedy_path", "save_training_curves",
        "save_policy", "save_best_path", "save_maze_solution",
    ]
    missing = [n for n in required if not hasattr(student, n) or not callable(getattr(student, n))]
    if missing:
        raise AttributeError("缺少函数：" + "、".join(missing))


def run(name, fn):
    try:
        fn()
        return name, True, "正常"
    except Exception as e:
        return name, False, str(e)


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/8")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    np.random.seed(42)

    student = load_student(code_dir)
    tests = []
    student_obj = student

    name, passed, detail = run("学生代码导入", lambda: None if student_obj is not None else (_ for _ in ()).throw(Exception("导入失败")))
    tests.append((name, student is not None, detail if student else "学生代码导入失败"))

    if student is not None:
        maze = [None]
        def _maze():
            maze[0] = check_maze(student)
        name, passed, detail = run("12×12 迷宫定义", _maze)
        tests.append((name, passed, detail))

        env = [None]
        if maze[0] is not None:
            def _env():
                env[0] = check_environment(student, maze[0])
            name, passed, detail = run("MazeEnv 环境", _env)
        else:
            name, passed, detail = "MazeEnv 环境", False, "缺少有效迷宫"
        tests.append((name, passed, detail))

        if env[0] is not None:
            name, passed, detail = run("环境状态转移 step", lambda: check_step(student, env[0]))
        else:
            name, passed, detail = "环境状态转移 step", False, "环境初始化失败"
        tests.append((name, passed, detail))

        agent = [None]
        if env[0] is not None:
            def _agent():
                agent[0] = check_agent(student, env[0])
            name, passed, detail = run("QLearningAgent 与 Q 表", _agent)
        else:
            name, passed, detail = "QLearningAgent 与 Q 表", False, "缺少有效环境"
        tests.append((name, passed, detail))

        if agent[0] is not None:
            name, passed, detail = run("ε-greedy 动作选择", lambda: check_greedy_action(agent[0]))
        else:
            name, passed, detail = "ε-greedy 动作选择", False, "智能体初始化失败"
        tests.append((name, passed, detail))

        if env[0] is not None:
            name, passed, detail = run("Q-Learning 更新公式", lambda: check_q_update(student, env[0]))
        else:
            name, passed, detail = "Q-Learning 更新公式", False, "缺少有效环境"
        tests.append((name, passed, detail))

        name, passed, detail = run("训练与结果保存函数", lambda: check_required_functions(student))
        tests.append((name, passed, detail))
    else:
        for label in ["12×12 迷宫定义", "MazeEnv 环境", "环境状态转移 step",
                      "QLearningAgent 与 Q 表", "ε-greedy 动作选择",
                      "Q-Learning 更新公式", "训练与结果保存函数"]:
            tests.append((label, False, "学生代码导入失败"))

    passed_count = sum(1 for _, p, _ in tests if p)
    total = len(tests)

    for i, (name, p, detail) in enumerate(tests, 1):
        mark = "√" if p else "×"
        print(f"[{mark}] 测试{i:02d}：{name}——{detail}")

    print(f"Tests Passed: {passed_count}/{total}")
    if passed_count >= 6:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
