#!/usr/bin/env python3
"""Cache dos estáticos: `?v=` correto é cache eterno, o resto não é.

O `?v=` é o hash curto do arquivo (ver tests/test_cache_busting.py, que compara
o HTML com o disco). Aqui se testa o outro lado: o servidor só manda
`immutable` quando o `?v=` pedido bate com o conteúdo que ele está entregando —
se alguém pedir `?v=` velho, a resposta tem de vir sem cache, senão o navegador
guarda a versão errada para sempre. O HTML nunca é cacheado, porque é ele que
carrega o `?v=` novo.

Roda contra o servidor local: python3 -m unittest tests.test_cache_http
"""
import hashlib
import os
import unittest
import urllib.error
import urllib.request

BASE = os.environ.get("BASE_API", "http://localhost:8000")


def headers(path):
    try:
        with urllib.request.urlopen(BASE + path) as r:
            return r.status, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers)


def hash_do_arquivo(nome):
    raiz = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(raiz, "frontend", nome), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:8]


class TestCacheDosEstaticos(unittest.TestCase):
    def test_v_correto_e_immutable(self):
        v = hash_do_arquivo("admin.js")
        st, h = headers("/admin.js?v=" + v)
        self.assertEqual(st, 200)
        self.assertIn("immutable", h.get("Cache-Control", ""))

    def test_v_errado_nao_e_cacheado(self):
        st, h = headers("/admin.js?v=deadbeef")
        self.assertEqual(st, 200)
        self.assertNotIn("immutable", h.get("Cache-Control", ""))

    def test_html_sem_cache(self):
        # O painel é servido em /admin (não em /admin.html).
        st, h = headers("/admin")
        self.assertEqual(st, 200)
        self.assertIn("no-cache", h.get("Cache-Control", ""))


if __name__ == "__main__":
    unittest.main()
