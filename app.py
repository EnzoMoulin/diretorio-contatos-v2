"""Diretório Institucional de Contatos do PJES — reimplementação para portfólio.

Case real de estágio no TJES (MVP original em Google Apps Script + Sheets),
aqui reescrito em Python + SQLite como evolução da arquitetura, com a mesma
modelagem do original: comarca > fórum > unidade > setor > contatos.
Consulta pública + área administrativa com login + histórico de alterações
+ solicitação de acesso + navegação em camadas com mapa.
Comarcas reais do ES; fóruns/unidades/setores representativos; pessoas,
telefones e e-mails 100% fictícios. Nenhum dado real ou interno é utilizado.

Como rodar:
    python3 app.py
    -> pública: http://localhost:8000
    -> admin:   http://localhost:8000/admin  (demo: admin / admin123)

Endpoints (JSON):
    GET  /api/comarcas                        comarcas + contagens
    GET  /api/foruns?comarca_id=N
    GET  /api/unidades?forum_id=N
    GET  /api/setores?unidade_id=N
    GET  /api/contatos?q=&setor_id=&unidade_id=&forum_id=&comarca_id=
    GET  /api/historico                       requer token
    GET  /api/me                              requer token -> {usuario}
    POST /api/login                           {usuario, senha} -> {token}
    POST /api/contatos                        cria (token, no seu escopo)
    PUT  /api/contatos/<id>                   edita (token, no seu escopo)
    DELETE /api/contatos/<id>                 remove (token, no seu escopo)
    POST /api/pedidos                         {nome,email,usuario,motivo} (público)
    GET  /api/pedidos                         pendentes (token)
    POST /api/pedidos/<id>/aprovar            cria usuário (token)
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

NIVEIS = ("comarca", "forum", "unidade", "setor")

SCHEMA = """
CREATE TABLE IF NOT EXISTS comarcas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS foruns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comarca_id INTEGER NOT NULL REFERENCES comarcas(id),
    nome TEXT NOT NULL, endereco TEXT NOT NULL DEFAULT '',
    cep TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS unidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forum_id INTEGER NOT NULL REFERENCES foruns(id),
    nome TEXT NOT NULL, endereco TEXT NOT NULL DEFAULT '');
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
    admin INTEGER NOT NULL DEFAULT 0,
    email TEXT NOT NULL DEFAULT '');  -- compatível com USUARIOS.EMAIL
CREATE TABLE IF NOT EXISTS notificacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL,
    tipo TEXT NOT NULL DEFAULT 'info', texto TEXT NOT NULL DEFAULT '',
    lida INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS acessos (
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    nivel TEXT NOT NULL, -- 'comarca' | 'forum' | 'unidade' | 'setor'
    alvo_id INTEGER NOT NULL,
    PRIMARY KEY (usuario_id, nivel, alvo_id));
CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
    email TEXT NOT NULL, usuario_desejado TEXT NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    comarca_id INTEGER REFERENCES comarcas(id),
    nivel TEXT NOT NULL DEFAULT 'comarca', -- nível pedido
    alvo_id INTEGER,                          -- id no nível pedido
    status TEXT NOT NULL DEFAULT 'pendente',
    criado_em TEXT NOT NULL DEFAULT (datetime('now')));
