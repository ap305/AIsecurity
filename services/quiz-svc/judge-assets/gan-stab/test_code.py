"""
GAN 训练稳定性对比实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入学生代码。
- 检查：代码导入、Generator 定义、Generator 前向（形状/数值/范围）、Discriminator 定义、
  Discriminator 前向（形状/概率范围）、gradient_penalty 函数、train_gan 函数，共 7 个测试用例。
- 不依赖 matplotlib 与训练产物；6 个 .pth 与 5 个 png 结果文件检查已移除
  （评测环境无 matplotlib，且 3 种 GAN 各 50 epoch 训练超出评测时限）。
"""

import sys
import importlib.util
from pathlib import Path

import torch

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
LATENT_DIM = 100
IMAGE_SIZE = 28


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


def check_tensor_finite(tensor, name):
    if not torch.is_tensor(tensor):
        raise TypeError(f"{name} 不是 Tensor。")
    if not torch.isfinite(tensor).all():
        raise ValueError(f"{name} 包含 NaN 或 Inf。")


def run(name, fn):
    try:
        detail = fn()
        return (name, True, detail if detail else "正常")
    except Exception as e:
        return (name, False, str(e))


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/7")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    torch.manual_seed(42)

    student = load_student(code_dir)
    tests = []

    # 1) 代码导入
    tests.append(("学生代码导入", student is not None, "已加载" if student else "导入失败"))
    if student is None:
        for label in ["Generator 定义与实例化", "Generator 前向传播",
                      "Discriminator 定义与实例化", "Discriminator 前向传播",
                      "Gradient Penalty", "GAN 训练函数"]:
            tests.append((label, False, "学生代码导入失败"))
        print(f"Tests Passed: 0/7")
        print("测试未通过")
        return 1

    # 2) Generator 定义与实例化
    generator = {"v": None}

    def _gen_def():
        if not hasattr(student, "Generator"):
            raise AttributeError("缺少 Generator 类。")
        generator["v"] = student.Generator().to(DEVICE)
        generator["v"].eval()
        return "正常"

    tests.append(run("Generator 定义与实例化", _gen_def))

    # 3) Generator 前向传播
    fake_images = {"v": None}

    def _gen_fwd():
        if generator["v"] is None:
            raise RuntimeError("Generator 未成功实例化。")
        with torch.no_grad():
            noise = torch.randn(4, LATENT_DIM, device=DEVICE)
            out = generator["v"](noise)
        if tuple(out.shape) != (4, 1, IMAGE_SIZE, IMAGE_SIZE):
            raise ValueError(f"输出尺寸应为 (4,1,28,28)，实际 {tuple(out.shape)}。")
        check_tensor_finite(out, "Generator 输出")
        if out.min().item() < -1.001 or out.max().item() > 1.001:
            raise ValueError("Generator 输出未限制在 [-1, 1] 范围内。")
        fake_images["v"] = out
        return "输出尺寸及数值范围正确"

    tests.append(run("Generator 前向传播", _gen_fwd))

    # 4) Discriminator 定义与实例化
    discriminator = {"v": None}

    def _disc_def():
        if not hasattr(student, "Discriminator"):
            raise AttributeError("缺少 Discriminator 类。")
        discriminator["v"] = student.Discriminator().to(DEVICE)
        discriminator["v"].eval()
        return "正常"

    tests.append(run("Discriminator 定义与实例化", _disc_def))

    # 5) Discriminator 前向传播
    def _disc_fwd():
        if discriminator["v"] is None:
            raise RuntimeError("Discriminator 未成功实例化。")
        imgs = fake_images["v"] if fake_images["v"] is not None else torch.randn(4, 1, IMAGE_SIZE, IMAGE_SIZE, device=DEVICE)
        with torch.no_grad():
            probs = discriminator["v"](imgs)
        if tuple(probs.shape) != (4, 1):
            raise ValueError(f"输出尺寸应为 (4,1)，实际 {tuple(probs.shape)}。")
        check_tensor_finite(probs, "Discriminator 输出")
        if probs.min().item() < 0 or probs.max().item() > 1:
            raise ValueError("Discriminator 输出不在 [0,1] 概率范围内。")
        return "输出尺寸及概率范围正确"

    tests.append(run("Discriminator 前向传播", _disc_fwd))

    # 6) Gradient Penalty
    def _gp():
        if not hasattr(student, "gradient_penalty"):
            raise AttributeError("缺少 gradient_penalty 函数。")
        if discriminator["v"] is None:
            raise RuntimeError("Discriminator 未成功实例化。")
        discriminator["v"].train()
        real = torch.randn(4, 1, IMAGE_SIZE, IMAGE_SIZE, device=DEVICE)
        gen = torch.randn(4, 1, IMAGE_SIZE, IMAGE_SIZE, device=DEVICE)
        gp = student.gradient_penalty(discriminator["v"], real, gen)
        if not torch.is_tensor(gp):
            raise TypeError("Gradient Penalty 返回值不是 Tensor。")
        if gp.ndim != 0:
            raise ValueError("Gradient Penalty 应返回标量 Tensor。")
        check_tensor_finite(gp, "Gradient Penalty")
        if gp.item() < 0:
            raise ValueError("Gradient Penalty 不应小于 0。")
        return f"数值={gp.item():.6f}"

    tests.append(run("Gradient Penalty", _gp))

    # 7) train_gan 函数存在
    def _train():
        if not hasattr(student, "train_gan"):
            raise AttributeError("缺少 train_gan 函数。")
        if not callable(student.train_gan):
            raise TypeError("train_gan 不是可调用函数。")
        return "train_gan 函数存在"

    tests.append(run("GAN 训练函数", _train))

    passed_count = sum(1 for _, p, _ in tests if p)
    total = len(tests)

    for i, (name, p, detail) in enumerate(tests, 1):
        mark = "√" if p else "×"
        print(f"[{mark}] 测试{i:02d}：{name}--{detail}")

    print(f"Tests Passed: {passed_count}/{total}")
    if passed_count >= 5:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
