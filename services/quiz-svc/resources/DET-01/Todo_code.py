"""
Todo_code.py
预训练目标检测模型推理实验学生代码

实验任务：
1. 递归读取 input_images 文件夹及其子文件夹中的图片；
2. 加载 torchvision 官方 COCO 预训练 Faster R-CNN 模型；
3. 完成图片读取、预处理与目标检测推理；
4. 根据置信度阈值筛选检测结果；
5. 绘制检测框、类别名称和置信度；
6. 保存检测结果图片和 detections.csv；
7. 统计单张图片推理时间。

运行示例：
    python Todo_code.py

说明：
- 请完成所有标有 TODO 的位置。
- 不要修改函数名称、参数名称或返回值格式，否则测试程序可能无法识别。
"""

import argparse
import csv
import time
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import torch
from PIL import Image, ImageDraw, ImageFont, UnidentifiedImageError
from torchvision.models.detection import (
    FasterRCNN_ResNet50_FPN_V2_Weights,
    fasterrcnn_resnet50_fpn_v2,
)


SUPPORTED_IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_args() -> argparse.Namespace:
    """解析命令行参数。"""
    base_dir = Path(__file__).resolve().parent

    parser = argparse.ArgumentParser(
        description="使用 COCO 预训练 Faster R-CNN 进行目标检测推理"
    )
    parser.add_argument(
        "--input-dir",
        type=Path,
        default=base_dir / "input_images",
        help="输入图片目录，默认是脚本旁边的 input_images",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=base_dir / "outputs",
        help="输出目录，默认是脚本旁边的 outputs",
    )
    parser.add_argument(
        "--score-threshold",
        type=float,
        default=0.70,
        help="置信度阈值，默认 0.70",
    )
    parser.add_argument(
        "--device",
        choices=["auto", "cpu", "cuda"],
        default="auto",
        help="运行设备：auto、cpu 或 cuda",
    )
    return parser.parse_args()


def select_device(device_name: str) -> torch.device:
    """
    选择推理设备。

    参数：
        device_name:
            "cpu"  强制使用 CPU；
            "cuda" 强制使用 GPU；
            "auto" 自动选择。

    返回：
        torch.device

    TODO 1：
    - 当 device_name 为 "cpu" 时返回 CPU；
    - 当 device_name 为 "cuda" 时，先判断 CUDA 是否可用；
    - 当 device_name 为 "auto" 时，优先使用 CUDA，否则使用 CPU。
    """
    # TODO: 在此处完成设备选择
    raise NotImplementedError("请完成 select_device()")


def find_images(input_dir: Path) -> List[Path]:
    """
    递归查找输入目录中的图片。

    返回：
        按路径排序后的图片路径列表。

    TODO 2：
    - 检查 input_dir 是否存在；
    - 检查 input_dir 是否为文件夹；
    - 使用 rglob 递归查找文件；
    - 只保留 SUPPORTED_IMAGE_SUFFIXES 中支持的图片；
    - 后缀判断时应忽略大小写；
    - 目录中没有图片时抛出 RuntimeError，
      错误信息中应包含“没有可处理的图片”。
    """
    # TODO: 在此处完成图片搜索
    raise NotImplementedError("请完成 find_images()")


def load_model(
    device: torch.device,
) -> Tuple[torch.nn.Module, object, Sequence[str]]:
    """
    加载 COCO 预训练 Faster R-CNN 模型。

    返回：
        model：目标检测模型；
        preprocess：官方预处理方法；
        categories：COCO 类别名称序列。

    TODO 3：
    - 使用 FasterRCNN_ResNet50_FPN_V2_Weights.DEFAULT；
    - 使用 fasterrcnn_resnet50_fpn_v2 加载模型；
    - 将模型移动到 device；
    - 将模型设置为评估模式；
    - 从权重对象中获取预处理方法和类别名称。
    """
    # TODO: 在此处完成模型加载
    raise NotImplementedError("请完成 load_model()")


