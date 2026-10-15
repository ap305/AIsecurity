"""
Reference_code.py
预训练目标检测模型推理实验参考代码

功能：
1. 从 input_images 文件夹及其子文件夹读取图片；
2. 加载 torchvision 官方 COCO 预训练 Faster R-CNN 模型；
3. 执行目标检测推理；
4. 根据置信度阈值筛选结果；
5. 绘制检测框、类别名称和置信度；
6. 保存检测结果图片和 detections.csv；
7. 统计推理时间。

运行示例：
    python Reference_code.py
    python Reference_code.py --score-threshold 0.7
    python Reference_code.py --device cpu
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
    """选择推理设备。"""
    if device_name == "cpu":
        return torch.device("cpu")

    if device_name == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError(
                "当前环境无法使用 CUDA，请检查显卡驱动和 PyTorch 安装，"
                "或使用 --device cpu。"
            )
        return torch.device("cuda")

    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def find_images(input_dir: Path) -> List[Path]:
    """递归查找输入目录中的图片。"""
    if not input_dir.exists():
        raise FileNotFoundError(
            f"输入目录不存在：{input_dir.resolve()}\n"
            f"请创建 input_images 文件夹并放入图片。"
        )

    if not input_dir.is_dir():
        raise NotADirectoryError(f"输入路径不是文件夹：{input_dir.resolve()}")

    image_paths = sorted(
        path
        for path in input_dir.rglob("*")
        if path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_SUFFIXES
    )

    if not image_paths:
        all_files = [
            str(path.relative_to(input_dir))
            for path in input_dir.rglob("*")
            if path.is_file()
        ]

        file_text = (
            "\n".join(f"  - {name}" for name in all_files)
            if all_files
            else "  （文件夹为空）"
        )

        raise RuntimeError(
            f"{input_dir.resolve()} 中没有可处理的图片。\n"
            f"支持格式：{', '.join(sorted(SUPPORTED_IMAGE_SUFFIXES))}\n"
            f"当前目录中的文件：\n{file_text}"
        )

    return image_paths


def load_model(
    device: torch.device,
) -> Tuple[torch.nn.Module, object, Sequence[str]]:
    """加载 COCO 预训练 Faster R-CNN 模型。"""
    weights = FasterRCNN_ResNet50_FPN_V2_Weights.DEFAULT

    model = fasterrcnn_resnet50_fpn_v2(weights=weights)
    model.to(device)
    model.eval()

    preprocess = weights.transforms()
    categories = weights.meta["categories"]

    return model, preprocess, categories


def load_image(image_path: Path) -> Image.Image:
    """读取图片并转换为 RGB。"""
    try:
        with Image.open(image_path) as image:
            return image.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError(f"无法读取图片：{image_path}") from exc


def synchronize_if_needed(device: torch.device) -> None:
    """CUDA 推理计时前后进行同步。"""
    if device.type == "cuda":
        torch.cuda.synchronize(device)


def run_inference(
    model: torch.nn.Module,
    image_tensor: torch.Tensor,
    device: torch.device,
) -> Tuple[Dict[str, torch.Tensor], float]:
    """执行单张图片推理。"""
    image_tensor = image_tensor.to(device)

    synchronize_if_needed(device)
    start_time = time.perf_counter()

    with torch.inference_mode():
        prediction = model([image_tensor])[0]

    synchronize_if_needed(device)
    inference_time = time.perf_counter() - start_time

    prediction_cpu = {
        key: value.detach().cpu()
        for key, value in prediction.items()
        if isinstance(value, torch.Tensor)
    }

    return prediction_cpu, inference_time


def filter_predictions(
    prediction: Dict[str, torch.Tensor],
    score_threshold: float,
) -> List[Dict[str, object]]:
    """根据置信度阈值筛选检测结果。"""
    boxes = prediction["boxes"]
    labels = prediction["labels"]
    scores = prediction["scores"]

    detections: List[Dict[str, object]] = []
    epsilon = 1e-6

    for box, label, score in zip(boxes, labels, scores):
        score_value = float(score.item())

        # 使用微小容差，避免 float32 中的 0.70
        # 实际存储为 0.699999988 而被错误过滤。
        if score_value + epsilon < score_threshold:
            continue

        x1, y1, x2, y2 = [
            float(value) for value in box.tolist()
        ]

        detections.append(
            {
                "label_id": int(label.item()),
                "score": score_value,
                "box": (x1, y1, x2, y2),
            }
        )

    return detections


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
    """在图片上绘制边界框、类别名称和置信度。"""
    result_image = image.copy()
    draw = ImageDraw.Draw(result_image)
    font = get_font(18)

    image_width, image_height = result_image.size
    line_width = max(2, round(min(image_width, image_height) / 250))

    for detection in detections:
        label_id = int(detection["label_id"])
        score = float(detection["score"])
        x1, y1, x2, y2 = detection["box"]

        x1 = max(0.0, min(float(x1), image_width - 1))
        y1 = max(0.0, min(float(y1), image_height - 1))
        x2 = max(0.0, min(float(x2), image_width - 1))
        y2 = max(0.0, min(float(y2), image_height - 1))

        if 0 <= label_id < len(categories):
            class_name = categories[label_id]
        else:
            class_name = f"class_{label_id}"

        label_text = f"{class_name} {score:.2f}"

        draw.rectangle(
            [(x1, y1), (x2, y2)],
            outline="red",
            width=line_width,
        )

        text_bbox = draw.textbbox((0, 0), label_text, font=font)
        text_width = text_bbox[2] - text_bbox[0]
        text_height = text_bbox[3] - text_bbox[1]

        label_x1 = x1
        label_y1 = max(0.0, y1 - text_height - 8)
        label_x2 = min(float(image_width), label_x1 + text_width + 8)
        label_y2 = min(float(image_height), label_y1 + text_height + 8)

        draw.rectangle(
            [(label_x1, label_y1), (label_x2, label_y2)],
            fill="red",
        )
        draw.text(
            (label_x1 + 4, label_y1 + 4),
            label_text,
            fill="white",
            font=font,
        )

    return result_image


def make_output_path(
    image_path: Path,
    input_dir: Path,
    output_dir: Path,
) -> Path:
    """生成检测结果图片的保存路径。"""
    relative_path = image_path.relative_to(input_dir)
    output_subdir = output_dir / relative_path.parent
    output_subdir.mkdir(parents=True, exist_ok=True)

    return output_subdir / f"{image_path.stem}_detected.jpg"


def save_csv(csv_path: Path, rows: List[Dict[str, object]]) -> None:
    """保存检测结果 CSV。"""
    fieldnames = [
        "image",
        "label_id",
        "label",
        "score",
        "x1",
        "y1",
        "x2",
        "y2",
        "inference_time_seconds",
    ]

    with csv_path.open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


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