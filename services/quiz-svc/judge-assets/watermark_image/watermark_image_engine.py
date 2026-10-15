#!/usr/bin/env python3
"""图片隐藏水印消除与鲁棒检测仿真引擎（确定性，numpy，无真实数据集）。

scenario: watermark_image

契约：
- 攻击  def attack(sample) -> dict
    sample["image"]  RGB uint8 H×W×3（可能带水印）
    返回 {"image": RGB uint8 H×W×3}
- 防御  def embed(sample) -> dict + def detect(request) -> dict
    embed:  sample["image"] -> {"image": 带水印图}
    detect: request["image"] -> {"watermark_probability": 0.0~1.0}

仿真：
- 32×32 RGB 测试图。8×8 DCT 中频扩频零比特水印（固定密钥 seed=42）。
- 嵌入：Y 通道 8×8 块 DCT，中频系数 (3,2)/(2,3) 加 ±alpha 伪随机序列。
- 检测：系数与密钥相关性 -> sigmoid -> watermark_probability。
- 评分：ROC-AUC（正=带水印/负=无水印，对称攻击后检测分分离度）+ PSNR 保真度。
"""

import sys
import json
import uuid
import traceback
from typing import Any

try:
    import numpy as np
except ImportError:
    np = None

# ── 工程上传支持：统一 Solution 加载器 ──
import os as _os
_COMMON_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "_common")
if _COMMON_DIR not in sys.path:
    sys.path.insert(0, _COMMON_DIR)
from solution_loader import load_user_fn, SolutionValidationError, format_checks  # noqa: E402

IMG_SIZE = 32
N_PAIRS = 4  # 4 正 4 负
ALPHA = 8.0
ATTACK_PSNR_THRESHOLD = 28.0  # dB
EMBED_PSNR_THRESHOLD = 30.0  # dB

_DCT_M = None


def get_dct_matrix():
    global _DCT_M
    if _DCT_M is None:
        N = 8
        n = np.arange(N)
        k = n.reshape(-1, 1)
        M = np.cos(np.pi * (2 * n + 1) * k / (2 * N)) * np.sqrt(2 / N)
        M[0] *= 1 / np.sqrt(2)
        _DCT_M = M.astype(np.float32)
    return _DCT_M


def get_key(n_blocks: int):
    return np.random.default_rng(42).choice([-1, 1], size=n_blocks).astype(np.float32)


def make_image(seed: int):
    """生成结构化测试图（渐变+几何形状+轻噪声），避免纯随机噪声导致攻击后 PSNR 过低。"""
    rng = np.random.default_rng(seed)
    img = np.zeros((IMG_SIZE, IMG_SIZE, 3), dtype=np.float32)
    # 双线性渐变背景
    for c in range(3):
        base = np.outer(np.linspace(30 + seed * 3, 220 - seed * 2, IMG_SIZE),
                        np.linspace(0.6 + 0.05 * seed, 1.4 - 0.05 * seed, IMG_SIZE))
        img[:, :, c] = base * (0.5 + 0.25 * c)
    # 几何形状（圆 + 条带）
    yy, xx = np.ogrid[:IMG_SIZE, :IMG_SIZE]
    cx, cy = 8 + (seed * 7) % 16, 8 + (seed * 5) % 16
    circle = (xx - cx) ** 2 + (yy - cy) ** 2 < 36
    img[circle] = [200, 80, 80]
    img[:, IMG_SIZE - 6:] = img[:, IMG_SIZE - 6:] * 0.4
    # 轻噪声
    img += rng.standard_normal(img.shape) * 3
    return np.clip(img, 0, 255).astype(np.uint8)


def _to_y(image):
    return image.astype(np.float32).mean(axis=2)


