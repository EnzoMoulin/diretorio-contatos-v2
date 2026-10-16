"""Diretório de contatos — demo para portfólio (stdlib Python, sem dependências).

Inspirado em experiência prévia com diretório institucional de contatos:
consulta pública + área administrativa com login + histórico de alterações
+ solicitação de acesso + navegação em camadas (localidade > unidade > setor).
Todo o código e os dados aqui são fictícios e genéricos, criados do zero
para demonstração. Nenhum dado real ou interno é utilizado.

Como rodar:
    python3 app.py
    -> pública: http://localhost:8000
    -> admin:   http://localhost:8000/admin  (demo: admin / admin123)

Endpoints (JSON):
    GET  /api/localidades                 localidades + total de contatos
    GET  /api/unidades?localidade_id=N
    GET  /api/setores?unidade_id=N
    GET  /api/contatos?q=&setor_id=&unidade_id=&localidade_id=
    GET  /api/historico                   requer token
    GET  /api/me                          requer token -> {usuario}
    POST /api/login                       {usuario, senha} -> {token}
    POST /api/contatos                    cria (token)
    DELETE /api/contatos/<id>             remove (token)
    POST /api/pedidos                     {nome,email,usuario,motivo} (público)
    GET  /api/pedidos                     pendentes (token)
    POST /api/pedidos/<id>/aprovar        cria usuário (token)
"""

import hashlib
import json
import secrets
import sqlite3
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

BASE = Path(__file__).parent
DB = BASE / "contatos.db"
FRONT = BASE / "frontend"

SESSIONS = {}  # token -> usuario_id (memória; demo)

SCHEMA = """
CREATE TABLE IF NOT EXISTS localidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS unidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    localidade_id INTEGER NOT NULL REFERENCES localidades(id),
    nome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS setores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unidade_id INTEGER NOT NULL REFERENCES unidades(id),
    nome TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setor_id INTEGER NOT NULL REFERENCES setores(id),
    nome TEXT NOT NULL, cargo TEXT NOT NULL DEFAULT '',
    telefone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT, acao TEXT NOT NULL,
    contato_id INTEGER, detalhe TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL UNIQUE,
    senha_sha256 TEXT NOT NULL, aprovado INTEGER NOT NULL DEFAULT 1,
    admin INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS usuarios_locais (
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    localidade_id INTEGER NOT NULL REFERENCES localidades(id),
    PRIMARY KEY (usuario_id, localidade_id));
CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
    email TEXT NOT NULL, usuario_desejado TEXT NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    localidade_id INTEGER REFERENCES localidades(id),
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TEXT NOT NULL DEFAULT (datetime('now')));
"""

# (localidade, unidade, setor, nome, cargo, telefone, email) — tudo fictício
SEED = [
    ("Vitória", "Unidade Centro", "Atendimento", "Ana Souza", "Atendente",
     "(27) 3333-0001", "atendimento@empresa-exemplo.com.br"),
    ("Vitória", "Unidade Centro", "Atendimento", "Paulo Reis", "Atendente",
     "(27) 3333-0007", "paulo.reis@empresa-exemplo.com.br"),
    ("Vitória", "Unidade Centro", "Suporte", "Bruno Lima", "Técnico de suporte",
     "(27) 3333-0002", "suporte@empresa-exemplo.com.br"),
    ("Vitória", "Unidade Jardim", "Financeiro", "Carla Dias", "Analista financeira",
     "(27) 3333-0003", "financeiro@empresa-exemplo.com.br"),
    ("Vitória", "Unidade Jardim", "RH", "Diego Rocha", "Analista de RH",
     "(27) 3333-0004", "rh@empresa-exemplo.com.br"),
    ("Vila Velha", "Unidade Praia", "Atendimento", "Elisa Prado", "Atendente",
     "(27) 3333-0005", "elisaprado@empresa-exemplo.com.br"),
    ("Vila Velha", "Unidade Praia", "TI", "Fabio Nunes", "Desenvolvedor",
     "(27) 3333-0006", "ti@empresa-exemplo.com.br"),
    ("Vila Velha", "Unidade Centro", "Suporte", "Gabi Moura", "Técnica de suporte",
     "(27) 3333-0008", "gabi.moura@empresa-exemplo.com.br"),
    ("Serra", "Unidade Laranjeiras", "Atendimento", "Hugo Alves", "Atendente",
     "(27) 3333-0009", "hugo.alves@empresa-exemplo.com.br"),
    ("Serra", "Unidade Laranjeiras", "Logística", "Inês Castro", "Coordenadora",
     "(27) 3333-0010", "logistica@empresa-exemplo.com.br"),
    ("Cariacica", "Unidade Centro", "Atendimento", "João Pinto", "Atendente",
     "(27) 3333-0011", "joao.pinto@empresa-exemplo.com.br"),
    ("Cariacica", "Unidade Centro", "TI", "Karla Mendes", "Analista de sistemas",
     "(27) 3333-0012", "karla.mendes@empresa-exemplo.com.br"),
]

