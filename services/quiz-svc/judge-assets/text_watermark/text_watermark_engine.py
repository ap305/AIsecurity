#!/usr/bin/env python3
"""大语言模型文本水印攻防仿真引擎（确定性，无真实 LLM）。

scenario: text_watermark

契约（与图片水印对齐：embed + detect 防御，attack 攻击）：
- 攻击  def attack(env, task) -> dict
    task["watermarked_text"] str（含水印的文本）
    返回 {"text": str}（去水印，保持语义相似度 ≥ 0.85）
- 防御  def embed(sample) -> dict + def detect(request) -> dict
    embed:  sample["text"] -> {"text": 水印文本}
    detect: request["text"] -> {"watermark_probability": 0.0~1.0}

仿真（绿名单水印，类 Kirchenbauer）：
- 同义词对 (green, red)：embed 把 red 词替换为 green 词；detect 统计 green 词占比。
- 攻击把 green 词换回 red 同义词 -> 降低 green 占比，语义不变（相似度高）。
- 评分：AUC（检测区分度）/ ASR（去水印成功）/ SemanticSim（语义保持）。
"""

import sys
import json
import uuid
import traceback
from typing import Any

import os as _os
_COMMON_DIR = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "..", "_common")
if _COMMON_DIR not in sys.path:
    sys.path.insert(0, _COMMON_DIR)
from solution_loader import load_user_fn, SolutionValidationError, format_checks  # noqa: E402
from gateway import gateway_from_stdin  # noqa: E402

# 同义词对：(green=水印变体, red=普通变体)。embed: red->green；detect: 统计 green 占比。
SYNONYMS = [
    ("quick", "fast"), ("brown", "dark"), ("fox", "vixen"), ("jumps", "leaps"),
    ("over", "across"), ("lazy", "idle"), ("dog", "hound"), ("near", "beside"),
    ("river", "stream"), ("bank", "shore"), ("the", "the"), ("a", "a"),
    ("runs", "sprints"), ("forest", "woods"), ("morning", "dawn"), ("slow", "sluggish"),
]
GREEN = {g for g, _ in SYNONYMS}
RED = {r for _, r in SYNONYMS}
# 词 -> 同义词对索引（canonical）
WORD2PAIR = {}
for i, (g, r) in enumerate(SYNONYMS):
    WORD2PAIR[g] = i
    WORD2PAIR[r] = i

# 基础文本（用 red 普通词，便于 embed 替换为 green）
BASE_TEXTS = [
    "the fast dark vixen leaps across the idle hound beside the stream shore",
    "a sluggish hound sprints beside the dark woods near the dawn",
    "the fast fox leaps across the stream near the dark woods",
]


def _words(text: str) -> list[str]:
    return [w.lower() for w in text.split()]


def green_ratio(text: str) -> float:
    """绿名单词占同义词词数的比例（水印信号强度）。"""
    ws = _words(text)
    total = sum(1 for w in ws if w in WORD2PAIR)
    if total == 0:
        return 0.0
    green = sum(1 for w in ws if w in GREEN)
    return green / total


def detect_prob(text: str) -> float:
    """检测器：green_ratio -> watermark_probability。"""
    r = green_ratio(text)
    # ratio 1.0 -> prob 高；0 -> prob 低
    score = r * 8.0 - 3.0
    return float(1 / (1 + __import__("math").exp(-score)))


def semantic_sim(t1: str, t2: str) -> float:
    """词级语义相似度：同义词（同 pair）视为匹配。"""
    w1 = [WORD2PAIR.get(w, w) for w in _words(t1)]
    w2 = [WORD2PAIR.get(w, w) for w in _words(t2)]
    if not w1 or not w2:
        return 0.0
    # 序列相似度（基于同义词归一化后的 LCS 比例）
    n, m = len(w1), len(w2)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = dp[i - 1][j - 1] + 1 if w1[i - 1] == w2[j - 1] else max(dp[i - 1][j], dp[i][j - 1])
    lcs = dp[n][m]
    return lcs / max(n, m)


def _generate_text(llm, i: int) -> str:
    """基础生成文本。

    - llm 为 None（mock）：返回固定 BASE_TEXTS[i]（仿真）。
    - llm 为 LLMClient（proxy）：提示 LLM 用同义词表中的词生成句子，
      保证 embed（red->green）与 detect（green 占比）可作用于真实生成文本。
    """
    if llm is not None:
        try:
            red_words = ", ".join(sorted({r for _, r in SYNONYMS if r != "the" and r != "a"}))
            prompt = (f"Write one short sentence using these words: {red_words}. "
                      f"Use exactly those words.")
            return llm.chat_text([{"role": "user", "content": prompt}])
        except Exception:
            pass
    return BASE_TEXTS[i % len(BASE_TEXTS)]


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


