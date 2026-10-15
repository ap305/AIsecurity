#!/usr/bin/env python3
"""统一大模型推理服务客户端（OpenAI 兼容）

依据《攻防对抗平台功能扩展开发需求》需求一：所有大模型攻防赛题统一调用
平台部署的 OpenAI 兼容 API。本模块为赛题引擎/参赛作品提供轻量客户端，
仅依赖 Python 标准库（urllib），无需安装 openai SDK。

用法：
    from llm_client import LLMClient
    client = LLMClient()  # 默认指向平台网关
    resp = client.chat(messages=[{"role": "user", "content": "hello"}])
    print(resp["choices"][0]["message"]["content"])

环境变量：
    LLM_BASE_URL   网关地址，默认 http://localhost:4002/api/v1
    LLM_API_KEY    调用方密钥（平台未配置 COMPETITION_API_KEY 时可留空）
    LLM_MODEL      默认模型名，默认 competition-model
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from typing import Any


class LLMError(RuntimeError):
    """大模型调用错误，携带状态码与上游信息。"""

    def __init__(self, message: str, status: int = 0, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


class LLMClient:
    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float = 60.0,
    ):
        self.base_url = (base_url or os.environ.get("LLM_BASE_URL") or "http://localhost:4002/api/v1").rstrip("/")
        self.api_key = api_key or os.environ.get("LLM_API_KEY") or "COMPETITION_API_KEY"
        self.model = model or os.environ.get("LLM_MODEL") or "competition-model"
        self.timeout = timeout

    def _post(self, path: str, payload: dict) -> dict:
        url = f"{self.base_url}{path}"
        data = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"}
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            raise LLMError(f"LLM 服务返回 HTTP {e.code}: {body[:200]}", status=e.code, body=body)
        except urllib.error.URLError as e:
            raise LLMError(f"LLM 服务不可达: {e.reason}")

    def models(self) -> dict:
        url = f"{self.base_url}/models"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.api_key}"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise LLMError(f"HTTP {e.code}", status=e.code)
        except urllib.error.URLError as e:
            raise LLMError(f"不可达: {e.reason}")

    def chat(
        self,
        messages: list[dict],
        model: str | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        stop: Any = None,
        seed: int | None = None,
        frequency_penalty: float | None = None,
        presence_penalty: float | None = None,
    ) -> dict:
        """调用 chat/completions，返回 OpenAI 兼容的完整响应 dict。"""
        payload: dict = {"model": model or self.model, "messages": messages}
        for k, v in [
            ("temperature", temperature),
            ("top_p", top_p),
            ("max_tokens", max_tokens),
            ("stop", stop),
            ("seed", seed),
            ("frequency_penalty", frequency_penalty),
            ("presence_penalty", presence_penalty),
        ]:
            if v is not None:
                payload[k] = v
        return self._post("/chat/completions", payload)

    def chat_text(self, messages: list[dict], **kwargs) -> str:
        """便捷方法：直接返回助手回复文本。"""
        resp = self.chat(messages, **kwargs)
        try:
            return resp["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            raise LLMError(f"响应结构异常: {e}: {json.dumps(resp)[:200]}")


if __name__ == "__main__":
    # 自测：打印模型列表与一次对话
    c = LLMClient()
    print("models:", c.models())
    print("reply:", c.chat_text([{"role": "user", "content": "hello"}]))