SENHA_INICIAL = "bemvindo123"
# Domínio institucional da demo: equivale à checagem de e-mail institucional
# do sistema original (lá, sessão Google + intranet; aqui, login + domínio).
DOMINIO_INSTITUCIONAL = "empresa-exemplo.com.br"


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def get_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    con = get_db()
    cols = [r["name"] for r in con.execute("PRAGMA table_info(usuarios)")]
    if cols and "admin" not in cols:  # esquema v1 -> recria (demo)
        con.executescript("""
            DROP TABLE IF EXISTS pedidos; DROP TABLE IF EXISTS usuarios;
            DROP TABLE IF EXISTS historico; DROP TABLE IF EXISTS contatos;
            DROP TABLE IF EXISTS setores; DROP TABLE IF EXISTS unidades;
            DROP TABLE IF EXISTS localidades; DROP TABLE IF EXISTS usuarios_locais;
        """)
    con.executescript(SCHEMA)
    cols_u = [r["name"] for r in con.execute("PRAGMA table_info(usuarios)")]
    if "email" not in cols_u:  # compatível com USUARIOS.EMAIL do original
        con.execute("ALTER TABLE usuarios ADD COLUMN email TEXT NOT NULL DEFAULT ''")
    con.execute("UPDATE usuarios SET email=? WHERE usuario='admin' AND email=''",
                ("admin@" + DOMINIO_INSTITUCIONAL,))
    n = con.execute("SELECT COUNT(*) AS c FROM contatos").fetchone()["c"]
    if n == 0:
        locs, uns, sets = {}, {}, {}
        for loc, und, set_, nome, cargo, tel, mail in SEED:
            if loc not in locs:
                locs[loc] = con.execute(
                    "INSERT INTO localidades (nome) VALUES (?)", (loc,)).lastrowid
            key_u = (loc, und)
            if key_u not in uns:
                uns[key_u] = con.execute(
                    "INSERT INTO unidades (localidade_id, nome) VALUES (?,?)",
                    (locs[loc], und)).lastrowid
            key_s = (loc, und, set_)
            if key_s not in sets:
                sets[key_s] = con.execute(
                    "INSERT INTO setores (unidade_id, nome) VALUES (?,?)",
                    (uns[key_u], set_)).lastrowid
            con.execute(
                "INSERT INTO contatos (setor_id, nome, cargo, telefone, email)"
                " VALUES (?,?,?,?,?)", (sets[key_s], nome, cargo, tel, mail))
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin)"
            " VALUES (?,?,1,1) ON CONFLICT(usuario) DO NOTHING",
            ("admin", sha("admin123")))
        con.execute(
            "INSERT INTO historico (acao, detalhe) VALUES (?,?)",
            ("init", "base de demonstração criada com dados fictícios"))
    con.commit()
    con.close()


def log(con, acao, contato_id=None, detalhe=""):
    con.execute(
        "INSERT INTO historico (acao, contato_id, detalhe) VALUES (?,?,?)",
        (acao, contato_id, detalhe))


