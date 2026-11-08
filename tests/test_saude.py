#!/usr/bin/env python3
"""Health check da hospedagem: /healthz responde sem depender de banco nem seed.

Roda contra o servidor local: python3 -m unittest tests.test_saude
Exige o servidor no ar (http://localhost:8000).
"""
import json
import unittest
import urllib.request

BASE = "http://localhost:8000"


class Saude(unittest.TestCase):
    def test_healthz_responde_200_sem_login(self):
        with urllib.request.urlopen(BASE + "/healthz", timeout=10) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("application/json", r.headers.get("Content-Type", ""))
            self.assertEqual(json.loads(r.read().decode("utf-8")), {"status": "ok"})

    def test_healthz_nao_exige_cookie_nem_token(self):
        req = urllib.request.Request(BASE + "/healthz", method="GET")
        with urllib.request.urlopen(req, timeout=10) as r:
            self.assertEqual(r.status, 200)

    def test_home_continua_respondendo(self):
        with urllib.request.urlopen(BASE + "/", timeout=10) as r:
            self.assertEqual(r.status, 200)
            self.assertIn("text/html", r.headers.get("Content-Type", ""))


if __name__ == "__main__":
    unittest.main()