def embed_watermark(image, alpha: float = ALPHA):
    """参考嵌入：8×8 DCT 中频扩频水印。"""
    img = image.astype(np.float32)
    M = get_dct_matrix()
    y = _to_y(img)
    H, W = y.shape
    key = get_key((H // 8) * (W // 8))
    out = y.copy()
    idx = 0
    for i in range(0, H, 8):
        for j in range(0, W, 8):
            block = y[i:i+8, j:j+8]
            dct = M @ block @ M.T
            dct[3, 2] += alpha * key[idx]
            dct[2, 3] += alpha * key[idx]
            out[i:i+8, j:j+8] = M.T @ dct @ M
            idx += 1
    diff = out - y
    result = img + diff[:, :, None]
    return np.clip(result, 0, 255).astype(np.uint8)


def detect_watermark(image) -> float:
    """参考检测：DCT 中频系数与密钥相关性 -> probability。"""
    img = image.astype(np.float32)
    M = get_dct_matrix()
    y = _to_y(img)
    H, W = y.shape
    key = get_key((H // 8) * (W // 8))
    corrs = []
    idx = 0
    for i in range(0, H, 8):
        for j in range(0, W, 8):
            block = y[i:i+8, j:j+8]
            dct = M @ block @ M.T
            corrs.append(((dct[3, 2] + dct[2, 3]) / 2) * key[idx])
            idx += 1
    corr = float(np.mean(corrs))
    return float(1 / (1 + np.exp(-(corr - 3.0))))


def jpeg_attack(image, quality: int = 75):
    """参考攻击：8×8 DCT 系数量化（简化 JPEG）。"""
    img = image.astype(np.float32)
    M = get_dct_matrix()
    y = _to_y(img)
    H, W = y.shape
    out = y.copy()
    q = max(1.0, (100.0 - quality) / 3.0)  # quality 越低量化步长越大
    for i in range(0, H, 8):
        for j in range(0, W, 8):
            block = y[i:i+8, j:j+8]
            dct = M @ block @ M.T
            dct = np.round(dct / q) * q
            out[i:i+8, j:j+8] = M.T @ dct @ M
    diff = out - y
    result = img + diff[:, :, None]
    return np.clip(result, 0, 255).astype(np.uint8)


def psnr(orig, attacked) -> float:
    o = orig.astype(np.float64)
    a = np.asarray(attacked, dtype=np.float64)
    if o.shape != a.shape or o.size == 0:
        return 0.0
    mse = float(np.mean((o - a) ** 2))
    if mse < 1e-10:
        return 100.0
    return float(10 * np.log10(255 ** 2 / mse))


def roc_auc(pos_scores, neg_scores) -> float:
    if not pos_scores or not neg_scores:
        return 0.5
    correct = 0.0
    for p in pos_scores:
        for n in neg_scores:
            if p > n:
                correct += 1
            elif p == n:
                correct += 0.5
    return correct / (len(pos_scores) * len(neg_scores))


def _valid_image(x) -> bool:
    if x is None:
        return False
    try:
        a = np.asarray(x)
    except Exception:
        return False
    if a.shape != (IMG_SIZE, IMG_SIZE, 3) or a.dtype != np.uint8:
        if a.shape != (IMG_SIZE, IMG_SIZE, 3):
            return False
    if a.size == 0 or np.any(~np.isfinite(a.astype(np.float64))):
        return False
    return True


def _exec_user(code: str, fn_name: str, work_dir: str | None = None):
    if work_dir:
        try:
            return load_user_fn(code, fn_name, work_dir)
        except SolutionValidationError as e:
            raise RuntimeError(format_checks(e.checks))
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    images = [make_image(i) for i in range(N_PAIRS)]

    # ── solo_attack：消除水印，降低 ROC-AUC ──
    if role == "solo_attack":
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(sample) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")

        positives = [embed_watermark(img) for img in images]
        negatives = [img.copy() for img in images]
        pos_scores, neg_scores, fidelities = [], [], []
        valid_count = 0
        log = []
        for i in range(N_PAIRS):
            # 对称攻击：正负样本都过同一 attack
            try:
                out_p = attack_fn({"sample_id": f"POS-{i}", "image": positives[i]})
                att_p = out_p["image"] if isinstance(out_p, dict) and "image" in out_p else positives[i]
            except Exception as e:
                att_p = positives[i]
                log.append({"pair": i, "valid": False, "error": str(e)[:50]})
                pos_scores.append(detect_watermark(positives[i]))
                neg_scores.append(detect_watermark(negatives[i]))
                continue
            try:
                out_n = attack_fn({"sample_id": f"NEG-{i}", "image": negatives[i]})
                att_n = out_n["image"] if isinstance(out_n, dict) and "image" in out_n else negatives[i]
            except Exception:
                att_n = negatives[i]
            snr_p = psnr(positives[i], att_p)
            snr_n = psnr(negatives[i], att_n)
            avg_snr = (snr_p + snr_n) / 2
            valid = snr_p >= ATTACK_PSNR_THRESHOLD and snr_n >= ATTACK_PSNR_THRESHOLD \
                and _valid_image(att_p) and _valid_image(att_n)
            if valid:
                valid_count += 1
                fidelities.append(avg_snr)
                sp = detect_watermark(att_p)
                sn = detect_watermark(att_n)
            else:
                sp = detect_watermark(positives[i])
                sn = detect_watermark(negatives[i])
            pos_scores.append(sp)
            neg_scores.append(sn)
            log.append({"pair": i, "pos_score": round(sp, 3), "neg_score": round(sn, 3),
                        "psnr": round(avg_snr, 1), "valid": valid})

        auc = roc_auc(pos_scores, neg_scores)
        avg_pos = sum(pos_scores) / len(pos_scores) if pos_scores else 1.0
        attack_rate = 1 - avg_pos  # 水印抑制率：攻击后正样本检测分下降程度
        avg_fidelity = sum(fidelities) / len(fidelities) if fidelities else 0
        valid_rate = valid_count / N_PAIRS
        if attack_rate >= 0.5:
            score, win = 100, True
        elif attack_rate >= 0.3:
            score, win = 85, True
        elif attack_rate >= 0.2:
            score, win = 70, True
        elif attack_rate > 0.1:
            score, win = 60, False
        else:
            score, win = 0, False
        msg = (f"水印抑制率={attack_rate*100:.0f}%（攻击后正样本平均检测分 {avg_pos:.2f}），"
               f"ROC-AUC={auc:.2f}，平均 PSNR={avg_fidelity:.1f}dB，有效输出率 {valid_rate*100:.0f}%。"
               f"{'攻击成功，水印被消除' if win else '消除不足'}。")
        return _ok(match_id, role, win, score, N_PAIRS, 0.0, log, msg,
                   extra={"roc_auc": round(auc, 3), "attack_rate": round(attack_rate, 3),
                          "avg_fidelity": round(avg_fidelity, 2), "valid_rate": valid_rate})

    # ── solo_defense：embed + detect，攻击后仍可检测 ──
    if role == "solo_defense":
        try:
            embed_fn = _exec_user(defense_code, "embed", work_dir)
            detect_fn = _exec_user(defense_code, "detect", work_dir)
            if not embed_fn:
                return _err(match_id, "defense 代码缺少 embed(sample) 函数")
            if not detect_fn:
                return _err(match_id, "defense 代码缺少 detect(request) 函数")
        except Exception as e:
            return _err(match_id, f"defense 脚本加载失败: {e}")

        pos_scores, neg_scores, embed_psnrs = [], [], []
        log = []
        for i in range(N_PAIRS):
            # 用户 embed 正样本
            try:
                out = embed_fn({"sample_id": f"POS-{i}", "image": images[i]})
                watermarked = out["image"] if isinstance(out, dict) and "image" in out else images[i]
            except Exception as e:
                watermarked = images[i]
                log.append({"pair": i, "embed_error": str(e)[:50]})
            embed_psnr = psnr(images[i], watermarked)
            embed_psnrs.append(embed_psnr)
            # 参考攻击（对称）
            att_p = jpeg_attack(watermarked, 75)
            att_n = jpeg_attack(images[i], 75)
            # 用户 detect
            try:
                out_p = detect_fn({"image": att_p})
                sp = float(out_p["watermark_probability"]) if isinstance(out_p, dict) and "watermark_probability" in out_p else 0.5
            except Exception:
                sp = 0.5
            try:
                out_n = detect_fn({"image": att_n})
                sn = float(out_n["watermark_probability"]) if isinstance(out_n, dict) and "watermark_probability" in out_n else 0.5
            except Exception:
                sn = 0.5
            sp = max(0.0, min(1.0, sp))
            sn = max(0.0, min(1.0, sn))
            pos_scores.append(sp)
            neg_scores.append(sn)
            log.append({"pair": i, "embed_psnr": round(embed_psnr, 1),
                        "pos_score": round(sp, 3), "neg_score": round(sn, 3)})

        auc = roc_auc(pos_scores, neg_scores)
        avg_embed_psnr = sum(embed_psnrs) / len(embed_psnrs) if embed_psnrs else 0
        fbr = sum(1 for s in neg_scores if s > 0.5) / N_PAIRS
        if auc >= 0.9 and avg_embed_psnr >= EMBED_PSNR_THRESHOLD:
            score, win = 100, True
        elif auc >= 0.8:
            score, win = 85, True
        elif auc >= 0.7:
            score, win = 70, True
        else:
            score, win = 0, False
        msg = (f"ROC-AUC={auc:.2f}，嵌入 PSNR={avg_embed_psnr:.1f}dB，FBR={fbr*100:.0f}%。"
               f"{'检测成功，水印鲁棒' if win else '检测不足'}。")
        return _ok(match_id, role, win, score, N_PAIRS, fbr, log, msg,
                   extra={"roc_auc": round(auc, 3), "attack_rate": round(auc, 3),
                          "avg_fidelity": round(avg_embed_psnr, 2), "valid_rate": 1.0})

    return _err(match_id, f"未知 role: {role}")


def _ok(match_id, role, win, score, queries, fbr, log, msg, extra=None):
    details = {"win": win, "status": "passed" if win else "failed", "score": score,
               "queries_used": queries, "fbr": fbr, "interaction_log": log}
    if extra:
        details.update(extra)
    return {"id": match_id, "status": "passed", "score": score,
            "result": {"message": msg, "details": details}}


def _err(match_id, msg):
    return {"id": match_id, "status": "error", "score": None,
            "result": {"message": msg,
                       "details": {"win": False, "status": "error", "score": None,
                                   "queries_used": 0, "fbr": 0, "roc_auc": 0.5,
                                   "attack_rate": 0, "avg_fidelity": 0, "valid_rate": 0,
                                   "interaction_log": []}}}


if __name__ == "__main__":
    try:
        raw = sys.stdin.read()
        inp = json.loads(raw)
        result = run_match(
            role=inp.get("role", "solo_attack"),
            attack_code=inp.get("attackCode", ""),
            defense_code=inp.get("defenseCode", ""),
            work_dir=inp.get("workDir"),
        )
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            "id": "error", "status": "error", "score": None,
            "result": {"message": f"引擎错误: {e}\n{traceback.format_exc()}",
                       "details": {"win": False, "status": "error", "score": None,
                                   "queries_used": 0, "fbr": 0, "roc_auc": 0.5,
                                   "attack_rate": 0, "avg_fidelity": 0, "valid_rate": 0,
                                   "interaction_log": []}},
        }, ensure_ascii=False))