def run_match(role: str, attack_code: str, defense_code: str, work_dir: str | None = None, llm=None) -> dict:
    match_id = str(uuid.uuid4())[:8]

    if role == "solo_attack":
        # 用户攻击 vs 参考水印（embed 全替换为 green）+ 参考检测器
        try:
            attack_fn = _exec_user(attack_code, "attack", work_dir)
            if not attack_fn:
                return _err(match_id, "attack 代码缺少 attack(env, task) 函数")
        except Exception as e:
            return _err(match_id, f"attack 脚本加载失败: {e}")

        successes = 0
        sims = []
        log = []
        for i in range(len(BASE_TEXTS)):
            base = _generate_text(llm, i)
            # 参考水印：red -> green
            wm = base
            for g, r in SYNONYMS:
                wm = wm.replace(r, g)
            try:
                out = attack_fn(None, {"sample_id": f"TW-{i:03d}", "watermarked_text": wm, "language": "en"})
                atk = out["text"] if isinstance(out, dict) else out
            except Exception as e:
                log.append({"sample": i, "error": str(e)})
                continue
            if not isinstance(atk, str) or len(atk.strip()) < 3:
                continue
            prob = detect_prob(atk)
            sim = semantic_sim(wm, atk)
            sims.append(sim)
            # 攻击成功：检测器判为非水印(prob<0.5) 且 语义保持(sim≥0.85)
            if prob < 0.5 and sim >= 0.85:
                successes += 1
            log.append({"sample": i, "detect_prob": round(prob, 3), "sim": round(sim, 3)})
        asr = successes / len(BASE_TEXTS)
        avg_sim = sum(sims) / len(sims) if sims else 0.0
        score = int(asr * 50 + avg_sim * 50)  # ASR 50% + 文本保持 50%
        if asr >= 0.66 and avg_sim >= 0.85:
            score = max(score, 100)
        elif asr >= 0.33:
            score = max(score, 70)
        win = asr >= 0.33 and avg_sim >= 0.85
        return {
            "id": match_id, "status": "passed", "score": score,
            "result": {
                "message": f"ASR={int(asr*100)}%（{successes}/{len(BASE_TEXTS)} 去水印成功），"
                           f"平均语义相似度={avg_sim:.2f}。"
                           + ("攻击成功，水印被有效去除且语义保持。" if win else "攻击未达去水印效果或语义损失过大。"),
                "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                            "queries_used": 0, "fbr": 0, "interaction_log": log,
                            "attack_rate": asr, "avg_fidelity": avg_sim, "valid_rate": 1.0},
            },
        }

    # solo_defense：用户 embed + detect，攻击用参考去水印（green->red）
    try:
        embed_fn = _exec_user(defense_code, "embed", work_dir)
        detect_fn = _exec_user(defense_code, "detect", work_dir)
        if not embed_fn or not detect_fn:
            return _err(match_id, "defend 代码缺少 embed(sample) 与 detect(request) 函数")
    except Exception as e:
        return _err(match_id, f"defend 脚本加载失败: {e}")

    # 1) 检测区分度：水印文本 prob 高，非水印文本 prob 低
    wm_high = 0
    nw_low = 0
    for i in range(len(BASE_TEXTS)):
        base = _generate_text(llm, i)
        try:
            we = embed_fn({"text": base})
            wm_text = we["text"] if isinstance(we, dict) else we
            if detect_prob(wm_text) >= 0.5 or (detect_fn({"text": wm_text}) or {}).get("watermark_probability", 0) >= 0.5:
                wm_high += 1
            if (detect_fn({"text": base}) or {}).get("watermark_probability", 0) < 0.5:
                nw_low += 1
        except Exception:
            pass
    detect_acc = (wm_high + nw_low) / (2 * len(BASE_TEXTS))

    # 2) 鲁棒性：参考攻击（green->red）后，用户检测器应判为非水印（攻击成功=防御失败）
    robust_fail = 0
    for i in range(len(BASE_TEXTS)):
        base = _generate_text(llm, i)
        try:
            we = embed_fn({"text": base})
            wm_text = we["text"] if isinstance(we, dict) else we
            # 参考去水印：green -> red
            atk = wm_text
            for g, r in SYNONYMS:
                atk = atk.replace(g, r)
            prob = (detect_fn({"text": atk}) or {}).get("watermark_probability", 0)
            if prob < 0.5:
                robust_fail += 1  # 检测器被攻破
        except Exception:
            pass
    robust_rate = 1 - robust_fail / len(BASE_TEXTS)  # 防御保持检测的比例

    # 3) 文本质量保持：embed 后语义相似度
    quals = []
    for i in range(len(BASE_TEXTS)):
        base = _generate_text(llm, i)
        try:
            we = embed_fn({"text": base})
            wm_text = we["text"] if isinstance(we, dict) else we
            quals.append(semantic_sim(base, wm_text))
        except Exception:
            quals.append(0.0)
    quality = sum(quals) / len(quals) if quals else 0.0

    defense_score = 0.5 * detect_acc + 0.3 * robust_rate + 0.2 * quality
    if defense_score >= 0.85:
        score = 100
    elif defense_score >= 0.70:
        score = 85
    elif defense_score >= 0.50:
        score = 70
    else:
        score = 0
    win = defense_score >= 0.50
    return {
        "id": match_id, "status": "passed", "score": score,
        "result": {
            "message": f"检测区分度={detect_acc*100:.0f}%，鲁棒保持={robust_rate*100:.0f}%，"
                       f"文本质量={quality:.2f}，DefenseScore={defense_score:.2f}。"
                       + ("防御成功，水印可检测且鲁棒。" if win else "防御能力不足。"),
            "details": {"win": win, "status": "passed" if win else "failed", "score": score,
                        "queries_used": 0, "fbr": robust_fail / len(BASE_TEXTS), "interaction_log": [],
                        "attack_rate": defense_score, "avg_fidelity": quality, "valid_rate": detect_acc},
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
            llm=gateway_from_stdin(inp),
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
