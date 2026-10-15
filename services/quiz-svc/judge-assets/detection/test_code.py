"""
Test_code.py
预训练目标检测模型推理实验自动测试与评分程序

评分规则：
    共 11 个测试项目，满分 100 分。
    每个项目分值 = 100 / 11 ≈ 9.09 分。
    每失败一个项目，扣除对应项目分值。
    最终成绩 = 通过项目数 / 11 × 100。

运行方式：
    python Test_code.py
    python Test_code.py --target Reference_code
    python Test_code.py --target Todo_code

说明：
    --target 后面可以写 Reference_code，也可以写 Reference_code.py。
"""

import argparse
import csv
import importlib
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import numpy as np
import torch
from PIL import Image


REQUIRED_FUNCTIONS = [
    "select_device",
    "find_images",
    "load_image",
    "run_inference",
    "filter_predictions",
    "draw_detections",
    "make_output_path",
    "save_csv",
]

TOTAL_SCORE = 100.0
TOTAL_TESTS = 11
SCORE_PER_TEST = TOTAL_SCORE / TOTAL_TESTS


class FakeDetectionModel(torch.nn.Module):
    """
    模拟目标检测模型。

    不加载真实 Faster R-CNN 权重，而是返回固定的 boxes、labels 和 scores，
    从而测试学生代码中的推理接口是否正确。
    """

    def forward(self, images):
        if not isinstance(images, list):
            raise TypeError("目标检测模型的输入必须是 Tensor 列表。")

        results = []

        for image in images:
            if not isinstance(image, torch.Tensor):
                raise TypeError("图片必须是 torch.Tensor。")

            results.append(
                {
                    "boxes": torch.tensor(
                        [
                            [10.0, 20.0, 110.0, 220.0],
                            [30.0, 40.0, 80.0, 100.0],
                        ],
                        dtype=torch.float32,
                        device=image.device,
                    ),
                    "labels": torch.tensor(
                        [1, 18],
                        dtype=torch.int64,
                        device=image.device,
                    ),
                    "scores": torch.tensor(
                        [0.95, 0.40],
                        dtype=torch.float32,
                        device=image.device,
                    ),
                }
            )

        return results


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    parser = argparse.ArgumentParser(
        description="预训练目标检测模型推理实验自动测试与评分程序"
    )
    parser.add_argument(
        "--target",
        default="Reference_code",
        help="被测试文件，例如 Reference_code、Reference_code.py 或 Todo_code",
    )
    return parser.parse_args()


def load_student_module(code_dir):
    """从 code_dir/student_code.py 加载学生代码模块。"""
    from pathlib import Path
    import importlib.util
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

def assert_true(condition: bool, message: str) -> None:
    """条件不成立时抛出异常。"""
    if not condition:
        raise AssertionError(message)


def assert_close(
    actual: float,
    expected: float,
    tolerance: float = 1e-5,
    message: str = "",
) -> None:
    """检查两个浮点数是否近似相等。"""
    if abs(actual - expected) > tolerance:
        raise AssertionError(
            message or f"实际值 {actual} 与期望值 {expected} 不一致。"
        )


def test_required_functions(module) -> None:
    """1. 检查核心函数是否完整。"""
    missing_functions = [
        function_name
        for function_name in REQUIRED_FUNCTIONS
        if not callable(getattr(module, function_name, None))
    ]

    assert_true(
        not missing_functions,
        "缺少核心函数：" + ", ".join(missing_functions),
    )


def test_select_device(module) -> None:
    """2. 检查 CPU 设备选择。"""
    device = module.select_device("cpu")

    assert_true(
        isinstance(device, torch.device),
        "select_device() 应返回 torch.device。",
    )
    assert_true(
        device.type == "cpu",
        "select_device('cpu') 应返回 CPU 设备。",
    )


def test_find_images(module) -> None:
    """3. 检查图片搜索及子目录递归搜索。"""
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        input_dir = root / "input_images"
        sub_dir = input_dir / "val2017"
        sub_dir.mkdir(parents=True)

        Image.new("RGB", (32, 24), "white").save(input_dir / "image_a.jpg")
        Image.new("RGB", (32, 24), "white").save(sub_dir / "image_b.PNG")
        Image.new("RGB", (32, 24), "white").save(sub_dir / "image_c.jpeg")
        (input_dir / "readme.txt").write_text(
            "这不是图片。",
            encoding="utf-8",
        )

        paths = module.find_images(input_dir)
        names = [path.name for path in paths]

        assert_true(len(paths) == 3, "find_images() 应找到 3 张图片。")
        assert_true("image_a.jpg" in names, "没有找到 JPG 图片。")
        assert_true("image_b.PNG" in names, "没有找到 PNG 图片。")
        assert_true("image_c.jpeg" in names, "没有找到 JPEG 图片。")
        assert_true("readme.txt" not in names, "TXT 不应被识别为图片。")


