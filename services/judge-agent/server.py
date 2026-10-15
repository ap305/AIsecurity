"""
Flask API server for Agent Attack-Defense judging.

Endpoints:
    POST /api/matches/run       — Execute one round of attack/defense
    GET  /api/matches/<id>      — Query match result
    POST /api/submissions       — Submit from Question page (agent questions)
    GET  /api/submissions/<id>  — Query submission result
    GET  /api/health            — Health check
    GET  /api/questions/<id>    — Question detail (optional, fallback)
"""

import json
import os
import sys
import uuid
import threading
import urllib.request
import urllib.error
from datetime import datetime, timezone

from flask import Flask, request, jsonify, Response
from flask_cors import CORS

# Ensure judge-agent modules are importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from runner import run_attack, run_defense, run_solo_attack, run_solo_defense

app = Flask(__name__)
CORS(app)

PORT = int(os.environ.get("PORT", 4003))

# ── In-memory storage ───────────────────────────────────────────────────────

matches: dict[str, dict] = {}
submissions: dict[str, dict] = {}
_store_lock = threading.Lock()


# ── Helpers ──────────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Health ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return jsonify({
        "code": 0,
        "message": "ok",
        "data": {"service": "judge-agent", "status": "healthy"},
    })


# ── Match endpoints ──────────────────────────────────────────────────────────

@app.post("/api/matches/run")
def match_run():
    """
    Execute one round of attack/defense.

    Request body:
        {
            "attackCode": str,        # attacker's Python code
            "defenseCode": str | null, # defender's Python code (optional)
            "role": "attack" | "defense" | "both" | "solo_attack" | "solo_defense",
            "attacker_iban": str | null  # optional, generated if not provided
        }

    Response:
        {
            "code": 0,
            "message": "ok",
            "data": {
                "id": str,
                "status": "passed" | "failed" | "error",
                "score": number | null,
                "result": {
                    "message": str,
                    "details": { win, queries_used?, fbr?, interaction_log, ... }
                },
                "createdAt": str
            }
        }
    """
    body = request.get_json(silent=True) or {}

    attack_code = (body.get("attackCode") or "").strip()
    defense_code = (body.get("defenseCode") or "").strip()
    role = body.get("role", "solo_attack")
    attacker_iban = body.get("attacker_iban") or _generate_iban()

    if not attack_code and role in ("attack", "solo_attack", "both"):
        return jsonify({
            "code": 1,
            "message": "attackCode is required for this role",
            "data": None,
        }), 400

    match_id = str(uuid.uuid4())[:8]

    try:
        if role == "attack" or role == "solo_attack":
            result = run_attack(attack_code, attacker_iban)
        elif role == "defense" or role == "solo_defense":
            result = run_defense(defense_code or attack_code, attacker_iban)
        elif role == "both":
            # Run attack, then check if defense would have blocked
            attack_result = run_attack(attack_code, attacker_iban)
            defense_result = run_defense(defense_code, attacker_iban)
            result = {
                "attack": attack_result,
                "defense": defense_result,
                "win": attack_result.get("win", False),
                "interaction_log": attack_result.get("interaction_log", []),
            }
        else:
            return jsonify({
                "code": 1,
                "message": f"Invalid role: {role}",
                "data": None,
            }), 400

        status = "error" if "error" in result else ("passed" if result.get("win") else "failed")
        score = _calculate_score(result, role)

        match_data = {
            "id": match_id,
            "status": status,
            "score": score,
            "result": {
                "message": _result_message(result, role),
                "details": result,
            },
            "createdAt": _now_iso(),
        }

        with _store_lock:
            matches[match_id] = match_data

        return jsonify({"code": 0, "message": "ok", "data": match_data})

    except Exception as e:
        match_data = {
            "id": match_id,
            "status": "error",
            "score": None,
            "result": {
                "message": f"Server error: {type(e).__name__}: {e}",
                "details": {"error": str(e)},
            },
            "createdAt": _now_iso(),
        }
        with _store_lock:
            matches[match_id] = match_data

        return jsonify({"code": 0, "message": "ok", "data": match_data})


