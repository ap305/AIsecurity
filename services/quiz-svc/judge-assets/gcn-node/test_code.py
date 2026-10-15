"""
GCN 节点分类实验 - 教师评测脚本（适配平台 judge.ts model_eval 约定）

调用方式（由 judge.ts 调用）：
    python test_code.py <model_path> <student_code_dir>

约定输出：
    Test Accuracy: XX.XX%
    测试通过 / 测试未通过

说明：
- 从 <student_code_dir>/student_code.py 导入 GraphConvolution/GCN 及 load_cora/split_data/test。
- 加载学生上传的模型 <model_path>（gcn_model.pth）。
- 调用 student.load_cora() 读取 ./data/Cora/cora（judge-assets/gcn-node/），
  用 student.split_data 划分测试掩码，student.test 计算节点分类准确率。
- 不依赖 matplotlib 与 sklearn；loss_curve.png 检查已移除，LabelEncoder 已替换为手写映射。
"""

import sys
import importlib.util
import os
from pathlib import Path

import torch


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
    if len(sys.argv) < 3:
        print("测试未通过：缺少参数 <model_path> <student_code_dir>")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    model_path = sys.argv[1]
    code_dir = sys.argv[2]
    torch.manual_seed(42)

    if not os.path.exists(model_path):
        print(f"测试未通过：模型文件未找到 {model_path}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    student = load_student(code_dir)
    if student is None:
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 加载 Cora 数据
    try:
        x, adj, y = student.load_cora()
        assert x.shape[0] == 2708 and x.shape[1] == 1433, f"Cora 特征形状错误：{tuple(x.shape)}"
        assert len(torch.unique(y)) == 7, f"类别数应为 7，实际 {len(torch.unique(y))}"
    except Exception as e:
        print(f"测试未通过：Cora 数据加载失败（检查 ./data/Cora/cora）：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 结构检查（诊断）
    try:
        gc_layer = student.GraphConvolution(1433, 16)
        assert hasattr(gc_layer, "weight") and hasattr(gc_layer, "bias")
        model = student.GCN(1433, 16, 7)
        assert len(list(model.parameters())) > 0
        model.eval()
        with torch.no_grad():
            out = model(x, adj)
        assert tuple(out.shape) == (2708, 7), f"forward 输出形状应为 (2708,7)，实际 {tuple(out.shape)}"
    except Exception as e:
        print(f"测试未通过：结构/前向检查失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 加载模型
    try:
        model = student.GCN(1433, 16, 7)
        state = torch.load(model_path, map_location="cpu")
        model.load_state_dict(state)
    except Exception as e:
        print(f"测试未通过：模型加载失败（state_dict 不匹配？）：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    # 测试准确率
    try:
        _, _, test_mask = student.split_data(x.shape[0])
        acc = student.test(model, x, adj, y, test_mask)
    except Exception as e:
        print(f"测试未通过：评测执行失败：{e}")
        print("Test Accuracy: 0.00%")
        print("测试未通过")
        return 1

    acc = float(acc)
    print(f"Test Accuracy: {acc * 100:.2f}%")
    if acc >= 0.75:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