def test_empty_directory(module) -> None:
    """4. 检查空图片目录的异常处理。"""
    with tempfile.TemporaryDirectory() as temp_dir:
        input_dir = Path(temp_dir) / "input_images"
        input_dir.mkdir()

        try:
            module.find_images(input_dir)
        except RuntimeError as exc:
            assert_true(
                "没有可处理的图片" in str(exc),
                "错误信息应说明目录中没有可处理的图片。",
            )
            return

        raise AssertionError(
            "当输入目录为空时，find_images() 应抛出 RuntimeError。"
        )


def test_load_image(module) -> None:
    """5. 检查图片读取与 RGB 转换。"""
    with tempfile.TemporaryDirectory() as temp_dir:
        image_path = Path(temp_dir) / "gray.png"
        Image.new("L", (40, 30), 128).save(image_path)

        image = module.load_image(image_path)

        assert_true(isinstance(image, Image.Image), "应返回 PIL.Image。")
        assert_true(image.mode == "RGB", "读取后的图片应转换为 RGB。")
        assert_true(image.size == (40, 30), "图片尺寸不应改变。")


def test_run_inference(module) -> None:
    """6. 检查模型推理接口。"""
    model = FakeDetectionModel().eval()
    image_tensor = torch.zeros((3, 240, 320), dtype=torch.float32)

    prediction, inference_time = module.run_inference(
        model=model,
        image_tensor=image_tensor,
        device=torch.device("cpu"),
    )

    assert_true(isinstance(prediction, dict), "预测结果应为字典。")
    assert_true("boxes" in prediction, "预测结果缺少 boxes。")
    assert_true("labels" in prediction, "预测结果缺少 labels。")
    assert_true("scores" in prediction, "预测结果缺少 scores。")
    assert_true(
        prediction["boxes"].shape == (2, 4),
        "模拟模型应返回两个边界框。",
    )
    assert_true(
        prediction["boxes"].device.type == "cpu",
        "预测结果应移动到 CPU。",
    )
    assert_true(
        isinstance(inference_time, float) and inference_time >= 0.0,
        "推理时间应为非负浮点数。",
    )


def test_filter_predictions(module) -> None:
    """7. 检查置信度筛选。"""
    prediction = {
        "boxes": torch.tensor(
            [
                [10.0, 20.0, 110.0, 220.0],
                [30.0, 40.0, 80.0, 100.0],
                [0.0, 0.0, 20.0, 20.0],
            ],
            dtype=torch.float32,
        ),
        "labels": torch.tensor([1, 18, 3], dtype=torch.int64),
        # 使用 0.71 避免 float32 边界值 0.70 的精度歧义
        "scores": torch.tensor([0.95, 0.69, 0.71], dtype=torch.float32),
    }

    detections = module.filter_predictions(
        prediction=prediction,
        score_threshold=0.70,
    )

    assert_true(
        len(detections) == 2,
        "阈值为 0.70 时应保留分数为 0.95 和 0.71 的两个目标。",
    )
    assert_true(
        detections[0]["label_id"] == 1,
        "第一个保留目标的类别编号应为 1。",
    )
    assert_true(
        detections[1]["label_id"] == 3,
        "第二个保留目标的类别编号应为 3。",
    )
    assert_close(
        float(detections[0]["score"]),
        0.95,
        message="第一个目标的置信度错误。",
    )


def test_draw_detections(module) -> None:
    """8. 检查检测框绘制。"""
    image = Image.new("RGB", (200, 160), "white")
    original_pixel = image.getpixel((20, 20))

    detections = [
        {
            "label_id": 1,
            "score": 0.95,
            "box": (20.0, 20.0, 120.0, 140.0),
        }
    ]
    categories = ["background", "person"]

    result_image = module.draw_detections(
        image=image,
        detections=detections,
        categories=categories,
    )

    assert_true(
        isinstance(result_image, Image.Image),
        "draw_detections() 应返回 PIL.Image。",
    )
    assert_true(
        result_image.size == image.size,
        "绘制前后图片尺寸应保持一致。",
    )
    assert_true(
        result_image is not image,
        "不应直接修改原始图片对象。",
    )
    assert_true(
        image.getpixel((20, 20)) == original_pixel,
        "原始图片不应被修改。",
    )
    assert_true(
        result_image.getpixel((20, 20)) != original_pixel,
        "检测框位置的像素应发生变化。",
    )


def test_make_output_path(module) -> None:
    """9. 检查输出路径生成。"""
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        input_dir = root / "input_images"
        output_dir = root / "outputs"
        image_path = input_dir / "val2017" / "test.jpg"

        image_path.parent.mkdir(parents=True)
        image_path.touch()

        output_path = module.make_output_path(
            image_path=image_path,
            input_dir=input_dir,
            output_dir=output_dir,
        )

        expected_path = output_dir / "val2017" / "test_detected.jpg"

        assert_true(
            output_path == expected_path,
            f"输出路径错误：实际为 {output_path}。",
        )
        assert_true(
            output_path.parent.exists(),
            "应自动创建输出子目录。",
        )