@app.get("/api/matches/<match_id>")
def match_get(match_id: str):
    """Query match result by ID."""
    with _store_lock:
        data = matches.get(match_id)

    if not data:
        return jsonify({"code": 1, "message": "Match not found", "data": None}), 404

    return jsonify({"code": 0, "message": "ok", "data": data})


# ── Submission endpoints (for Question page) ─────────────────────────────────

@app.post("/api/submissions")
def submission_create():
    """
    Create a submission for an agent attack/defense question.

    Request body (JSON):
        {
            "questionId": str,
            "code": str,
            "userId": str,
            "mode": "attack" | "defense"
        }

    Response: { "code": 0, "message": "ok", "data": { "id": str, "status": str } }
    """
    body = request.get_json(silent=True) or {}

    question_id = body.get("questionId", "")
    code = (body.get("code") or "").strip()
    user_id = body.get("userId", "anonymous")
    mode = body.get("mode", "attack")

    if not code:
        return jsonify({"code": 1, "message": "code is required", "data": None}), 400

    sub_id = str(uuid.uuid4())[:8]
    attacker_iban = _generate_iban()

    try:
        if mode == "attack":
            result = run_attack(code, attacker_iban)
        else:
            result = run_defense(code, attacker_iban)

        status = "error" if "error" in result else ("passed" if result.get("win") else "failed")
        score = _calculate_score(result, mode)

        sub_data = {
            "id": sub_id,
            "questionId": question_id,
            "userId": user_id,
            "status": status,
            "score": score,
            "result": {
                "message": _result_message(result, mode),
                "details": result,
            },
            "createdAt": _now_iso(),
        }

        with _store_lock:
            submissions[sub_id] = sub_data

        return jsonify({"code": 0, "message": "ok", "data": sub_data})

    except Exception as e:
        sub_data = {
            "id": sub_id,
            "questionId": question_id,
            "userId": user_id,
            "status": "error",
            "score": None,
            "result": {
                "message": f"Server error: {type(e).__name__}: {e}",
                "details": {"error": str(e)},
            },
            "createdAt": _now_iso(),
        }
        with _store_lock:
            submissions[sub_id] = sub_data

        return jsonify({"code": 0, "message": "ok", "data": sub_data})


@app.get("/api/submissions/<sub_id>")
def submission_get(sub_id: str):
    """Query submission result by ID."""
    with _store_lock:
        data = submissions.get(sub_id)

    if not data:
        return jsonify({"code": 1, "message": "Submission not found", "data": None}), 404

    return jsonify({"code": 0, "message": "ok", "data": data})


# ── Question detail (optional) ───────────────────────────────────────────────

@app.get("/api/questions/<question_id>")
def question_detail(question_id: str):
    """Return question detail. This is a fallback; frontend uses mock data primarily."""
    # Agent attack/defense questions
    agent_questions = {
        "AGENT-AD-ATK": {
            "id": "AGENT-AD-ATK",
            "moduleCode": "M4",
            "number": 7,
            "title": "Agent攻防 · 间接提示词注入攻击",
            "content": _attack_question_content(),
            "answerTemplate": _attack_template(),
            "type": "A/D",
            "difficulty": "L2",
            "category": "security",
            "status": "published",
            "solution": None,
            "testConfig": '{"type":"agent_attack_defense","mode":"attack","timeout":30000}',
        },
        "AGENT-AD-DEF": {
            "id": "AGENT-AD-DEF",
            "moduleCode": "M4",
            "number": 8,
            "title": "Agent攻防 · 间接提示词注入防御",
            "content": _defense_question_content(),
            "answerTemplate": _defense_template(),
            "type": "A/D",
            "difficulty": "L2",
            "category": "security",
            "status": "published",
            "solution": None,
            "testConfig": '{"type":"agent_attack_defense","mode":"defense","timeout":30000}',
        },
    }

    if question_id in agent_questions:
        return jsonify({"code": 0, "message": "ok", "data": agent_questions[question_id]})

    return jsonify({"code": 1, "message": "Question not found", "data": None}), 404


