#!/usr/bin/env python3
"""DeepFake 图像痕迹隐匿与鲁棒检测仿真引擎（确定性，numpy，无真实数据集）。

scenario: deepfake_image

契约：
- 攻击  def attack(sample) -> dict
    sample["image"]  RGB uint8 H×W×3（伪造图像）
    返回 {"image": RGB uint8 H×W×3}
- 防御  def defend(request) -> dict
    request["image"] RGB uint8 H×W×3
    返回 {"fake_probability": 0.0~1.0}

仿真：
- 伪造图像 = 平滑渐变 + 高频棋盘格/纹理痕迹（融合边界取证特征）。
- 检测器：高频能量比(FFT) -> sigmoid -> fake_probability。伪造图像高频能量高 -> prob 高。
- 攻击做 JPEG 量化/模糊/缩放削弱高频痕迹，降低 prob；保真度用 PSNR，阈值 ≥ 28 dB。
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

IMG = 32
N_SAMPLES = 6
FIDELITY_THRESHOLD = 24.0  # dB（教学简化仿真阈值，与 deepfake_audio 一致）


def _make_fake(seed: int):
    """伪造图像：基础渐变 + 强周期 2 棋盘格（高频融合痕迹，可被频域检测器检出）。"""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:IMG, 0:IMG].astype(np.float32)
    base = 120 + (xx - yy) / IMG * 30  # 轻微渐变（低频）
    checker = (((xx + yy) % 2) * 28.0 - 14.0)  # ±14 周期2棋盘格（高频，可被频域检测器检出）
    img = np.stack([base + checker, base + checker * 0.8, base + checker * 0.6], axis=-1)
    img += rng.standard_normal((IMG, IMG, 3)).astype(np.float32) * 2
    return np.clip(img, 0, 255).astype(np.uint8)


def _make_real(seed: int):
    """真实图像：仅平滑渐变 + 自然噪声，无高频棋盘格。"""
    rng = np.random.default_rng(seed + 1000)
    yy, xx = np.mgrid[0:IMG, 0:IMG].astype(np.float32)
    base = 110 + (xx * 0.6 + yy * 0.4) / IMG * 40
    img = np.stack([base, base + 6, base + 12], axis=-1)
    img += rng.standard_normal((IMG, IMG, 3)).astype(np.float32) * 5
    return np.clip(img, 0, 255).astype(np.uint8)


def detect_fake(img) -> float:
    """仿真检测器：高频能量占 AC 能量比 -> fake_probability（排除 DC 分量）。"""
    a = np.asarray(img, dtype=np.float64)
    if a.size == 0 or np.any(~np.isfinite(a)):
        return 0.5
    gray = a.mean(axis=-1) if a.ndim == 3 else a
    spec = np.abs(np.fft.fft2(gray))
    n = gray.shape[0]
    f = np.fft.fftfreq(n)
    fx, fy = np.meshgrid(f, f)
    mag = np.abs(fx) + np.abs(fy)
    dc_e = float(spec[0, 0] ** 2)
    ac_e = float(np.sum(spec ** 2)) - dc_e + 1e-10
    high_e = float(np.sum(spec[mag > 0.25] ** 2))
    high_ratio = high_e / ac_e
    # 伪造：high_ratio ~0.4+ -> prob 高；真实：~0.1 -> prob 低
    score = high_ratio * 14.0 - 3.2
    return float(1 / (1 + np.exp(-score)))


def psnr(orig, attacked) -> float:
    o = np.asarray(orig, dtype=np.float64)
    a = np.asarray(attacked, dtype=np.float64)
    if o.shape != a.shape:
        return 0.0
    mse = float(np.mean((o - a) ** 2))
    if mse <= 1e-10:
        return 99.0
    return 10 * np.log10((255.0 ** 2) / mse)


def _exec_user(code: str, fn_name: str, work_dir: str | None = None):
    if work_dir:
        try:
            return load_user_fn(code, fn_name, work_dir)
        except SolutionValidationError as e:
            raise RuntimeError(format_checks(e.checks))
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


def _err(match_id, msg):
    return {
        "id": match_id, "status": "error", "score": None,
        "result": {"message": msg,
                   "details": {"win": False, "status": "error", "score": None,
                               "queries_used": 0, "fbr": 0, "interaction_log": [],
                               "attack_rate": 0, "avg_fidelity": 0, "valid_rate": 0}},
    }


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    if role == "solo_attack":
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(sample) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")

        successes = 0
        valid_count = 0
        fidelities = []
        log = []
        for i in range(N_SAMPLES):
            img = _make_fake(i)
            try:
                out = attack_fn({"image": img})
                aimg = np.asarray(out["image"]) if isinstance(out, dict) else None
            except Exception as e:
                log.append({"sample": i, "error": str(e)})
                continue
            if aimg is None or aimg.shape != img.shape or aimg.dtype != np.uint8:
                if aimg is not None:
                    aimg = np.clip(np.asarray(aimg), 0, 255).astype(np.uint8)
                if aimg is None or aimg.shape != img.shape:
                    continue
            valid_count += 1
            fid = psnr(img, aimg)
            fidelities.append(fid)
            if fid >= FIDELITY_THRESHOLD:
                prob = detect_fake(aimg)
                if prob < 0.5:
                    successes += 1
                log.append({"sample": i, "psnr": round(fid, 1), "fake_prob": round(prob, 3)})
        asr = successes / N_SAMPLES
        valid_rate = valid_count / N_SAMPLES
        avg_fid = float(np.mean(fidelities)) if fidelities else 0.0
        if asr >= 0.80 and valid_rate >= 0.8:
            score = 100
        elif asr >= 0.50 and valid_rate >= 0.8:
            score = 85
        elif asr >= 0.30 and valid_rate >= 0.8:
            score = 70
        elif asr > 0:
            score = 60
        else:
            score = 0
        win = asr > 0 and valid_rate >= 0.8
        return {
            "id": match_id, "status": "passed", "score": score,
            "result": {
                "message": f"ASR={int(asr*100)}%（{successes}/{N_SAMPLES} 隐匿成功），平均保真度 PSNR={avg_fid:.1f}dB，有效率 {int(valid_rate*100)}%。"
                           + ("攻击成功，伪造图像逃逸检测。" if win else "攻击未达有效隐匿。"),
                "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                            "queries_used": 0, "fbr": 0, "interaction_log": log,
                            "attack_rate": asr, "avg_fidelity": avg_fid, "valid_rate": valid_rate},
            },
        }

    # solo_defense
    try:
        defend_fn = _exec_user(defense_code, "defend", work_dir)
        if not defend_fn:
            return _err(match_id, "defend 代码缺少 defend(request) 函数")
    except Exception as e:
        return _err(match_id, f"defend 脚本加载失败: {e}")

    # 检出率（伪造图像 prob 高）
    detect_hits = 0
    for i in range(N_SAMPLES):
        try:
            r = defend_fn({"image": _make_fake(i)})
            if r.get("fake_probability", 0) >= 0.5:
                detect_hits += 1
        except Exception:
            pass
    detect_rate = detect_hits / N_SAMPLES
    # 误报率（真实图像 prob 低）
    fp = 0
    for i in range(N_SAMPLES):
        try:
            r = defend_fn({"image": _make_real(i)})
            if r.get("fake_probability", 0) >= 0.5:
                fp += 1
        except Exception:
            pass
    fbr = fp / N_SAMPLES
    if detect_rate >= 0.80 and fbr <= 0.10:
        score = 100
    elif detect_rate >= 0.50 and fbr <= 0.20:
        score = 85
    elif detect_rate >= 0.30:
        score = 70
    else:
        score = 0
    win = detect_rate >= 0.5 and fbr <= 0.20
    return {
        "id": match_id, "status": "passed", "score": score,
        "result": {
            "message": f"检出率={int(detect_rate*100)}%（{detect_hits}/{N_SAMPLES}），FBR={int(fbr*100)}%（bonafide 误报）。"
                       + ("防御成功，有效检测伪造图像。" if win else "检测能力不足。"),
            "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                        "queries_used": 0, "fbr": fbr, "interaction_log": [],
                        "attack_rate": detect_rate, "avg_fidelity": 0, "valid_rate": 1 - fbr},
        },
    }


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
                                   "queries_used": 0, "fbr": 0, "attack_rate": 0,
                                   "avg_fidelity": 0, "valid_rate": 0, "interaction_log": []}},
        }, ensure_ascii=False))
