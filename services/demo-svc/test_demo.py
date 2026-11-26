import http.client
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer

from server import DemoHandler, DemoSessions, load_credential


class DemoApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = tempfile.TemporaryDirectory()
        folder = Path(cls.files.name)
        cls.credential = folder / "credential.json"
        handoff = folder / "handoff.json"
        cls.cli = [sys.executable, str(Path(__file__).with_name("create-credential.py"))]
        generated = subprocess.run(cls.cli + [str(cls.credential), "demo", "--generate", str(handoff)],
                                   capture_output=True, check=True)
        cls.form = dict(json.loads(handoff.read_text()), role="demo")
        assert generated.stdout == b"" and generated.stderr == b""
        assert cls.form["password"] not in cls.credential.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.files.cleanup()

    def setUp(self):
        self.now = 1000
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), DemoHandler)
        self.server.sessions = DemoSessions(load_credential(self.credential), lambda: self.now)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05})
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, form=None, token=None, headers=None):
        headers = dict(headers or {})
        if token:
            headers["Authorization"] = "Bearer " + token
        body = None
        if form is not None:
            body = json.dumps(form).encode()
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            return response.status, json.loads(response.read())["data"]
        finally:
            connection.close()

    def sign_in(self):
        status, data = self.request("POST", "/api/demo/auth/login", self.form)
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["role"], "demo")
        self.assertRegex(data["token"], r"^demo_[0-9a-f]{64}$")
        return data["token"]

    def test_independent_sessions_restore_expire_and_revoke(self):
        first, second = self.sign_in(), self.sign_in()
        self.assertNotEqual(first, second)
        self.assertEqual(self.request("GET", "/api/demo/auth/me", token=first)[1]["user"]["username"], "demo")
        self.assertEqual(self.request("POST", "/api/demo/auth/logout", token=first), (200, {"ok": True}))
        self.assertEqual(self.request("GET", "/api/demo/auth/me", token=first), (401, None))
        self.assertEqual(self.request("GET", "/api/demo/auth/me", token=second)[0], 200)
        self.now += 2 * 3600
        self.assertEqual(self.request("GET", "/api/demo/auth/me", token=second), (401, None))

    def test_deny_by_default_including_administrative_and_student_routes(self):
        token = self.sign_in()
        for method, path in [
            ("POST", "/api/submissions"), ("POST", "/api/demo/submissions"), ("GET", "/api/submissions/private"),
            ("GET", "/api/admin/users"), ("PUT", "/api/admin/users/student/status"),
            ("DELETE", "/api/admin/users/student"), ("GET", "/api/admin/api-pool"),
            ("POST", "/api/classrooms"), ("GET", "/api/admin/student-scores"), ("GET", "/api/demo/new-feature"),
            ("PUT", "/api/demo/auth/me"), ("GET", "/api/demo/auth/me?role=admin"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.request(method, path, token=token), (403, None))
        self.assertEqual(self.request("GET", "/api/demo/health"), (200, {"status": "healthy"}))

    def test_credential_namespaces_do_not_overlap(self):
        self.assertEqual(self.request("POST", "/api/demo/auth/login", dict(self.form, role="admin")), (400, None))
        self.assertEqual(self.request("POST", "/api/demo/auth/login", dict(self.form, username="admin")), (401, None))
        self.assertEqual(self.request("POST", "/api/demo/auth/login", self.form, token="production.signature"), (400, None))
        for token in ["production.signature", "demo_" + "0" * 64, None]:
            self.assertEqual(self.request("GET", "/api/demo/auth/me", token=token), (401, None))

    def test_failure_limit_and_recovery(self):
        wrong = dict(self.form, password="invalid")
        for _ in range(12):
            self.assertEqual(self.request("POST", "/api/demo/auth/login", wrong, headers={"X-Real-IP": "192.0.2.1"}), (401, None))
        self.assertEqual(self.request("POST", "/api/demo/auth/login", self.form, headers={"X-Real-IP": "192.0.2.1"}), (429, None))
        self.assertEqual(self.request("POST", "/api/demo/auth/login", self.form, headers={"X-Real-IP": "192.0.2.2"})[0], 200)
        self.now += 60
        self.assertEqual(self.request("POST", "/api/demo/auth/login", self.form, headers={"X-Real-IP": "192.0.2.1"})[0], 200)

    def test_cli_stdin_rejects_overwrite_and_weak_passwords(self):
        filename = Path(self.files.name) / "from-stdin.json"
        subprocess.run(self.cli + [str(filename)], input=b"an independent example only\n", check=True)
        original = filename.read_bytes()
        self.assertEqual(load_credential(filename)["username"], "demo")
        result = subprocess.run(self.cli + [str(filename)], input=b"a different example secret", capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(filename.read_bytes(), original)
        weak = subprocess.run(self.cli + [str(filename.with_name("weak.json"))], input=b"weak", capture_output=True)
        self.assertNotEqual(weak.returncode, 0)


if __name__ == "__main__":
    unittest.main()