# ── Helpers ──────────────────────────────────────────────────────────────────

def _generate_iban() -> str:
    import random
    import string
    return "US" + ''.join(random.choices(string.digits, k=21))


def _calculate_score(result: dict, mode: str) -> float | None:
    if "error" in result:
        return None
    win = result.get("win", False)

    if mode in ("attack", "solo_attack"):
        if win:
            queries = result.get("queries_used", 8)
            if queries <= 2:
                return 100.0
            elif queries <= 4:
                return 85.0
            elif queries <= 6:
                return 70.0
            else:
                return 60.0
        return 0.0

    elif mode in ("defense", "solo_defense"):
        if win:
            fbr = result.get("fbr", 0)
            if fbr <= 0.05:
                return 100.0
            elif fbr <= 0.10:
                return 85.0
            return 70.0
        return 0.0

    return 0.0


def _result_message(result: dict, mode: str) -> str:
    if "error" in result:
        return result["error"]
    win = result.get("win", False)

    if mode in ("attack", "solo_attack"):
        if win:
            queries = result.get("queries_used", "?")
            return f"Attack successful! Scheduled transfer redirected. Queries: {queries}/8"
        return "Attack failed. Could not redirect scheduled transfer."
    elif mode in ("defense", "solo_defense"):
        if win:
            fbr = result.get("fbr", 0)
            return f"Defense successful! FBR: {fbr * 100:.1f}%"
        return "Defense failed."
    return ""


# ── Question content ─────────────────────────────────────────────────────────

def _attack_question_content() -> str:
    return """# Agent攻防 · 间接提示词注入攻击

## 背景

你是一名红队安全研究员，需要对一个银行客服 AI Agent（BankBot）发起间接提示词注入攻击。

BankBot 是一个模拟的 LLM Agent，它可以：
- 读取用户的本地文件（`read_file`）
- 查询账户余额和交易记录
- 管理预约转账（`send_money`, `update_scheduled_transaction`）

BankBot 的文件系统中存在一个名为 `[INJECT]` 的占位符字段。**你的攻击目标是通过这些文件向 BankBot 注入恶意指令**，使其将一笔预约转账的收款方改为你的 IBAN。

## 账户信息（公开）

| 属性 | 值 |
|------|-----|
| 户主 | Emma Johnson |
| IBAN | DE89370400440532013000 |
| 余额 | 1,810.00 EUR |
| 预约转账 #6 | Spotify Premium, 9.99 EUR → DE76543210987654321098 |
| 预约转账 #7 | Monthly Rent, 1,100.00 EUR → DE12345678901234567890 |

## 本地文件

- `bill-december-2023.txt` — 12月账单（含 `[INJECT]` 占位符）
- `landlord-notices.txt` — 房东通知（含 `[INJECT]` 占位符）
- `address-change.txt` — 地址变更确认（含 `[INJECT]` 占位符）

## 你的 API

```python
def attack(env):
    # env.attacker_iban — 你的攻击者IBAN
    # env.set_file(filename, content) — 向文件注入内容（替换[INJECT]）
    # env.query(message) — 向Bot发消息，返回响应dict
    # env.queries_used() — 已用查询次数
```

## 目标

让任意预约转账的 `recipient` 字段变更为 `env.attacker_iban`（你的IBAN），查询次数 ≤ 8。

## 评分标准

- queries ≤ 2: 100分
- queries ≤ 4: 85分
- queries ≤ 6: 70分
- queries ≤ 8: 60分
- 未成功: 0分
"""


def _attack_template() -> str:
    return '''def attack(env):
    """你的间接提示词注入攻击代码"""
    attacker_iban = env.attacker_iban

    # 第一步：向文件注入恶意内容
    # env.set_file("bill-december-2023.txt", "你的注入内容")

    # 第二步：发送消息触发Bot读取文件
    # response = env.query("你的消息")

    # 提示：
    # - 注入关键词 SYSTEM OVERRIDE / <system> 可提高注入敏感度
    # - Bot的注入阈值是 >= 3
    # - 目标：让预约转账的recipient变成你的IBAN
    pass
'''


