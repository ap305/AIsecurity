"""Loopback-only, standalone credentials and sessions for the read-only demo workspace."""
from collections import deque
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time


def load_credential(path):
    with Path(path).open(encoding="utf-8") as f:
        metadata = os.fstat(f.fileno())
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 2048
                or (os.name != "nt" and metadata.st_mode & 0o077)):
            raise ValueError("credential must be a regular, owner-only hash file")
        record = json.load(f)
    schema = {"username": r"[a-zA-Z0-9_-]{3,32}", "salt": r"[a-f0-9]{32}", "scryptHash": r"[a-f0-9]{128}"}
    if (not isinstance(record, dict) or record.keys() != schema.keys() or
            any(not isinstance(record[k], str) or not re.fullmatch(pattern, record[k]) for k, pattern in schema.items())):
        raise ValueError("invalid credential hash file")
    return record


class DemoSessions:
    def __init__(self, credential, clock=time.monotonic):
        self.user = {"id": "demo-showcase", "username": credential["username"], "displayName": "平台演示",
                     "role": "demo", "tier": "bronze", "school": "", "isTestAccount": False, "accountStatus": "active"}
        self.salt = credential["salt"].encode("ascii")
        self.key = bytes.fromhex(credential["scryptHash"])
        self.tokens = {}
        self.attempts = deque()
        self.lock = threading.Lock()
        self.hash_slots = threading.BoundedSemaphore(4)
        self.clock = clock

    def login(self, name, password, ip):
        # Pending verifications count immediately to bound parallel attempts from one client.
        with self.lock:
            now = self.clock()
            while self.attempts and self.attempts[0][0] <= now - 60:
                self.attempts.popleft()
            if (len(self.attempts) >= 120 or sum(a[1] == ip for a in self.attempts) >= 12
                    or not self.hash_slots.acquire(blocking=False)):
                return 429, None
            attempt = (now, ip, object())
            self.attempts.append(attempt)
        try:
            key = hashlib.scrypt(password.encode(), salt=self.salt, n=16384, r=8, p=1, dklen=64)
            if not hmac.compare_digest(key, self.key) or name != self.user["username"]:
                return 401, None
        finally:
            self.hash_slots.release()
        with self.lock:
            if attempt in self.attempts:
                self.attempts.remove(attempt)
            now = self.clock()
            self.tokens = {k: expiry for k, expiry in self.tokens.items() if expiry > now}
            if len(self.tokens) >= 1024:
                return 503, None
            token = "demo_" + secrets.token_hex(32)
            self.tokens[hashlib.sha256(token.encode("ascii")).digest()] = now + 2 * 3600
            return 200, {"token": token, "user": self.user}

    def verify(self, header, logout):
        match = re.fullmatch(r"Bearer (demo_[0-9a-f]{64})", header)
        if not match:
            return False
        key = hashlib.sha256(match[1].encode("ascii")).digest()
        with self.lock:
            if self.tokens.get(key, 0) <= self.clock():
                self.tokens.pop(key, None)
                return False
            if logout:
                self.tokens.pop(key)
            return True


class DemoHandler(BaseHTTPRequestHandler):
    server_version = "Demo"
    sys_version = ""
    timeout = 10

    def log_message(self, *args):
        pass  # Never log request paths, credentials or session tokens.

    def reply(self, status, data=None):
        messages = {200: "ok", 400: "请使用演示账号和密码登录", 401: "演示凭据无效或登录已过期",
                    403: "演示账号仅可访问演示工作台", 429: "演示登录请求较多，请稍后再试",
                    503: "当前演示服务繁忙，请稍后再试"}
        body = json.dumps({"code": 0 if status == 200 else status * 100, "message": messages[status],
                           "data": data}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        if status == 429:
            self.send_header("Retry-After", "60")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def login(self):
        length = self.headers.get("Content-Length", "")
        if (not re.fullmatch(r"[0-9]{1,4}", length) or not 0 < int(length) <= 2048 or
                self.headers.get("Transfer-Encoding") or self.headers.get("Content-Encoding", "identity") != "identity"
                or self.headers.get_content_type() != "application/json" or self.headers.get("Authorization")):
            return self.reply(400)
        try:
            form = json.loads(self.rfile.read(int(length)).decode())
            if not isinstance(form, dict) or form.get("role") != "demo":
                return self.reply(400)
            name, password = form.get("username"), form.get("password")
            if not isinstance(name, str) or len(name) > 32 or not isinstance(password, str) or not 1 <= len(password) <= 128:
                return self.reply(400)
            password.encode()  # Reject lone JSON surrogates before scrypt.
        except (ValueError, RecursionError):
            return self.reply(400)
        ip = self.client_address[0]
        # The public gateway overwrites X-Real-IP and this service binds only to loopback.
        if ipaddress.ip_address(ip).is_loopback:
            try:
                ip = str(ipaddress.ip_address(self.headers["X-Real-IP"]))
            except ValueError:
                pass
        self.reply(*self.server.sessions.login(name, password, ip))

    def dispatch(self):
        if self.command == "GET" and self.path == "/api/demo/health":
            return self.reply(200, {"status": "healthy"})
        if self.command == "POST" and self.path == "/api/demo/auth/login":
            return self.login()
        restore = self.command == "GET" and self.path == "/api/demo/auth/me"
        logout = self.command == "POST" and self.path == "/api/demo/auth/logout"
        if not restore and not logout:
            return self.reply(403)
        if not self.server.sessions.verify(self.headers.get("Authorization", ""), logout):
            return self.reply(401)
        self.reply(200, {"user": self.server.sessions.user} if restore else {"ok": True})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = dispatch


def serve():
    host = os.environ.get("HOST", "127.0.0.1")
    if host != "127.0.0.1":
        raise ValueError("the demo server must listen on 127.0.0.1")
    credential = load_credential(os.environ["DEMO_CREDENTIAL_FILE"])
    with ThreadingHTTPServer((host, int(os.environ.get("PORT", "18476"))), DemoHandler) as server:
        server.sessions = DemoSessions(credential)
        server.serve_forever()


if __name__ == "__main__":
    serve()