def load_image(image_path: Path) -> Image.Image:
    """
    读取图片并转换为 RGB。

    TODO 4：
    - 使用 Image.open() 读取图片；
    - 将图片转换为 RGB；
    - 为避免文件句柄未关闭，建议使用 with；
    - 捕获 UnidentifiedImageError 和 OSError；
    - 图片读取失败时抛出 ValueError。
    """
    # TODO: 在此处完成图片读取
    raise NotImplementedError("请完成 load_image()")


def synchronize_if_needed(device: torch.device) -> None:
    """CUDA 推理计时前后进行同步。"""
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def run_inference(
    model: torch.nn.Module,
    image_tensor: torch.Tensor,
    device: torch.device,
) -> Tuple[Dict[str, torch.Tensor], float]:
    """
    执行单张图片推理。

    返回：
        prediction：包含 boxes、labels、scores 等内容的字典；
        inference_time：单张图片推理时间，单位为秒。

    TODO 5：
    - 将 image_tensor 移动到 device；
    - 推理计时前后调用 synchronize_if_needed()；
    - 使用 time.perf_counter() 计时；
    - 使用 torch.inference_mode() 关闭梯度计算；
    - torchvision 检测模型输入应为 Tensor 列表；
    - 获取第一张图片的预测结果；
    - 将预测结果中的 Tensor 分离并移动到 CPU；
    - 返回预测字典和推理时间。
    """
    # TODO: 在此处完成单张图片推理
    raise NotImplementedError("请完成 run_inference()")


def filter_predictions(
    prediction: Dict[str, torch.Tensor],
    score_threshold: float,
) -> List[Dict[str, object]]:
    """
    根据置信度阈值筛选检测结果。

    每个检测结果字典必须包含：
        {
            "label_id": 类别编号（int）,
            "score": 置信度（float）,
            "box": (x1, y1, x2, y2)
        }

    TODO 6：
    - 从 prediction 中取出 boxes、labels、scores；
    - 同时遍历三组数据；
    - 只保留 score 大于或等于 score_threshold 的目标；
    - 将 Tensor 转换为普通 Python 数值；
    - 注意 float32 边界值误差，可设置一个很小的 epsilon。
    """
    # TODO: 在此处完成置信度筛选
    raise NotImplementedError("请完成 filter_predictions()")


def get_font(size: int = 18) -> ImageFont.ImageFont:
    """获取用于绘制标签的字体。"""
    font_candidates = [
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("C:/Windows/Fonts/calibri.ttf"),
        Path("C:/Windows/Fonts/msyh.ttc"),
        Path("C:/Windows/Fonts/simhei.ttf"),
    ]

    for font_path in font_candidates:
        if font_path.exists():
            try:
                return ImageFont.truetype(str(font_path), size=size)
            except OSError:
                pass

    return ImageFont.load_default()


def draw_detections(
    image: Image.Image,
    detections: List[Dict[str, object]],
    categories: Sequence[str],
) -> Image.Image:
    """
    在图片上绘制边界框、类别名称和置信度。

    要求：
    - 不直接修改传入的原始图片；
    - 返回一张新的 PIL.Image；
    - 绘制矩形检测框；
    - 标签文字包含类别名称和置信度；
    - 类别编号越界时显示 class_类别编号；
    - 检测框坐标应限制在图片范围内。

    TODO 7：
    完成检测结果可视化。
    """
    # TODO: 在此处完成检测框和标签绘制
    raise NotImplementedError("请完成 draw_detections()")


def make_output_path(
    image_path: Path,
    input_dir: Path,
    output_dir: Path,
) -> Path:
    """
    生成检测结果图片的保存路径。

    示例：
        输入图片：
            input_images/val2017/test.jpg

        输出图片：
            outputs/val2017/test_detected.jpg

    TODO 8：
    - 计算图片相对于 input_dir 的路径；
    - 在 output_dir 下保留原有子目录结构；
    - 自动创建输出子目录；
    - 输出文件名格式为：原文件名_detected.jpg。
    """
    # TODO: 在此处完成输出路径生成
    raise NotImplementedError("请完成 make_output_path()")


