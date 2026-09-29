from __future__ import annotations

import http.client
import os
import threading
import unittest
from http.server import ThreadingHTTPServer

import modelctld as d


class _LiveServer(unittest.TestCase):
    """A real modelctld.Handler on an ephemeral loopback port -- F4's Host
    check reads self.server.server_address[1], so it needs an actual bound
    server, not a call to _guard() in isolation."""

    token = ""

    def setUp(self) -> None:
        self._orig_token = d.Handler.token
        self._orig_quiet = os.environ.get("MODELCTLD_QUIET")
        d.Handler.token = self.token
        os.environ["MODELCTLD_QUIET"] = "1"   # keep the request log off the test's own stderr
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), d.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.05),
                                       daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        d.Handler.token = self._orig_token
        if self._orig_quiet is None:
            os.environ.pop("MODELCTLD_QUIET", None)
        else:
            os.environ["MODELCTLD_QUIET"] = self._orig_quiet

    def _get(self, path: str, host: str | None, extra: dict | None = None) -> http.client.HTTPResponse:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            headers = dict(extra or {})
            if host is not None:
                headers["Host"] = host
            conn.request("GET", path, headers=headers)
            resp = conn.getresponse()
            resp.read()
            return resp
        finally:
            conn.close()

    def _get_without_host(self, path: str) -> http.client.HTTPResponse:
        """A request with no Host header at all -- http.client always adds one
        unless told to skip it and not given a replacement."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            conn.putrequest("GET", path, skip_host=True)
            conn.endheaders()
            resp = conn.getresponse()
            resp.read()
            return resp
        finally:
            conn.close()


class HostGuardTest(_LiveServer):
    def test_a_bad_host_is_403(self) -> None:
        resp = self._get("/v1/health", "evil.example.com")
        self.assertEqual(resp.status, 403)

    def test_localhost_and_127_0_0_1_pass(self) -> None:
        for host in (f"127.0.0.1:{self.port}", f"localhost:{self.port}"):
            with self.subTest(host=host):
                resp = self._get("/v1/health", host)
                self.assertEqual(resp.status, 200)

    def test_a_missing_host_is_403(self) -> None:
        resp = self._get_without_host("/v1/health")
        self.assertEqual(resp.status, 403)

    def test_the_right_host_but_wrong_port_is_403(self) -> None:
        resp = self._get("/v1/health", f"localhost:{self.port + 1}")
        self.assertEqual(resp.status, 403)


class HostGuardWithTokenTest(_LiveServer):
    token = "s3cret"

    def test_the_host_check_is_skipped_once_a_token_is_configured(self) -> None:
        # The token already authenticates the caller (decision F4's ruling);
        # a bad Host must not add a second, redundant refusal on top of it.
        resp = self._get("/v1/health", "evil.example.com", {"X-Modelctl-Token": "s3cret"})
        self.assertEqual(resp.status, 200)

    def test_a_missing_or_wrong_token_still_401s_regardless_of_host(self) -> None:
        resp = self._get("/v1/health", "evil.example.com")
        self.assertEqual(resp.status, 401)


if __name__ == "__main__":
    unittest.main()
