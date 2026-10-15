"""
LeNet 手写数字识别测试代码

运行：
python test_code.py model.pth /path/to/student_code_dir/

从学生提交的代码中动态导入 LeNet 类，加载模型权重并评测。
"""

import argparse
import sys
from pathlib import Path

import torch
import torch.nn as nn
from datasets import Dataset
from torch.utils.data import DataLoader
from torchvision import transforms


# =========================
BASE_DIR = Path(__file__).resolve().parent

TEST_ARROW = (
    BASE_DIR
    / "mnist_huggingface"
    / "test"
    / "data-00000-of-00001.arrow"
)


# =========================
# Dataset
# =========================


class MNISTDataset(torch.utils.data.Dataset):
    def __init__(self, path):
        self.data = Dataset.from_file(str(path))
        self.transform = transforms.Compose(
            [
                transforms.ToTensor(),
                transforms.Normalize((0.1307,), (0.3081,)),
            ]
        )

    def __len__(self):
        return len(self.data)

    def __getitem__(self, index):
        item = self.data[index]
        return (self.transform(item["image"]), item["label"])


# =========================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model_path", help="Path to model.pth file")
    parser.add_argument("code_dir", help="Directory containing student_code.py")
    args = parser.parse_args()

    code_dir = Path(args.code_dir)
    code_file = code_dir / "student_code.py"

    if not code_file.exists():
        print(f"错误：学生代码文件不存在: {code_file}")
        print("测试未通过")
        return

    # Dynamically import LeNet from student's code
    sys.path.insert(0, str(code_dir))
    try:
        from student_code import LeNet  # type: ignore
    except ImportError as e:
        print(f"错误：无法从学生代码中导入 LeNet 类: {e}")
        print("请确保代码中定义了名为 LeNet 的类（继承自 nn.Module）")
        print("测试未通过")
        return
    except Exception as e:
        print(f"错误：导入学生代码时发生异常: {e}")
        print("测试未通过")
        return

    # Verify LeNet is a valid nn.Module
    try:
        model = LeNet()
    except Exception as e:
        print(f"错误：无法实例化 LeNet 模型，请检查 __init__ 方法: {e}")
        print("测试未通过")
        return

    if not isinstance(model, nn.Module):
        print("错误：LeNet 必须继承自 torch.nn.Module")
        print("测试未通过")
        return

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = model.to(device)

    # Load student's trained weights
    try:
        state_dict = torch.load(args.model_path, map_location=device)
        model.load_state_dict(state_dict)
    except RuntimeError as e:
        print(f"错误：模型权重与代码不匹配: {e}")
        print("请确保提交的代码与训练的模型结构一致")
        print("测试未通过")
        return
    except Exception as e:
        print(f"错误：加载模型文件失败: {e}")
        print("测试未通过")
        return

    model.eval()

    # Evaluate on MNIST test set
    dataset = MNISTDataset(TEST_ARROW)
    loader = DataLoader(dataset, batch_size=128)

    correct = 0
    total = 0

    with torch.no_grad():
        for images, labels in loader:
            images = images.to(device)
            labels = labels.to(device)
            output = model(images)
            pred = output.argmax(dim=1)
            correct += (pred == labels).sum().item()
            total += labels.size(0)

    acc = correct / total

    print("===================")
    print(f"Test Accuracy: {acc:.2%}")

    if acc >= 0.95:
        print("测试通过")
    else:
        print("测试未通过")

    print("===================")


if __name__ == "__main__":
    main()