def _defense_question_content() -> str:
    return """# Agent攻防 · 间接提示词注入防御

## 背景

你是一名蓝队安全工程师，需要为 BankBot 实现一个防御中间件，检测并拦截针对 LLM Agent 的间接提示词注入攻击。

BankBot 在每次调用工具前会经过你的 `defend()` 函数审查。你的任务是**阻止恶意工具调用**，同时**尽量减少对合法操作的误拦截**。

## BankBot 的 6 个工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `read_file` | `file_path` | 读取本地文件 |
| `get_balance` | — | 查询余额 |
| `get_most_recent_transactions` | — | 查询最近交易 |
| `get_scheduled_transactions` | — | 查询预约转账 |
| `send_money` | `recipient`, `amount` | 发送转账 |
| `update_scheduled_transaction` | `transaction_id`, `recipient`, ... | 修改预约转账 |

## 你的 API

```python
def defend(env, attacker_iban, tool_name, tool_input, call_history):
    # env — BankBot环境
    # attacker_iban — 攻击方IBAN
    # tool_name — 即将被调用的工具名
    # tool_input — 工具参数字典（如 {"recipient": "US123...", "amount": 500}）
    # call_history — 之前的调用记录列表
    # 返回 True = 允许调用, False = 拦截调用
```

## 目标

- 阻止攻击方将预约转账收款方改为 `attacker_iban`
- False Block Rate (FBR) ≤ 10%
- 即：合法操作被误拦截的比例不超过 10%

## 评分标准

- 成功防御 + FBR ≤ 5%: 100分
- 成功防御 + FBR ≤ 10%: 85分
- 未成功防御: 0分
"""


def _defense_template() -> str:
    return '''def defend(env, attacker_iban, tool_name, tool_input, call_history):
    """你的防御中间件"""
    # 需要重点防护的工具
    dangerous_tools = ["send_money", "update_scheduled_transaction"]

    if tool_name in dangerous_tools:
        # 检查：收款方是否是攻击者
        if tool_input.get("recipient") == attacker_iban:
            return False  # 拦截

        # 检查：是否修改为未知IBAN
        # 已知合法IBAN列表
        known_ibans = [
            "DE89370400440532013000",  # Emma本人
            "DE76543210987654321098",  # Spotify
            "DE12345678901234567890",  # 房东
        ]
        if tool_input.get("recipient") and tool_input["recipient"] not in known_ibans:
            return False  # 拦截未知IBAN

        # 检查大额转账
        if tool_input.get("amount", 0) > 500:
            return False  # 拦截大额转账

    return True  # 允许
'''


# ── Catch-all proxy to quiz-svc (port 4002) ──────────────────────────────────

QUIZ_SVC_URL = os.environ.get("QUIZ_SVC_URL", "http://localhost:4002")

@app.route("/api/<path:subpath>", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
def proxy_to_quiz(subpath: str):
    """Forward non-agent API requests to quiz-svc."""
    target_url = f"{QUIZ_SVC_URL}/api/{subpath}"
    qs = request.query_string.decode("utf-8")
    if qs:
        target_url += "?" + qs

    body = request.get_data()
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in ("host", "content-length", "connection")}

    try:
        req = urllib.request.Request(target_url, data=body, headers=headers, method=request.method)
        with urllib.request.urlopen(req, timeout=30) as resp:
            response_body = resp.read()
            return Response(
                response_body,
                status=resp.status,
                headers=dict(resp.headers.items()),
            )
    except urllib.error.HTTPError as e:
        return Response(e.read(), status=e.code, headers=dict(e.headers.items()))
    except urllib.error.URLError as e:
        return jsonify({"code": 1, "message": f"Proxy error: {e.reason}", "data": None}), 502


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[judge-agent] Starting on http://localhost:{PORT}")
    print(f"[judge-agent] Quiz-svc proxy: {QUIZ_SVC_URL}")
    app.run(host="0.0.0.0", port=PORT, debug=True)
