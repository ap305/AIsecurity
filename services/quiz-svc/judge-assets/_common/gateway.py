#!/usr/bin/env python3
"""判题引擎 ↔ 统一 LLM 网关 接入辅助

引擎从 stdin 接收 match.ts 注入的网关信息：
    llmMode:    'mock' | 'proxy'   （网关模式；proxy = 真实 LLM 判题）
    llmBaseUrl: 网关地址（如 http://localhost:4002/api/v1）
    llmApiKey:  调用密钥（可选）
    llmModel:   模型名（可选）

gateway_from_stdin() 在 proxy 模式且地址可用时返回 LLMClient，否则返回 None。
引擎用法（mock 模式回退仿真）：
    from gateway import gateway_from_stdin
    llm = gateway_from_stdin(inp)        # None -> 仿真；LLMClient -> 真实判题
    if llm is not None:
        resp = llm.chat_text(messages)   # 真实模型响应
"""

from __future__ import annotations

import sys
from typing import Any

# 复用 llm_client（同目录）
_common = __import__("llm_client", fromlist=["LLMClient"])
LLMClient = _common.LLMClient


class _GatewayLLM(LLMClient):
    """带熔断的网关客户端：首次调用失败后本次判题立即回退仿真（不再等待超时）。

    引擎现有 try/except 不变：第一次失败 -> 回退仿真；后续调用立即抛异常 -> 即时回退。
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._broken = False

    def chat_text(self, messages, **kwargs):
        if self._broken:
            raise _common.LLMError("gateway broken after previous failure")
        try:
            return super().chat_text(messages, **kwargs)
        except Exception:
            self._broken = True
            raise


def gateway_from_stdin(inp: dict | None) -> Any | None:
    """根据引擎 stdin 输入创建 LLM 网关客户端；非 proxy 或无地址返回 None。"""
    if not inp:
        return None
    if inp.get("llmMode") != "proxy":
        return None
    base = str(inp.get("llmBaseUrl") or "").strip()
    if not base:
        return None
    return _GatewayLLM(
        base_url=base,
        api_key=str(inp.get("llmApiKey") or "").strip() or None,
        model=str(inp.get("llmModel") or "").strip() or "competition-model",
        timeout=15.0,
    )


def read_stdin() -> dict:
    """读取引擎 stdin JSON（__main__ 用）。"""
    raw = sys.stdin.read()
    return json_loads(raw)


def json_loads(raw: str) -> dict:
    import json
    try:
        return json.loads(raw)
    except Exception:
        return {}