"""

# (comarca, fórum, unidade, setor, nome, cargo, telefone, email)
# Comarcas reais do ES; fóruns/unidades/setores representativos (nomenclatura
# típica). Nomes de pessoas, telefones e e-mails 100% fictícios.
SEED = [
    ("Vitória", "Fórum Cível de Vitória", "1ª Vara Cível", "Atendimento", "Ana Souza", "Atendente",
     "(27) 3333-0001", "atendimento@exemplo.jus.br"),
    ("Vitória", "Fórum Cível de Vitória", "1ª Vara Cível", "Cartório", "Paulo Reis", "Técnico judiciário",
     "(27) 3333-0007", "paulo.reis@exemplo.jus.br"),
    ("Vitória", "Fórum Cível de Vitória", "2ª Vara Cível", "Atendimento", "Bruno Lima", "Técnico judiciário",
     "(27) 3333-0002", "bruno.lima@exemplo.jus.br"),
    ("Vitória", "Fórum Criminal de Vitória", "Vara Criminal", "Cartório", "Carla Dias", "Analista judiciária",
     "(27) 3333-0003", "criminal@exemplo.jus.br"),
    ("Vitória", "Fórum Criminal de Vitória", "Distribuição", "Atendimento", "Diego Rocha", "Distribuidor",
     "(27) 3333-0004", "distribuicao@exemplo.jus.br"),
    ("Vila Velha", "Fórum Des. Afonso Cláudio", "1ª Vara Cível", "Atendimento", "Elisa Prado", "Atendente",
     "(27) 3333-0005", "elisaprado@exemplo.jus.br"),
    ("Vila Velha", "Fórum Des. Afonso Cláudio", "1ª Vara Cível", "Gabinete", "Fabio Nunes", "Assessor",
     "(27) 3333-0006", "fabio.nunes@exemplo.jus.br"),
    ("Vila Velha", "Fórum Des. Afonso Cláudio", "2ª Vara Cível", "Cartório", "Gabi Moura", "Técnica judiciária",
     "(27) 3333-0008", "gabi.moura@exemplo.jus.br"),
    ("Serra", "Fórum Cível da Serra", "1ª Vara Cível", "Atendimento", "Hugo Alves", "Atendente",
     "(27) 3333-0009", "hugo.alves@exemplo.jus.br"),
    ("Serra", "Fórum Cível da Serra", "1ª Vara Cível", "Cartório", "Inês Castro", "Técnica judiciária",
     "(27) 3333-0010", "ines.castro@exemplo.jus.br"),
    ("Cariacica", "Fórum Cível de Cariacica", "1ª Vara Cível", "Cartório", "João Pinto", "Atendente",
     "(27) 3333-0011", "joao.pinto@exemplo.jus.br"),
    ("Cariacica", "Fórum Cível de Cariacica", "Juizado Especial Cível", "Atendimento", "Karla Mendes", "Conciliadora",
     "(27) 3333-0012", "karla.mendes@exemplo.jus.br"),
    ("Linhares", "Fórum Cível de Linhares", "1ª Vara Cível", "Atendimento", "Rui Barbosa", "Atendente",
     "(27) 3333-0013", "rui.barbosa@exemplo.jus.br"),
    ("Colatina", "Fórum Cível de Colatina", "1ª Vara Cível", "Atendimento", "Sofia Teles", "Atendente",
     "(27) 3333-0014", "sofia.teles@exemplo.jus.br"),
    ("Cachoeiro de Itapemirim", "Fórum Cível de Cachoeiro", "1ª Vara Cível", "Atendimento", "Tiago Pires", "Atendente",
     "(27) 3333-0015", "tiago.pires@exemplo.jus.br"),
    ("Guarapari", "Fórum Cível de Guarapari", "1ª Vara Cível", "Atendimento", "Ursula Faria", "Atendente",
     "(27) 3333-0016", "ursula.faria@exemplo.jus.br"),
]

SENHA_INICIAL = "bemvindo123"
# Domínio institucional fictício: equivale à checagem de e-mail institucional
# do sistema original (lá, sessão Google + intranet; aqui, login + domínio).
DOMINIO_INSTITUCIONAL = "exemplo.jus.br"


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def get_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


def _carregar_seed_json(con):
    """Seed a partir da base mascarada (seed_pjes.json). Devolve True se usou."""
    pj = BASE / "seed_pjes.json"
    if not pj.exists():
        return False
    seed = json.loads(pj.read_text(encoding="utf-8"))
    coms = {}
    for c in seed.get("comarcas", []):
        coms[c["id"]] = con.execute(
            "INSERT INTO comarcas (nome) VALUES (?)", (c["nome"],)).lastrowid
    fors = {}
    for f in seed.get("foruns", []):
        if f["comarca_id"] not in coms:
            continue
        fors[f["id"]] = con.execute(
            "INSERT INTO foruns (comarca_id, nome, endereco, cep) VALUES (?,?,?,?)",
            (coms[f["comarca_id"]], f["nome"], f.get("endereco", ""),
             f.get("cep", ""))).lastrowid
    uns = {}
    for u in seed.get("unidades", []):
        if u["forum_id"] not in fors:
            continue
        uns[u["id"]] = con.execute(
            "INSERT INTO unidades (forum_id, nome, endereco) VALUES (?,?,?)",
            (fors[u["forum_id"]], u["nome"], u.get("endereco", ""))).lastrowid
    # unidades/setores genéricos por fórum (contatos gerais + órfãos)
    auto_u, auto_s = {}, {}
    for fid in fors.values():
        uid = con.execute(
            "INSERT INTO unidades (forum_id, nome) VALUES (?,?)",
            (fid, "Atendimento geral")).lastrowid
        auto_u[fid] = uid
    sets = {}
    for s in seed.get("setores", []):
        if s["forum_id"] not in fors:
            continue
        uid = uns.get(s["unidade_id"])
        if uid is None:  # setor órfão -> cai nos gerais do fórum
            fdb = fors[s["forum_id"]]
            if fdb not in auto_s:
                auto_s[fdb] = con.execute(
                    "INSERT INTO setores (unidade_id, nome) VALUES (?,?)",
                    (auto_u[fdb], "Contatos gerais")).lastrowid
            uid = auto_u[fdb]
            sid = auto_s[fdb]
        else:
            sid = con.execute(
                "INSERT INTO setores (unidade_id, nome) VALUES (?,?)",
                (uid, s["nome"])).lastrowid
        sets[s["id"]] = sid
    import re as _re
    TIPO_COL = {"TELEFONE": "telefone", "EMAIL": "email", "RAMAL": "telefone",
                "WHATSAPP": "telefone"}
    for ct in seed.get("contatos", []):
        if ct["forum"] not in fors:
            continue
        fdb = fors[ct["forum"]]
        if ct.get("geral") or not ct.get("setor"):
            if fdb not in auto_s:
                auto_s[fdb] = con.execute(
                    "INSERT INTO setores (unidade_id, nome) VALUES (?,?)",
                    (auto_u[fdb], "Contatos gerais")).lastrowid
            sid = auto_s[fdb]
        else:
            sid = sets.get(ct["setor"])
            if sid is None:
                continue
        tnorm = _re.sub(r"[^A-Z]", "", str(ct.get("tipo", "")).upper())
        col = TIPO_COL.get(tnorm, "telefone")
        valor = ct.get("valor", "")
        nome = ct.get("desc", "") or valor
        con.execute(
            "INSERT INTO contatos (setor_id, nome, cargo, telefone, email)"
            " VALUES (?,?,?,?,?)",
            (sid, nome, str(ct.get("tipo", "")),
             valor if col == "telefone" else "",
             valor if col == "email" else ""))
    return True


def init_db():
    con = get_db()
    tabelas = {r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "localidades" in tabelas or "usuarios_locais" in tabelas:
        # esquema antigo (3 níveis) -> recria do zero (demo)
        con.executescript("""
            DROP TABLE IF EXISTS pedidos; DROP TABLE IF EXISTS usuarios;
            DROP TABLE IF EXISTS historico; DROP TABLE IF EXISTS contatos;
            DROP TABLE IF EXISTS setores; DROP TABLE IF EXISTS unidades;
            DROP TABLE IF EXISTS localidades; DROP TABLE IF EXISTS usuarios_locais;
            DROP TABLE IF EXISTS foruns; DROP TABLE IF EXISTS comarcas;
            DROP TABLE IF EXISTS acessos; DROP TABLE IF EXISTS notificacoes;
        """)
    con.executescript(SCHEMA)
    n = con.execute("SELECT COUNT(*) AS c FROM contatos").fetchone()["c"]
    if n == 0 and _carregar_seed_json(con):
        pass  # base mascarada completa
    elif n == 0:
        coms, fors, uns, sets = {}, {}, {}, {}
        for com, fr, un, st, nome, cargo, tel, mail in SEED:
            if com not in coms:
                coms[com] = con.execute(
                    "INSERT INTO comarcas (nome) VALUES (?)", (com,)).lastrowid
            key_f = (com, fr)
            if key_f not in fors:
                fors[key_f] = con.execute(
                    "INSERT INTO foruns (comarca_id, nome) VALUES (?,?)",
                    (coms[com], fr)).lastrowid
            key_u = (com, fr, un)
            if key_u not in uns:
                uns[key_u] = con.execute(
                    "INSERT INTO unidades (forum_id, nome) VALUES (?,?)",
                    (fors[key_f], un)).lastrowid
            key_s = (com, fr, un, st)
            if key_s not in sets:
                sets[key_s] = con.execute(
                    "INSERT INTO setores (unidade_id, nome) VALUES (?,?)",
                    (uns[key_u], st)).lastrowid
            con.execute(
                "INSERT INTO contatos (setor_id, nome, cargo, telefone, email)"
                " VALUES (?,?,?,?,?)", (sets[key_s], nome, cargo, tel, mail))
    if n == 0:
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email)"
            " VALUES (?,?,1,1,?) ON CONFLICT(usuario) DO NOTHING",
            ("admin", sha("admin123"), "admin@" + DOMINIO_INSTITUCIONAL))
        con.execute(
            "INSERT INTO historico (acao, detalhe) VALUES (?,?)",
            ("init", "base de demonstração criada com dados fictícios"))
    con.commit()
    con.close()


def log(con, acao, contato_id=None, detalhe=""):
    con.execute(
        "INSERT INTO historico (acao, contato_id, detalhe) VALUES (?,?,?)",
        (acao, contato_id, detalhe))

def notify(con, usuario_id, tipo, texto):
    con.execute(
        "INSERT INTO notificacoes (usuario_id, tipo, texto) VALUES (?,?,?)",
        (usuario_id, tipo, texto))

def admin_ids(con):
    return [r["id"] for r in con.execute(
        "SELECT id FROM usuarios WHERE admin=1 AND aprovado=1").fetchall()]


class Handler(BaseHTTPRequestHandler):
    server_version = "ContatosDemo/3.0"

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
        """Acessos do usuário: 'all' (admin) ou lista {nivel, alvo_id}."""
        u = self._user(con, uid)
        if not u or not u["aprovado"]:
            return None
        if u["admin"]:
            return "all"
        rows = con.execute(
            "SELECT nivel, alvo_id FROM acessos WHERE usuario_id=?",
            (uid,)).fetchall()
        return [dict(r) for r in rows]

    def _cadeia(self, con, setor_id=None, contato_id=None):
        """Resolve (comarca, forum, unidade, setor) de um setor ou contato."""
        base = ("SELECT c.id AS c, f.id AS f, u.id AS u, s.id AS s"
                " FROM comarcas c JOIN foruns f ON f.comarca_id=c.id"
                " JOIN unidades u ON u.forum_id=f.id"
                " JOIN setores s ON s.unidade_id=u.id")
        if contato_id is not None:
            r = con.execute(
                base + " JOIN contatos ct ON ct.setor_id=s.id WHERE ct.id=?",
                (contato_id,)).fetchone()
        else:
            r = con.execute(base + " WHERE s.id=?", (setor_id,)).fetchone()
        return ((r["c"], r["f"], r["u"], r["s"]) if r else (None,) * 4)

    def _pais(self, con, nivel, alvo_id):
        """Alvo + ancestrais (para herança de cima)."""
        if nivel == "comarca":
            return [("comarca", alvo_id)]
        if nivel == "forum":
            r = con.execute("SELECT comarca_id FROM foruns WHERE id=?",
                            (alvo_id,)).fetchone()
            out = [("forum", alvo_id)]
            if r:
                out.append(("comarca", r["comarca_id"]))
            return out
        if nivel == "unidade":
            r = con.execute(
                "SELECT f.id AS f, f.comarca_id AS c FROM unidades u"
                " JOIN foruns f ON f.id=u.forum_id WHERE u.id=?",
                (alvo_id,)).fetchone()
            out = [("unidade", alvo_id)]
            if r:
                out += [("forum", r["f"]), ("comarca", r["c"])]
            return out
        if nivel == "setor":
            r = con.execute(
                "SELECT u.id AS u, f.id AS f, f.comarca_id AS c FROM setores s"
                " JOIN unidades u ON u.id=s.unidade_id"
                " JOIN foruns f ON f.id=u.forum_id WHERE s.id=?",
                (alvo_id,)).fetchone()
            out = [("setor", alvo_id)]
            if r:
                out += [("unidade", r["u"]), ("forum", r["f"]),
                        ("comarca", r["c"])]
            return out
        return []

    def _cobre(self, con, uid, nivel, alvo_id):
        """O usuário pode editar o alvo? Herda de cima: comarca>forum>unidade>setor."""
        esc = self._escopo(con, uid)
        if esc is None:
            return False
        if esc == "all":
            return True
        tem = {(a["nivel"], a["alvo_id"]) for a in esc}
        return any(p in tem for p in self._pais(con, nivel, alvo_id))

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
            if u.path == "/api/comarcas":
                rows = con.execute(
                    "SELECT c.id, c.nome, COUNT(ct.id) AS total,"
                    " COUNT(DISTINCT f.id) AS n_foruns,"
                    " COUNT(DISTINCT u.id) AS n_unidades,"
                    " COUNT(DISTINCT s.id) AS n_setores FROM comarcas c"
                    " LEFT JOIN foruns f ON f.comarca_id=c.id"
                    " LEFT JOIN unidades u ON u.forum_id=f.id"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " GROUP BY c.id ORDER BY c.nome").fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/foruns":
                rows = con.execute(
                    "SELECT f.id, f.nome, f.comarca_id, f.endereco, f.cep,"
                    " COUNT(DISTINCT u.id) AS n_unidades,"
                    " COUNT(DISTINCT s.id) AS n_setores,"
                    " COUNT(ct.id) AS total FROM foruns f"
                    " LEFT JOIN unidades u ON u.forum_id=f.id"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE f.comarca_id=? GROUP BY f.id ORDER BY f.nome",
                    (arg("comarca_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/unidades":
                rows = con.execute(
                    "SELECT u.id, u.nome, u.forum_id, u.endereco,"
                    " COUNT(DISTINCT s.id) AS n_setores,"
                    " COUNT(ct.id) AS total FROM unidades u"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE u.forum_id=? GROUP BY u.id ORDER BY u.nome",
                    (arg("forum_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/setores":
                rows = con.execute(
                    "SELECT s.id, s.nome, s.unidade_id, COUNT(ct.id) AS total"
                    " FROM setores s LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE s.unidade_id=? GROUP BY s.id ORDER BY s.nome",
                    (arg("unidade_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/contatos":
                sql = ("SELECT ct.*, s.nome AS setor, s.id AS setor_id,"
                       " u.nome AS unidade, u.id AS unidade_id,"
                       " f.nome AS forum, f.id AS forum_id,"
                       " c.nome AS comarca, c.id AS comarca_id"
                       " FROM contatos ct JOIN setores s ON s.id=ct.setor_id"
                       " JOIN unidades u ON u.id=s.unidade_id"
                       " JOIN foruns f ON f.id=u.forum_id"
                       " JOIN comarcas c ON c.id=f.comarca_id WHERE 1=1")
                params = []
                for key, col in (("setor_id", "ct.setor_id"),
                                 ("unidade_id", "u.id"),
                                 ("forum_id", "f.id"),
                                 ("comarca_id", "c.id")):
                    if arg(key):
                        sql += f" AND {col}=?"
                        params.append(arg(key))
                if arg("q"):
                    like = f"%{arg('q')}%"
                    sql += (" AND (ct.nome LIKE ? OR ct.cargo LIKE ? OR ct.telefone LIKE ?"
                            " OR ct.email LIKE ? OR s.nome LIKE ? OR u.nome LIKE ?"
                            " OR f.nome LIKE ? OR c.nome LIKE ?)")
                    params += [like] * 8
                sql += " ORDER BY ct.nome"
                rows = con.execute(sql, params).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/resumo":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                por_for = con.execute(
                    "SELECT f.id, f.nome, f.comarca_id, c.nome AS comarca,"
                    " COUNT(ct.id) AS total FROM foruns f"
                    " JOIN comarcas c ON c.id=f.comarca_id"
                    " LEFT JOIN unidades u ON u.forum_id=f.id"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " GROUP BY f.id ORDER BY c.nome, f.nome").fetchall()
                por_uni = con.execute(
                    "SELECT u.id, u.nome, u.forum_id, COUNT(ct.id) AS total"
                    " FROM unidades u"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " GROUP BY u.id ORDER BY u.nome").fetchall()
                por_set = con.execute(
                    "SELECT s.id, s.nome, s.unidade_id, COUNT(ct.id) AS total"
                    " FROM setores s LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " GROUP BY s.id ORDER BY s.nome").fetchall()
                ult = con.execute(
                    "SELECT * FROM historico ORDER BY id DESC LIMIT 5").fetchall()
                pend = con.execute(
                    "SELECT COUNT(*) AS c FROM pedidos"
                    " WHERE status='pendente'").fetchone()["c"]
                return self._json({
                    "por_forum": [dict(r) for r in por_for],
                    "por_unidade": [dict(r) for r in por_uni],
                    "por_setor": [dict(r) for r in por_set],
                    "ultimos": [dict(r) for r in ult],
                    "pendentes": pend})
            if u.path == "/api/notificacoes":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                rows = con.execute(
                    "SELECT * FROM notificacoes WHERE usuario_id=?"
                    " ORDER BY id DESC LIMIT 30", (uid,)).fetchall()
                lista = [dict(r) for r in rows]
                return self._json({
                    "lista": lista,
                    "nao_lidas": sum(1 for r in lista if not r["lida"])})
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
                    "SELECT id, usuario, email, admin FROM usuarios WHERE id=?",
                    (uid,)).fetchone()
                if not row:
                    return self._json({"erro": "não autenticado"}, 403)
                me = dict(row)
                esc = self._escopo(con, uid)
                me["escopo"] = "all" if esc == "all" else (esc or [])
                return self._json(me)
            if u.path == "/api/pedidos":
                if not self._uid():
                    return self._json({"erro": "não autenticado"}, 403)
                rows = con.execute(
                    "SELECT p.*, c.nome AS comarca FROM pedidos p"
                    " LEFT JOIN comarcas c ON c.id=p.comarca_id"
                    " WHERE p.status='pendente' ORDER BY p.id DESC").fetchall()
                nomes = {"comarca": "comarcas", "forum": "foruns",
                         "unidade": "unidades", "setor": "setores"}
                saida = []
                for r in rows:
                    d = dict(r)
                    d["alvo_nome"] = None
                    if d.get("alvo_id") and d.get("nivel") in nomes:
                        t = con.execute(
                            f"SELECT nome FROM {nomes[d['nivel']]} WHERE id=?",
                            (d["alvo_id"],)).fetchone()
                        d["alvo_nome"] = t["nome"] if t else None
                    saida.append(d)
                return self._json(saida)
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
            if not data.get("nome"):
                return self._json({"erro": "nome é obrigatório"}, 400)
            email = (data.get("email") or "").strip().lower()
            if not email.endswith("@" + DOMINIO_INSTITUCIONAL):
                return self._json({"erro": "use seu e-mail institucional (@" + DOMINIO_INSTITUCIONAL + ")"}, 400)
            usuario = (data.get("usuario") or "").strip() or email.split("@")[0]
            con = get_db()
            nivel = (data.get("nivel") or "comarca").strip().lower()
            if nivel not in NIVEIS:
                nivel = "comarca"
            try:
                alvo = int(data.get("alvo_id") or data.get("comarca_id") or 0) or None
            except (TypeError, ValueError):
                alvo = None
            # comarca do alvo (para exibir ao admin)
            com_id = data.get("comarca_id") or None
            if alvo:
                pais = self._pais(con, nivel, alvo)
                for nv, aid in pais:
                    if nv == "comarca":
                        com_id = aid
                        break
            cur = con.execute(
                "INSERT INTO pedidos (nome, email, usuario_desejado, motivo,"
                " comarca_id, nivel, alvo_id) VALUES (?,?,?,?,?,?,?)",
                (data.get("nome"), data.get("email", ""),
                 usuario, data.get("motivo", ""),
                 com_id, nivel, alvo))
            for aid in admin_ids(con):
                nivel_txt = {"comarca": "comarca", "forum": "fórum",
                             "unidade": "unidade", "setor": "setor"}.get(nivel, nivel)
                notify(con, aid, "solicitacao",
                       f"Nova solicitação de {data.get('nome')} ({usuario}):"
                       f" {nivel_txt} id {alvo or '-'}")
            log(con, "pedido", None,
                f"solicitação de acesso: {data.get('nome')} ({usuario})")
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
            if ped["comarca_id"] and not ped["alvo_id"]:
                con.execute(
                    "INSERT INTO acessos (usuario_id, nivel, alvo_id)"
                    " VALUES (?, 'comarca', ?) ON CONFLICT DO NOTHING",
                    (uid_novo, ped["comarca_id"]))
            if ped["alvo_id"]:
                con.execute(
                    "INSERT INTO acessos (usuario_id, nivel, alvo_id)"
                    " VALUES (?,?,?) ON CONFLICT DO NOTHING",
                    (uid_novo, ped["nivel"] or "comarca", ped["alvo_id"]))
            con.execute("UPDATE pedidos SET status='aprovado' WHERE id=?", (pid,))
            log(con, "aprovar", None, f"acesso aprovado: {ped['usuario_desejado']}")
            notify(con, uid_novo, "aprovada",
                   "Seu acesso foi aprovado. Senha inicial: " + SENHA_INICIAL)
            con.commit()
            con.close()
            return self._json({"ok": True, "usuario": ped["usuario_desejado"],
                               "senha_inicial": SENHA_INICIAL})
        if u.path == "/api/notificacoes/lidas":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            con = get_db()
            con.execute("UPDATE notificacoes SET lida=1 WHERE usuario_id=?",
                        (uid,))
            con.commit()
            con.close()
            return self._json({"ok": True})
        parts = urllib.parse.urlparse(self.path).path.rstrip("/").split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "notificacoes" \
                and parts[3] == "lida":
            # POST /api/notificacoes/lida {"id": N}
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            data = self._body()
            con = get_db()
            con.execute("UPDATE notificacoes SET lida=1 WHERE id=? AND usuario_id=?",
                        (data.get("id"), uid))
            con.commit()
            con.close()
            return self._json({"ok": True})
        if u.path == "/api/me/senha":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            data = self._body()
            nova = (data.get("nova") or "")
            if len(nova) < 6:
                return self._json({"erro": "nova senha precisa de 6+ caracteres"}, 400)
            con = get_db()
            row = con.execute(
                "SELECT * FROM usuarios WHERE id=?", (uid,)).fetchone()
            if not row or row["senha_sha256"] != sha(data.get("atual") or ""):
                con.close()
                return self._json({"erro": "senha atual incorreta"}, 401)
            con.execute("UPDATE usuarios SET senha_sha256=? WHERE id=?",
                        (sha(nova), uid))
            con.commit()
            con.close()
            return self._json({"ok": True})
        if u.path == "/api/contatos":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            data = self._body()
            if not data.get("nome") or not data.get("setor_id"):
                return self._json({"erro": "'nome' e 'setor_id' são obrigatórios"}, 400)
            con = get_db()
            try:
                sid = int(data.get("setor_id") or 0)
            except (TypeError, ValueError):
                con.close()
                return self._json({"erro": "setor inválido"}, 400)
            if not self._cobre(con, uid, "setor", sid):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
            cur = con.execute(
                "INSERT INTO contatos (setor_id, nome, cargo, telefone, email)"
                " VALUES (?,?,?,?,?)",
                (data.get("setor_id"), data.get("nome"), data.get("cargo", ""),
                 data.get("telefone", ""), data.get("email", "")))
            log(con, "criar", cur.lastrowid, f"criado: {data.get('nome')}")
            for aid in admin_ids(con):
                notify(con, aid, "contato",
                       f"Contato criado: {data.get('nome')}")
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
            if not self._cobre(con, uid, "setor", self._cadeia(con, contato_id=cid)[3] or 0):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
            if self.command == "PUT":
                data = self._body()
                if not data.get("nome"):
                    con.close()
                    return self._json({"erro": "'nome' é obrigatório"}, 400)
                con.execute(
                    "UPDATE contatos SET nome=?, cargo=?, telefone=?, email=?"
                    " WHERE id=?",
                    (data.get("nome"), data.get("cargo", ""),
                     data.get("telefone", ""), data.get("email", ""), cid))
                log(con, "editar", cid, f"editado: {data.get('nome')}")
                for aid in admin_ids(con):
                    notify(con, aid, "contato",
                           f"Contato editado: {data.get('nome')}")
                con.commit()
                row = con.execute(
                    "SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
                con.close()
                return self._json(dict(row))
            con.execute("DELETE FROM contatos WHERE id=?", (cid,))
            log(con, "remover", cid, f"removido: {row['nome']}")
            for aid in admin_ids(con):
                notify(con, aid, "contato",
                       f"Contato removido: {row['nome']}")
            con.commit()
            con.close()
            return self._json({"ok": True})
        return self.send_error(404)

    do_PUT = do_DELETE

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    init_db()
    HTTPServer.allow_reuse_address = True
    print("Pública: http://localhost:8000  |  Admin: http://localhost:8000/admin"
          "  (demo: admin / admin123)")
    HTTPServer(("127.0.0.1", 8000), Handler).serve_forever()
