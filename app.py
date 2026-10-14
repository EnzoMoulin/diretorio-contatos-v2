"""Diretório de contatos — demo para portfólio (stdlib Python, sem dependências).

Inspirado em experiência prévia com diretório institucional de contatos
(consulta pública + gestão interna + histórico de alterações).
Todo o código e os dados aqui são fictícios e genéricos, criados do zero
para demonstração. Nenhum dado real ou interno é utilizado.

Como rodar:
    python3 app.py
    -> abre http://localhost:8000

Endpoints:
    GET  /api/contatos?q=texto      lista/busca (público)
    GET  /api/historico             histórico de alterações (público p/ demo)
    POST /api/login                 {usuario, senha} -> {token} (demo: admin/admin123)
    POST /api/contatos              cria (header X-Admin-Token)
    PUT  /api/contatos/<id>         atualiza (header X-Admin-Token)
    DELETE /api/contatos/<id>       remove (header X-Admin-Token)
"""

import json
import sqlite3
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

BASE = Path(__file__).parent
DB = BASE / "contatos.db"
FRONT = BASE / "frontend"

DEMO_USER = "admin"
DEMO_PASS = "admin123"
DEMO_TOKEN = "demo-token-123"

SCHEMA = """
CREATE TABLE IF NOT EXISTS contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    setor TEXT NOT NULL DEFAULT '',
    telefone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    acao TEXT NOT NULL,
    contato_id INTEGER,
    detalhe TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

SEED = [
    ("Ana Souza", "Atendimento", "(27) 3333-0001", "atendimento@empresa-exemplo.com.br"),
    ("Bruno Lima", "Suporte", "(27) 3333-0002", "suporte@empresa-exemplo.com.br"),
    ("Carla Dias", "Financeiro", "(27) 3333-0003", "financeiro@empresa-exemplo.com.br"),
    ("Diego Rocha", "RH", "(27) 3333-0004", "rh@empresa-exemplo.com.br"),
    ("Elisa Prado", "Jurídico", "(27) 3333-0005", "juridico@empresa-exemplo.com.br"),
    ("Fabio Nunes", "TI", "(27) 3333-0006", "ti@empresa-exemplo.com.br"),
]


def get_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    new = not DB.exists()
    con = get_db()
    con.executescript(SCHEMA)
    n = con.execute("SELECT COUNT(*) AS c FROM contatos").fetchone()["c"]
    if n == 0:
        con.executemany(
            "INSERT INTO contatos (nome, setor, telefone, email) VALUES (?,?,?,?)",
            SEED,
        )
        con.execute(
            "INSERT INTO historico (acao, detalhe) VALUES (?,?)",
            ("init", "base de demonstração criada com dados fictícios"),
        )
    con.commit()
    con.close()
    return new


def log(con, acao, contato_id=None, detalhe=""):
    con.execute(
        "INSERT INTO historico (acao, contato_id, detalhe) VALUES (?,?,?)",
        (acao, contato_id, detalhe),
    )


class Handler(BaseHTTPRequestHandler):
    server_version = "ContatosDemo/1.0"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, name, ctype):
        p = FRONT / name
        if not p.exists():
            self.send_error(404)
            return
        body = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        ln = int(self.headers.get("Content-Length") or 0)
        if ln == 0:
            return {}
        try:
            return json.loads(self.rfile.read(ln).decode("utf-8"))
        except Exception:
            return {}

    def _admin(self):
        return self.headers.get("X-Admin-Token") == DEMO_TOKEN

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        if u.path in ("/", "/index.html"):
            return self._static("index.html", "text/html; charset=utf-8")
        if u.path == "/app.js":
            return self._static("app.js", "application/javascript; charset=utf-8")
        if u.path == "/style.css":
            return self._static("style.css", "text/css; charset=utf-8")
        if u.path == "/api/contatos":
            termo = (q.get("q") or [""])[0].strip()
            con = get_db()
            if termo:
                like = f"%{termo}%"
                rows = con.execute(
                    "SELECT * FROM contatos WHERE nome LIKE ? OR setor LIKE ?"
                    " OR telefone LIKE ? OR email LIKE ? ORDER BY nome",
                    (like, like, like, like),
                ).fetchall()
            else:
                rows = con.execute("SELECT * FROM contatos ORDER BY nome").fetchall()
            con.close()
            return self._json([dict(r) for r in rows])
        if u.path == "/api/historico":
            con = get_db()
            rows = con.execute(
                "SELECT * FROM historico ORDER BY id DESC LIMIT 50"
            ).fetchall()
            con.close()
            return self._json([dict(r) for r in rows])
        return self.send_error(404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/login":
            data = self._body()
            if data.get("usuario") == DEMO_USER and data.get("senha") == DEMO_PASS:
                return self._json({"token": DEMO_TOKEN})
            return self._json({"erro": "credenciais inválidas"}, 401)
        if u.path == "/api/contatos":
            if not self._admin():
                return self._json({"erro": "token admin inválido"}, 403)
            data = self._body()
            if not data.get("nome"):
                return self._json({"erro": "campo 'nome' é obrigatório"}, 400)
            con = get_db()
            cur = con.execute(
                "INSERT INTO contatos (nome, setor, telefone, email)"
                " VALUES (?,?,?,?)",
                (data.get("nome"), data.get("setor", ""),
                 data.get("telefone", ""), data.get("email", "")),
            )
            log(con, "criar", cur.lastrowid, f"criado: {data.get('nome')}")
            con.commit()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (cur.lastrowid,)
            ).fetchone()
            con.close()
            return self._json(dict(row), 201)
        return self.send_error(404)

    def do_PUT(self):
        parts = urllib.parse.urlparse(self.path).path.rstrip("/").split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "contatos":
            if not self._admin():
                return self._json({"erro": "token admin inválido"}, 403)
            try:
                cid = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            data = self._body()
            con = get_db()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
            if not row:
                con.close()
                return self._json({"erro": "não encontrado"}, 404)
            con.execute(
                "UPDATE contatos SET nome=?, setor=?, telefone=?, email=?,"
                " atualizado_em=datetime('now') WHERE id=?",
                (data.get("nome", row["nome"]), data.get("setor", row["setor"]),
                 data.get("telefone", row["telefone"]),
                 data.get("email", row["email"]), cid),
            )
            log(con, "atualizar", cid, f"atualizado: {data.get('nome', row['nome'])}")
            con.commit()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
            con.close()
            return self._json(dict(row))
        return self.send_error(404)

    def do_DELETE(self):
        parts = urllib.parse.urlparse(self.path).path.rstrip("/").split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "contatos":
            if not self._admin():
                return self._json({"erro": "token admin inválido"}, 403)
            try:
                cid = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            con = get_db()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
            if not row:
                con.close()
                return self._json({"erro": "não encontrado"}, 404)
            con.execute("DELETE FROM contatos WHERE id=?", (cid,))
            log(con, "remover", cid, f"removido: {row['nome']}")
            con.commit()
            con.close()
            return self._json({"ok": True})
        return self.send_error(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    init_db()
    print("Demo no ar: http://localhost:8000  (login demo: admin / admin123)")
    HTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