def test_save_csv(module) -> None:
    """10. 检查 CSV 保存。"""
    rows = [
        {
            "image": "test.jpg",
            "label_id": 1,
            "label": "person",
            "score": "0.950000",
            "x1": "10.00",
            "y1": "20.00",
            "x2": "110.00",
            "y2": "220.00",
            "inference_time_seconds": "0.100000",
        }
    ]

    with tempfile.TemporaryDirectory() as temp_dir:
        csv_path = Path(temp_dir) / "detections.csv"
        module.save_csv(csv_path, rows)

        assert_true(csv_path.exists(), "没有生成 detections.csv。")

        with csv_path.open(
            "r",
            newline="",
            encoding="utf-8-sig",
        ) as file:
            saved_rows = list(csv.DictReader(file))

        assert_true(len(saved_rows) == 1, "CSV 应包含一条检测记录。")
        assert_true(
            saved_rows[0]["label"] == "person",
            "CSV 中的类别名称错误。",
        )
        assert_true(
            saved_rows[0]["score"] == "0.950000",
            "CSV 中的置信度错误。",
        )


def test_mini_pipeline(module) -> None:
    """11. 检查最小完整推理流程。"""
    with tempfile.TemporaryDirectory() as temp_dir:
        root = Path(temp_dir)
        input_dir = root / "input_images"
        output_dir = root / "outputs"
        input_dir.mkdir()
        output_dir.mkdir()

        image_path = input_dir / "test.jpg"
        Image.new("RGB", (320, 240), "white").save(image_path)

        image = module.load_image(image_path)

        image_array = np.array(image)
        image_tensor = (
            torch.from_numpy(image_array)
            .permute(2, 0, 1)
            .float()
            / 255.0
        )

        model = FakeDetectionModel().eval()

        prediction, inference_time = module.run_inference(
            model=model,
            image_tensor=image_tensor,
            device=torch.device("cpu"),
        )

        detections = module.filter_predictions(
            prediction=prediction,
            score_threshold=0.70,
        )

        categories = ["N/A"] * 19
        categories[1] = "person"
        categories[18] = "dog"

        result_image = module.draw_detections(
            image=image,
            detections=detections,
            categories=categories,
        )

        output_image_path = module.make_output_path(
            image_path=image_path,
            input_dir=input_dir,
            output_dir=output_dir,
        )
        result_image.save(output_image_path)

        rows = []
        for detection in detections:
            label_id = int(detection["label_id"])
            x1, y1, x2, y2 = detection["box"]

            rows.append(
                {
                    "image": image_path.name,
                    "label_id": label_id,
                    "label": categories[label_id],
                    "score": f"{float(detection['score']):.6f}",
                    "x1": f"{float(x1):.2f}",
                    "y1": f"{float(y1):.2f}",
                    "x2": f"{float(x2):.2f}",
                    "y2": f"{float(y2):.2f}",
                    "inference_time_seconds": f"{inference_time:.6f}",
                }
            )

        csv_path = output_dir / "detections.csv"
        module.save_csv(csv_path, rows)

        assert_true(
            output_image_path.exists(),
            "最小流程没有生成检测结果图片。",
        )
        assert_true(
            csv_path.exists(),
            "最小流程没有生成 detections.csv。",
        )
        assert_true(
            len(detections) == 1,
            "模拟结果经过阈值筛选后应保留一个目标。",
        )


def run_test(
    test_function: Callable,
    module,
) -> Tuple[bool, str]:
    """执行单个测试。"""
    try:
        test_function(module)
        return True, ""
    except Exception:
        return False, traceback.format_exc()


def calculate_score(passed_tests: int) -> int:
    """根据通过项目数计算百分制成绩，并四舍五入取整。"""
    return round(passed_tests / TOTAL_TESTS * TOTAL_SCORE)


def main():
    """平台评测入口：python test_code.py <student_code_dir>"""
    import argparse
    import sys
    parser = argparse.ArgumentParser()
    parser.add_argument("code_dir", help="学生代码目录（含 student_code.py）")
    args = parser.parse_args()

    module = load_student_module(args.code_dir)
    if module is None:
        print("Tests Passed: 0/11")
        print("测试未通过")
        return 1

    tests = [
        ("必需函数检查", test_required_functions),
        ("设备选择", test_select_device),
        ("递归找图片", test_find_images),
        ("空目录异常处理", test_empty_directory),
        ("图片读取与 RGB 转换", test_load_image),
        ("模型推理接口", test_run_inference),
        ("置信度筛选", test_filter_predictions),
        ("检测框绘制", test_draw_detections),
        ("输出路径生成", test_make_output_path),
        ("CSV 保存", test_save_csv),
        ("最小端到端流程", test_mini_pipeline),
    ]

    passed = 0
    total = len(tests)
    for name, fn in tests:
        ok, _ = run_test(fn, module)
        if ok:
            passed += 1
            print(f"[PASS] {name}")
        else:
            print(f"[FAIL] {name}")

    print(f"Tests Passed: {passed}/{total}")
    if passed >= 6:
        print("测试通过")
        return 0
    else:
        print("测试未通过")
        return 1


if __name__ == "__main__":
    sys.exit(main())
