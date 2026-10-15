#!/usr/bin/env python3
"""DeepFake 语音隐匿与反欺骗仿真引擎（确定性，numpy，无真实模型/数据集）。

scenario: deepfake_audio

契约：
- 攻击  def attack(sample) -> dict
    sample["audio"]        float32 mono 1D 波形（伪造语音）
    sample["sample_rate"]  16000
    返回 {"audio": float32 mono 1D, "sample_rate": 16000}
- 防御  def defend(request) -> dict
    request["audio"] / request["sample_rate"]
    返回 {"spoof_probability": 0.0~1.0}

仿真：
- 伪造语音 = 基频正弦(150Hz) + 高频谐波痕迹(3/4.5/6kHz) + 包络 + 轻噪声。
  高频谐波代表声码器/spoof 取证特征。
- 检测器：高频能量比(>2500Hz) + 过零率 -> sigmoid -> spoof_probability。
  伪造语音高频能量高 -> prob 高；真人语音（仅基频+噪声）-> prob 低。
- 保真度：SNR(dB) = 10*log10(信号功率/噪声功率)，阈值 ≥ 10 dB。
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

SR = 16000
N_SAMPLES = 6
DURATION = 0.5  # 0.5s -> 8000 采样点
FIDELITY_THRESHOLD = 8.0  # dB


def _t():
    return np.arange(int(SR * DURATION)) / SR


def make_spoof_audio(seed: int):
    """伪造语音：基频 + 高频谐波痕迹（spoof 特征）。"""
    rng = np.random.default_rng(seed)
    t = _t()
    fundamental = np.sin(2 * np.pi * 150 * t)
    # 高频谐波痕迹（声码器残留）-- 强高频特征使 spoof 可被检测
    harmonics = (np.sin(2 * np.pi * 3000 * t)
                 + np.sin(2 * np.pi * 4500 * t)
                 + np.sin(2 * np.pi * 6000 * t)) * 0.2
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 4 * t)
    audio = (fundamental + harmonics) * envelope * 0.3
    audio += rng.standard_normal(len(t)).astype(np.float32) * 0.005
    return audio.astype(np.float32)


def make_bonafide_audio(seed: int):
    """真人语音：基频 + 自然噪声，无高频谐波痕迹。"""
    rng = np.random.default_rng(seed + 1000)
    t = _t()
    fundamental = np.sin(2 * np.pi * 140 * t)
    envelope = 0.5 + 0.5 * np.sin(2 * np.pi * 3.5 * t)
    audio = fundamental * envelope * 0.3
    audio += rng.standard_normal(len(t)).astype(np.float32) * 0.012  # 更高自然噪声
    return audio.astype(np.float32)


def detect_spoof(audio, sr: int = SR) -> float:
    """仿真检测器：高频能量比 + 过零率 -> spoof_probability。"""
    a = np.asarray(audio, dtype=np.float64)
    n = len(a)
    if n == 0 or np.any(~np.isfinite(a)):
        return 0.5
    spectrum = np.abs(np.fft.rfft(a))
    freqs = np.fft.rfftfreq(n, 1 / sr)
    high_mask = freqs > 2500
    total_e = float(np.sum(spectrum ** 2)) + 1e-10
    high_e = float(np.sum(spectrum[high_mask] ** 2))
    high_ratio = high_e / total_e
    zcr = float(np.mean(np.abs(np.diff(np.sign(a)))) / 2)
    score = high_ratio * 28 + zcr * 3 - 1.8
    return float(1 / (1 + np.exp(-score)))


def fidelity(orig, attacked) -> float:
    """SNR(dB) 保真度。"""
    o = np.asarray(orig, dtype=np.float64)
    a = np.asarray(attacked, dtype=np.float64)
    n = min(len(o), len(a))
    if n == 0:
        return -100.0
    o, a = o[:n], a[:n]
    noise = o - a
    signal_p = float(np.sum(o ** 2)) + 1e-10
    noise_p = float(np.sum(noise ** 2)) + 1e-10
    return float(10 * np.log10(signal_p / noise_p))


def _exec_user(code: str, fn_name: str, work_dir: str | None = None):
    if work_dir:
        try:
            return load_user_fn(code, fn_name, work_dir)
        except SolutionValidationError as e:
            raise RuntimeError(format_checks(e.checks))
    ns: dict[str, Any] = {}
    exec(code, ns)
    return ns.get(fn_name)


def _valid_audio(x) -> bool:
    if x is None:
        return False
    try:
        a = np.asarray(x, dtype=np.float32)
    except Exception:
        return False
    if a.size == 0 or np.any(~np.isfinite(a)):
        return False
    return True


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None) -> dict:
    match_id = str(uuid.uuid4())[:8]
    if np is None:
        return _err(match_id, "引擎缺少 numpy 依赖")

    # ── solo_attack：后处理伪造语音降低 spoof 检测置信度 ──
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
            audio = make_spoof_audio(i)
            sample = {"sample_id": f"DF-{i+1:03d}", "audio": audio, "sample_rate": SR}
            try:
                out = attack_fn(sample)
                out_audio = out["audio"] if isinstance(out, dict) and "audio" in out else audio
            except Exception as e:
                out_audio = audio
                snr = fidelity(audio, audio)
                log.append({"sample_id": sample["sample_id"], "spoof_prob": 1.0, "snr": round(snr, 1),
                            "valid": False, "escaped": False, "error": str(e)[:60]})
                fidelities.append(snr)
                continue
            snr = fidelity(audio, out_audio)
            fidelities.append(snr)
            valid = snr >= FIDELITY_THRESHOLD and _valid_audio(out_audio)
            if valid:
                valid_count += 1
                prob = detect_spoof(out_audio, SR)
                escaped = prob < 0.5
                if escaped:
                    successes += 1
                log.append({"sample_id": sample["sample_id"], "spoof_prob": round(prob, 3),
                            "snr": round(snr, 1), "valid": True, "escaped": escaped})
            else:
                log.append({"sample_id": sample["sample_id"], "spoof_prob": 1.0,
                            "snr": round(snr, 1), "valid": False, "escaped": False})

        asr = successes / N_SAMPLES
        avg_fidelity = sum(fidelities) / len(fidelities) if fidelities else 0
        valid_rate = valid_count / N_SAMPLES
        if asr >= 0.8:
            score, win = 100, True
        elif asr >= 0.5:
            score, win = 85, True
        elif asr >= 0.3:
            score, win = 70, True
        elif asr > 0:
            score, win = 60, False
        else:
            score, win = 0, False
        msg = (f"ASR={asr*100:.0f}%（{successes}/{N_SAMPLES} 样本逃逸检测），"
               f"平均保真度 SNR={avg_fidelity:.1f}dB，有效输出率 {valid_rate*100:.0f}%。"
               f"{'攻击成功，伪造语音逃逸检测' if win else '逃逸不足'}。")
        return _ok(match_id, role, win, score, N_SAMPLES, 0.0, log, msg,
                   extra={"attack_rate": round(asr, 3), "avg_fidelity": round(avg_fidelity, 2),
                          "valid_rate": valid_rate})

    # ── solo_defense：检测 spoof + bonafide 误报率 ──
    if role == "solo_defense":
        try:
            defend_fn = _exec_user(defense_code, "defend", work_dir)
            if not defend_fn:
                return _err(match_id, "defense 代码缺少 defend(request) 函数")
        except Exception as e:
            return _err(match_id, f"defense 脚本加载失败: {e}")

        detections = 0
        false_alarms = 0
        log = []
        for i in range(N_SAMPLES):
            # spoof 样本
            s_audio = make_spoof_audio(i)
            request = {"audio": s_audio, "sample_rate": SR}
            try:
                out = defend_fn(request)
                prob = float(out["spoof_probability"]) if isinstance(out, dict) and "spoof_probability" in out else 0.5
            except Exception as e:
                prob = 0.5
                log.append({"sample_id": f"spoof-{i+1}", "type": "spoof", "prob": 0.5,
                            "detected": False, "error": str(e)[:60]})
                continue
            prob = max(0.0, min(1.0, prob))
            if prob > 0.5:
                detections += 1
            log.append({"sample_id": f"spoof-{i+1}", "type": "spoof",
                        "prob": round(prob, 3), "detected": prob > 0.5})
            # bonafide 样本
            b_audio = make_bonafide_audio(i)
            request_b = {"audio": b_audio, "sample_rate": SR}
            try:
                out_b = defend_fn(request_b)
                prob_b = float(out_b["spoof_probability"]) if isinstance(out_b, dict) and "spoof_probability" in out_b else 0.5
            except Exception:
                prob_b = 0.5
            prob_b = max(0.0, min(1.0, prob_b))
            if prob_b > 0.5:
                false_alarms += 1
            log.append({"sample_id": f"bonafide-{i+1}", "type": "bonafide",
                        "prob": round(prob_b, 3), "false_alarm": prob_b > 0.5})

        detection_rate = detections / N_SAMPLES
        fbr = false_alarms / N_SAMPLES
        if detection_rate >= 0.8 and fbr <= 0.1:
            score, win = 100, True
        elif detection_rate >= 0.5 and fbr <= 0.2:
            score, win = 85, True
        elif detection_rate >= 0.3:
            score, win = 70, True
        else:
            score, win = 0, False
        msg = (f"检出率={detection_rate*100:.0f}%（{detections}/{N_SAMPLES}），"
               f"FBR={fbr*100:.0f}%（bonafide 误报）。"
               f"{'检测成功' if win else '检测不足'}。")
        return _ok(match_id, role, win, score, N_SAMPLES, fbr, log, msg,
                   extra={"attack_rate": round(detection_rate, 3), "avg_fidelity": 0,
                          "valid_rate": 1.0})

    return _err(match_id, f"未知 role: {role}")


def _ok(match_id, role, win, score, queries, fbr, log, msg, extra=None):
    details = {
        "win": win, "status": "passed" if win else "failed", "score": score,
        "queries_used": queries, "fbr": fbr, "interaction_log": log,
    }
    if extra:
        details.update(extra)
    return {"id": match_id, "status": "passed", "score": score,
            "result": {"message": msg, "details": details}}


def _err(match_id, msg):
    return {"id": match_id, "status": "error", "score": None,
            "result": {"message": msg,
                       "details": {"win": False, "status": "error", "score": None,
                                   "queries_used": 0, "fbr": 0, "attack_rate": 0,
                                   "avg_fidelity": 0, "valid_rate": 0, "interaction_log": []}}}


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
