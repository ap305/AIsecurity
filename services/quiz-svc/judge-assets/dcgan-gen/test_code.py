"""
DCGAN 图像生成实验 - 教师评测脚本（适配平台 judge.ts code_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <student_code_dir>

约定输出：
    Tests Passed: N/M
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 Generator 与 Discriminator。
- 检查：Generator 定义、Discriminator 定义、Generator 前向输出形状 (4,1,28,28)、
  Discriminator 前向输出 batch 维，共 4 个测试用例。
- 不依赖 matplotlib 与训练产物；结果文件检查已移除（评测环境无 matplotlib，且
  DCGAN 训练 20 epoch 超出评测时限）。
"""

import sys
import importlib.util
from pathlib import Path

import torch

NOISE_DIM = 100
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


def load_student(code_dir):
    code_file = Path(code_dir) / "student_code.py"
    if not code_file.exists():
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


def main():
    if len(sys.argv) < 2:
        print("测试未通过：缺少参数 <student_code_dir>")
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    code_dir = sys.argv[1]
    torch.manual_seed(42)

    module = load_student(code_dir)
    if module is None:
        print("Tests Passed: 0/4")
        print("测试未通过")
        return 1

    passed = 0
    total = 4

    # 1) Generator 定义
    try:
        netG = module.Generator()
        ok = netG is not None
    except Exception as e:
        ok = False
        print(f"Generator 实例化失败：{e}")
    if ok:
        passed += 1
    else:
        print("Generator 定义错误")

    # 2) Discriminator 定义
    try:
        netD = module.Discriminator()
        ok = netD is not None
    except Exception as e:
        ok = False
        print(f"Discriminator 实例化失败：{e}")
    if ok:
        passed += 1
    else:
        print("Discriminator 定义错误")

    # 3) Generator 前向输出形状
    try:
        netG = module.Generator().to(DEVICE)
        noise = torch.randn(4, NOISE_DIM, 1, 1).to(DEVICE)
        output = netG(noise)
        ok = tuple(output.shape) == (4, 1, 28, 28)
    except Exception as e:
        ok = False
        print(f"Generator 前向失败：{e}")
    if ok:
        passed += 1
    else:
        print(f"Generator 输出形状应为 (4,1,28,28)，实际 {tuple(output.shape) if 'output' in dir() else 'N/A'}")

    # 4) Discriminator 前向输出 batch 维
    try:
        netD = module.Discriminator().to(DEVICE)
        images = torch.randn(4, 1, 28, 28).to(DEVICE)
        output = netD(images)
        ok = output.shape[0] == 4
    except Exception as e:
        ok = False
        print(f"Discriminator 前向失败：{e}")
    if ok:
        passed += 1
    else:
        print("Discriminator 输出 batch 维应为 4")

    print(f"Tests Passed: {passed}/{total}")
    if passed >= 3:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