class Handler(BaseHTTPRequestHandler):
    server_version = "ContatosDemo/2.0"

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, name, ctype):
        p = FRONT / name
        if not p.exists() or ".." in name:
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

    def _uid(self):
        tok = self.headers.get("X-Admin-Token") or ""
        return SESSIONS.get(tok)

    def _user(self, con, uid):
        return con.execute(
            "SELECT * FROM usuarios WHERE id=?", (uid,)).fetchone()

    def _escopo(self, con, uid):
        """Locais que o usuário pode editar. Admin: todos ('all')."""
        u = self._user(con, uid)
        if not u or not u["aprovado"]:
            return None
        if u["admin"]:
            return "all"
        rows = con.execute(
            "SELECT localidade_id FROM usuarios_locais WHERE usuario_id=?",
            (uid,)).fetchall()
        return {r["localidade_id"] for r in rows}

    def _pode(self, con, uid, localidade_id):
        esc = self._escopo(con, uid)
        if esc is None:
            return False
        if esc == "all":
            return True
        return int(localidade_id) in esc

    def _loc_de_setor(self, con, setor_id):
        r = con.execute(
            "SELECT l.id FROM localidades l JOIN unidades u ON u.localidade_id=l.id"
            " JOIN setores s ON s.unidade_id=u.id WHERE s.id=?",
            (setor_id,)).fetchone()
        return r["id"] if r else None

    def _loc_de_contato(self, con, cid):
        r = con.execute(
            "SELECT l.id FROM localidades l JOIN unidades u ON u.localidade_id=l.id"
            " JOIN setores s ON s.unidade_id=u.id"
            " JOIN contatos c ON c.setor_id=s.id WHERE c.id=?",
            (cid,)).fetchone()
        return r["id"] if r else None

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        arg = lambda k: (q.get(k) or [""])[0].strip()
        if u.path in ("/", "/public.html"):
            return self._static("public.html", "text/html; charset=utf-8")
        if u.path == "/admin":
            return self._static("admin.html", "text/html; charset=utf-8")
        if u.path in ("/public.js", "/admin.js", "/mapa.js"):
            return self._static(u.path[1:], "application/javascript; charset=utf-8")
        if u.path == "/style.css":
            return self._static("style.css", "text/css; charset=utf-8")
        con = get_db()
        try:
            if u.path == "/api/localidades":
                rows = con.execute(
                    "SELECT l.id, l.nome, COUNT(c.id) AS total FROM localidades l"
                    " LEFT JOIN unidades u ON u.localidade_id=l.id"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos c ON c.setor_id=s.id"
                    " GROUP BY l.id ORDER BY l.nome").fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/unidades":
                rows = con.execute(
                    "SELECT * FROM unidades WHERE localidade_id=? ORDER BY nome",
                    (arg("localidade_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/setores":
                rows = con.execute(
                    "SELECT * FROM setores WHERE unidade_id=? ORDER BY nome",
                    (arg("unidade_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/contatos":
                sql = ("SELECT c.*, s.nome AS setor, u.nome AS unidade,"
                       " u.id AS unidade_id, l.nome AS localidade, l.id AS localidade_id"
                       " FROM contatos c JOIN setores s ON s.id=c.setor_id"
                       " JOIN unidades u ON u.id=s.unidade_id"
                       " JOIN localidades l ON l.id=u.localidade_id WHERE 1=1")
                params = []
                for key, col in (("setor_id", "c.setor_id"),
                                 ("unidade_id", "u.id"),
                                 ("localidade_id", "l.id")):
                    if arg(key):
                        sql += f" AND {col}=?"
                        params.append(arg(key))
                if arg("q"):
                    like = f"%{arg('q')}%"
                    sql += (" AND (c.nome LIKE ? OR c.cargo LIKE ? OR c.telefone LIKE ?"
                            " OR c.email LIKE ? OR s.nome LIKE ? OR u.nome LIKE ?"
                            " OR l.nome LIKE ?)")
                    params += [like] * 7
                sql += " ORDER BY c.nome"
                rows = con.execute(sql, params).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/historico":
                if not self._uid():
                    return self._json({"erro": "não autenticado"}, 403)
                rows = con.execute(
                    "SELECT * FROM historico ORDER BY id DESC LIMIT 50").fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/me":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                row = con.execute(
                    "SELECT id, usuario, admin FROM usuarios WHERE id=?",
                    (uid,)).fetchone()
                if not row:
                    return self._json({"erro": "não autenticado"}, 403)
                me = dict(row)
                esc = self._escopo(con, uid)
                me["escopo"] = "all" if esc == "all" else sorted(esc or [])
                return self._json(me)
            if u.path == "/api/pedidos":
                if not self._uid():
                    return self._json({"erro": "não autenticado"}, 403)
                rows = con.execute(
                    "SELECT p.*, l.nome AS localidade FROM pedidos p"
                    " LEFT JOIN localidades l ON l.id=p.localidade_id"
                    " WHERE p.status='pendente' ORDER BY p.id DESC").fetchall()
                return self._json([dict(r) for r in rows])
        finally:
            con.close()
        return self.send_error(404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/login":
            data = self._body()
            con = get_db()
            ident = (data.get("usuario") or data.get("email") or "").strip().lower()
            row = con.execute(
                "SELECT * FROM usuarios WHERE (lower(usuario)=? OR lower(email)=?)"
                " AND senha_sha256=?",
                (ident, ident, sha(data.get("senha") or ""))).fetchone()
            con.close()
            if row and row["aprovado"]:
                tok = secrets.token_hex(16)
                SESSIONS[tok] = row["id"]
                return self._json({"token": tok})
            return self._json({"erro": "credenciais inválidas ou acesso não aprovado"}, 401)
        if u.path == "/api/pedidos":
            data = self._body()
            if not data.get("nome") or not data.get("usuario"):
                return self._json({"erro": "nome e usuário desejado são obrigatórios"}, 400)
            email = (data.get("email") or "").strip().lower()
            if not email.endswith("@" + DOMINIO_INSTITUCIONAL):
                return self._json({"erro": "use seu e-mail institucional (@" + DOMINIO_INSTITUCIONAL + ")"}, 400)
            con = get_db()
            cur = con.execute(
                "INSERT INTO pedidos (nome, email, usuario_desejado, motivo,"
                " localidade_id) VALUES (?,?,?,?,?)",
                (data.get("nome"), data.get("email", ""),
                 data.get("usuario"), data.get("motivo", ""),
                 data.get("localidade_id") or None))
            log(con, "pedido", None,
                f"solicitação de acesso: {data.get('nome')} ({data.get('usuario')})")
            con.commit()
            con.close()
            return self._json({"ok": True, "id": cur.lastrowid}, 201)
        parts = u.path.rstrip("/").split("/")
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "pedidos" \
                and parts[4] == "aprovar":
            if not self._uid():
                return self._json({"erro": "não autenticado"}, 403)
            try:
                pid = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            con = get_db()
            ped = con.execute(
                "SELECT * FROM pedidos WHERE id=?", (pid,)).fetchone()
            if not ped or ped["status"] != "pendente":
                con.close()
                return self._json({"erro": "pedido não encontrado"}, 404)
            con.execute(
                "INSERT INTO usuarios (usuario, senha_sha256, aprovado, email)"
                " VALUES (?,?,1,?) ON CONFLICT(usuario) DO UPDATE SET aprovado=1,"
                " email=excluded.email",
                (ped["usuario_desejado"], sha(SENHA_INICIAL), ped["email"]))
            uid_novo = con.execute(
                "SELECT id FROM usuarios WHERE usuario=?",
                (ped["usuario_desejado"],)).fetchone()["id"]
            if ped["localidade_id"]:
                con.execute(
                    "INSERT INTO usuarios_locais (usuario_id, localidade_id)"
                    " VALUES (?,?) ON CONFLICT DO NOTHING",
                    (uid_novo, ped["localidade_id"]))
            con.execute("UPDATE pedidos SET status='aprovado' WHERE id=?", (pid,))
            log(con, "aprovar", None, f"acesso aprovado: {ped['usuario_desejado']}")
            con.commit()
            con.close()
            return self._json({"ok": True, "usuario": ped["usuario_desejado"],
                               "senha_inicial": SENHA_INICIAL})
        if u.path == "/api/contatos":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            data = self._body()
            if not data.get("nome") or not data.get("setor_id"):
                return self._json({"erro": "'nome' e 'setor_id' são obrigatórios"}, 400)
            con = get_db()
            loc = self._loc_de_setor(con, data.get("setor_id"))
            if loc is None or not self._pode(con, uid, loc):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
            cur = con.execute(
                "INSERT INTO contatos (setor_id, nome, cargo, telefone, email)"
                " VALUES (?,?,?,?,?)",
                (data.get("setor_id"), data.get("nome"), data.get("cargo", ""),
                 data.get("telefone", ""), data.get("email", "")))
            log(con, "criar", cur.lastrowid, f"criado: {data.get('nome')}")
            con.commit()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (cur.lastrowid,)).fetchone()
            con.close()
            return self._json(dict(row), 201)
        return self.send_error(404)

    def do_DELETE(self):
        parts = urllib.parse.urlparse(self.path).path.rstrip("/").split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "contatos":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
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
            if not self._pode(con, uid, self._loc_de_contato(con, cid)):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
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
    HTTPServer.allow_reuse_address = True
    print("Pública: http://localhost:8000  |  Admin: http://localhost:8000/admin"
          "  (demo: admin / admin123)")
    HTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