def save_csv(csv_path: Path, rows: List[Dict[str, object]]) -> None:
    """
    保存检测结果 CSV。

    CSV 字段顺序必须为：
        image
        label_id
        label
        score
        x1
        y1
        x2
        y2
        inference_time_seconds

    TODO 9：
    - 使用 csv.DictWriter；
    - 编码使用 utf-8-sig；
    - 写入表头；
    - 写入所有检测记录。
    """
    # TODO: 在此处完成 CSV 保存
    raise NotImplementedError("请完成 save_csv()")


def main() -> None:
    """主函数。"""
    args = parse_args()

    if not 0.0 <= args.score_threshold <= 1.0:
        raise ValueError("--score-threshold 必须位于 0 到 1 之间。")

    input_dir = args.input_dir.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print("=" * 70)
    print("预训练目标检测模型推理实验")
    print("=" * 70)
    print(f"脚本目录：{Path(__file__).resolve().parent}")
    print(f"输入目录：{input_dir}")
    print(f"输出目录：{output_dir}")
    print(f"置信度阈值：{args.score_threshold:.2f}")

    image_paths = find_images(input_dir)
    print(f"找到图片数量：{len(image_paths)}")

    device = select_device(args.device)
    print(f"运行设备：{device}")

    print("正在加载 COCO 预训练 Faster R-CNN 模型……")
    model, preprocess, categories = load_model(device)
    print("模型加载完成。")
    print("-" * 70)

    csv_rows: List[Dict[str, object]] = []
    inference_times: List[float] = []
    successful_images = 0
    failed_images = 0

    for index, image_path in enumerate(image_paths, start=1):
        relative_name = image_path.relative_to(input_dir)
        print(f"[{index}/{len(image_paths)}] 正在处理：{relative_name}")

        try:
            image = load_image(image_path)
            image_tensor = preprocess(image)

            prediction, inference_time = run_inference(
                model=model,
                image_tensor=image_tensor,
                device=device,
            )

            detections = filter_predictions(
                prediction=prediction,
                score_threshold=args.score_threshold,
            )

            result_image = draw_detections(
                image=image,
                detections=detections,
                categories=categories,
            )

            output_image_path = make_output_path(
                image_path=image_path,
                input_dir=input_dir,
                output_dir=output_dir,
            )

            result_image.save(output_image_path, quality=95)

            for detection in detections:
                label_id = int(detection["label_id"])
                x1, y1, x2, y2 = detection["box"]

                if 0 <= label_id < len(categories):
                    label_name = categories[label_id]
                else:
                    label_name = f"class_{label_id}"

                csv_rows.append(
                    {
                        "image": str(relative_name),
                        "label_id": label_id,
                        "label": label_name,
                        "score": f"{float(detection['score']):.6f}",
                        "x1": f"{float(x1):.2f}",
                        "y1": f"{float(y1):.2f}",
                        "x2": f"{float(x2):.2f}",
                        "y2": f"{float(y2):.2f}",
                        "inference_time_seconds": f"{inference_time:.6f}",
                    }
                )

            inference_times.append(inference_time)
            successful_images += 1

            print(
                f"    检测目标数：{len(detections)}，"
                f"推理时间：{inference_time:.4f} 秒"
            )
            print(f"    结果图片：{output_image_path}")

        except Exception as exc:
            failed_images += 1
            print(f"    处理失败：{exc}")

    csv_path = output_dir / "detections.csv"
    save_csv(csv_path, csv_rows)

    print("-" * 70)
    print("推理完成。")
    print(f"成功处理图片：{successful_images}")
    print(f"处理失败图片：{failed_images}")
    print(f"检测结果数量：{len(csv_rows)}")
    print(f"CSV 文件：{csv_path}")

    if inference_times:
        total_time = sum(inference_times)
        average_time = total_time / len(inference_times)
        print(f"总推理时间：{total_time:.4f} 秒")
        print(f"平均推理时间：{average_time:.4f} 秒/张")

    print("=" * 70)


if __name__ == "__main__":
    main()