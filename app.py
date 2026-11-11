"""Diretório de Contatos — reimplementação para portfólio.

Case real de estágio em tribunal estadual (MVP original em Google Apps Script + Sheets),
aqui reescrito em Python + SQLite como evolução da arquitetura, com a mesma
modelagem do original: comarca > fórum > unidade > setor > contatos.
Consulta pública + área administrativa com login + histórico de alterações
+ solicitação de acesso + navegação em camadas com mapa.
Comarcas reais do ES; fóruns/unidades/setores representativos; pessoas,
telefones e e-mails 100% fictícios. Nenhum dado real ou interno é utilizado.

Como rodar:
    python3 app.py
    -> pública: http://localhost:8000
    -> admin:   http://localhost:8000/admin  (login com Google)

Autenticação: identidade via Google OAuth (sem senha, como o privado do v1).
Entrada aberta: qualquer conta Google vira visitante; locais e gestão saem
por aprovação do administrador. SIMULACAO_AUTO_APROVAR=1 aprova o pedido na
hora (é o modo da execução local e dos testes); o demo público sobe com 0, ou
seja, somente leitura. Admin vem só da allowlist ADMIN_EMAILS (vazia =
ninguém é admin). Intranet representada: /admin só abre de localhost/rede local
(INTRANET_ONLY=1). Credencial em GOOGLE_CLIENT_FILE
(padrão: ~/.hermes/google_client_secret.json).

Endpoints (JSON):
    GET  /oauth/login                         inicia login com Google
    GET  /oauth/callback                      retorno do Google -> sessão
    POST /api/logout                          encerra sessão (token)
    GET  /api/comarcas                        comarcas + contagens
    GET  /api/foruns?comarca_id=N
    GET  /api/unidades?forum_id=N
    GET  /api/setores?unidade_id=N
    GET  /api/contatos?q=&setor_id=&unidade_id=&forum_id=&comarca_id=
    GET  /api/contatos/<id>                   um contato (token, no seu escopo)
    GET  /api/historico                       requer token
    GET  /api/historico/mensal                requer token de admin -> {meses, acoes}
    GET  /api/me                              requer token -> {usuario}
    POST /api/login                           {usuario, senha} -> {token}
    POST /api/contatos                        cria (token, no seu escopo)
    PUT  /api/contatos/<id>                   edita (token, no seu escopo)
    DELETE /api/contatos/<id>                 remove (token, no seu escopo)
    POST /api/pedidos                         {nome,email,usuario,motivo} (público)
    GET  /api/pedidos                         pendentes (token)
    POST /api/pedidos/<id>/aprovar            cria usuário (token)
"""

import functools
import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).parent
DB = BASE / "contatos.db"
FRONT = BASE / "frontend"

SESSIONS = {}  # token -> usuario_id (memória local)
OAUTH_STATES = {}  # state -> expiração (login Google)


def _podar_oauth_states(limite=5000):
    """Descarta states expirados; o dicionário crescia sem limite."""
    agora = time.time()
    for chave in [k for k, exp in OAUTH_STATES.items() if exp < agora]:
        OAUTH_STATES.pop(chave, None)
    excesso = len(OAUTH_STATES) - limite
    if excesso > 0:
        for chave in list(OAUTH_STATES)[:excesso]:
            OAUTH_STATES.pop(chave, None)

SIMULACAO_AUTO_APROVAR = os.environ.get("SIMULACAO_AUTO_APROVAR", "0") == "1"

# Allowlist de admin: só os e-mails listados aqui ganham admin no primeiro login.
# Vazio (padrão) = ninguém vira admin automaticamente. Nunca usar "primeiro que
# logar vira admin": num demo público isso entrega a gestão a qualquer conta.
ADMIN_EMAILS = {
    e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()
}

# Base pública do app (links em e-mails). Em hospedagem, definir APP_BASE_URL
# com a URL pública (ex. https://diretorio-contatos-v2.onrender.com).
APP_BASE_URL = os.environ.get("APP_BASE_URL", "http://localhost:8000").rstrip("/")

GOOGLE_CLIENT_FILE = os.environ.get("GOOGLE_CLIENT_FILE") or str(
    Path.home() / ".hermes" / "google_client_secret.json")


def google_client():
    """Lê client_id/secret do OAuth Google (arquivo local, nunca commitado).

    Em hospedagem, usa GOOGLE_CLIENT_JSON (JSON inline do client OAuth tipo
    'web'); localmente, lê GOOGLE_CLIENT_FILE.
    """
    raw = os.environ.get("GOOGLE_CLIENT_JSON", "").strip()
    if raw:
        try:
            d = json.loads(raw)
            cfg = d.get("installed") or d.get("web") or {}
            if cfg.get("client_id"):
                return cfg
        except ValueError:
            pass
    try:
        d = json.load(open(GOOGLE_CLIENT_FILE, encoding="utf-8"))
        cfg = d.get("installed") or d.get("web") or {}
        if cfg.get("client_id"):
            return cfg
    except (OSError, ValueError):
        pass
    return {}


def _oauth_redirect_base(handler):
    """Base https atrás de proxy (Render) ou http local.

    Hospedagem HTTPS termina o TLS no proxy e avisa via X-Forwarded-Proto;
    o redirect_uri precisa sair com o mesmo esquema registrado no Google.
    """
    host = (handler.headers.get("Host") or "localhost:8000").strip()
    proto = (handler.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
    scheme = proto if proto in ("http", "https") else "http"
    return f"{scheme}://{host}/oauth/callback"

NIVEIS = ("comarca", "forum", "unidade", "setor")

INTRANET_ONLY = os.environ.get("INTRANET_ONLY", "1") == "1"

# Login local (usuário/senha) é porta de desenvolvimento e testes.
# Produção usa só Google: rode com LOCAL_LOGIN=0.
LOCAL_LOGIN = os.environ.get("LOCAL_LOGIN", "1") == "1"

GOOGLE_TEST_EMAILS = {
    e.strip().lower()
    for e in os.environ.get("GOOGLE_TEST_EMAILS", "").replace(";", ",").split(",")
    if e.strip()
}


def aprovar_pedido(con, pid, automatico=False, autor_id=None):
    """Efetiva a aprovação de um pedido: cria/libera o usuário e concede o
    escopo pedido. Não fecha a conexão. Retorna (ok, payload, status).

    `autor_id` é quem aprovou (o admin da sessão). Fica None na aprovação
    automática da simulação, que não tem pessoa por trás.
    """
    ped = con.execute("SELECT * FROM pedidos WHERE id=?", (pid,)).fetchone()
    if not ped or ped["status"] != "pendente":
        return False, {"erro": "pedido não encontrado"}, 404
    if ped["nivel"] == "admin" and not ped["alvo_id"] \
            and str(ped["email"] or "").strip().lower() not in ADMIN_EMAILS:
        # Admin nunca nasce de pedido: só da allowlist. O pedido fica pendente.
        return False, {"erro": "Perfil de Administrador só é concedido ao dono "
                               "do ambiente (allowlist ADMIN_EMAILS)."}, 403
    # Concede o acesso ao solicitante identificado no pedido — nunca por nome
    # vindo do corpo. Sem id (pedidos antigos), resolve pelo e-mail da sessão.
    email_ped = str(ped["email"] or "").strip().lower()
    uid_novo = None
    try:
        uid_ped = ped["usuario_id"]
    except (IndexError, KeyError):
        uid_ped = None
    if uid_ped:
        linha = con.execute(
            "SELECT id, lower(email) AS em FROM usuarios WHERE id=?",
            (uid_ped,)).fetchone()
        if linha and str(linha["em"] or "") == email_ped:
            uid_novo = linha["id"]
    if uid_novo is None and email_ped:
        linha = con.execute(
            "SELECT id FROM usuarios WHERE lower(email)=?", (email_ped,)).fetchone()
        uid_novo = linha["id"] if linha else None
    if uid_novo is None:
        base = (email_ped.split("@")[0] or "usuario").strip().lower()[:40] or "usuario"
        nome_novo, n = base, 1
        while con.execute("SELECT 1 FROM usuarios WHERE usuario=?",
                          (nome_novo,)).fetchone():
            n += 1
            nome_novo = "%s%d" % (base, n)
        uid_novo = con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, email)"
            " VALUES (?,?,1,?)",
            (nome_novo, gerar_hash("google-oauth:" + secrets.token_hex(16)),
             email_ped)).lastrowid
    else:
        con.execute("UPDATE usuarios SET aprovado=1 WHERE id=?", (uid_novo,))
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
    if ped["nivel"] == "admin" and not ped["alvo_id"]:
        con.execute("UPDATE usuarios SET admin=1 WHERE id=?", (uid_novo,))
    con.execute("UPDATE pedidos SET status='aprovado' WHERE id=?", (pid,))
    nome_final = con.execute("SELECT usuario FROM usuarios WHERE id=?",
                             (uid_novo,)).fetchone()["usuario"]
    marca = " (aprovação automática — avaliação)" if automatico else ""
    log(con, "aprovar", None, f"acesso aprovado: {nome_final}{marca}", autor_id)
    texto_aprov = ("Seu acesso foi aprovado. Entre com sua conta Google." +
                   (" (Aprovação automática para avaliação.)" if automatico else ""))
    notify(con, uid_novo, "aprovada", texto_aprov)
    if not automatico:
        _send_email(ped["email"], "Acesso liberado — Diretório de Contatos",
                    f"Olá {ped['nome']},\n\nSeu acesso foi liberado pelo administrador.\n"
                    f"Entre com sua conta Google: {APP_BASE_URL}/admin")
    con.commit()
    return True, {"ok": True, "usuario": nome_final}, 200


def recusar_pedido(con, pid, motivo, autor_id=None):
    """Recusa um pedido com motivo obrigatório; notifica se o e-mail já é usuário."""
    motivo = (motivo or "").strip()[:500]
    if not motivo:
        return False, {"erro": "informe o motivo da rejeição"}, 400
    ped = con.execute("SELECT * FROM pedidos WHERE id=?", (pid,)).fetchone()
    if not ped or ped["status"] != "pendente":
        return False, {"erro": "pedido não encontrado"}, 404
    con.execute("UPDATE pedidos SET status='recusado', motivo_recusa=? WHERE id=?", (motivo, pid))
    log(con, "recusar", None, f"pedido recusado: {ped['usuario_desejado']} — {motivo}",
        autor_id)
    row = con.execute("SELECT id FROM usuarios WHERE lower(email)=?", (str(ped["email"]).lower(),)).fetchone()
    if row:
        notify(con, row["id"], "recusada",
               f"Sua solicitação de acesso não foi aprovada. Motivo: {motivo}")
    _send_email(ped["email"], "Solicitação de acesso — Diretório de Contatos",
                f"Olá {ped['nome']},\n\nSua solicitação de acesso não foi aprovada.\nMotivo: {motivo}\n\nSe precisar, fale com o administrador.")
    con.commit()
    return True, {"ok": True}, 200


def _ip_rede_local(ip):
    """Representa a intranet para avaliação: só loopback e redes privadas alcançam o /admin."""
    try:
        import ipaddress
        addr = ipaddress.ip_address(ip)
        return addr.is_loopback or addr.is_private
    except ValueError:
        return False

SCHEMA = """
CREATE TABLE IF NOT EXISTS comarcas (
    id TEXT PRIMARY KEY, nome TEXT NOT NULL UNIQUE,
    ordem_num REAL, ordem_idx INTEGER NOT NULL DEFAULT 0,
    codigo_ibge TEXT NOT NULL DEFAULT '', tipo TEXT NOT NULL DEFAULT '',
    endereco TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', observacao TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS foruns (
    id TEXT PRIMARY KEY,
    comarca_id TEXT NOT NULL REFERENCES comarcas(id),
    nome TEXT NOT NULL, endereco TEXT NOT NULL DEFAULT '',
    cep TEXT NOT NULL DEFAULT '', ordem_num REAL,
    ordem_idx INTEGER NOT NULL DEFAULT 0,
    email TEXT NOT NULL DEFAULT '', observacao TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS unidades (
    id TEXT PRIMARY KEY,
    forum_id TEXT REFERENCES foruns(id),
    comarca_id TEXT REFERENCES comarcas(id),
    nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'UNIDADE',
    endereco TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
    observacao TEXT NOT NULL DEFAULT '',
    selecionavel INTEGER NOT NULL DEFAULT 0,
    ordem_num REAL, ordem_idx INTEGER NOT NULL DEFAULT 0,
    virtual INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS setores (
    id TEXT PRIMARY KEY,
    unidade_id TEXT NOT NULL REFERENCES unidades(id),
    nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'SETOR',
    endereco TEXT NOT NULL DEFAULT '', cep TEXT NOT NULL DEFAULT '',
    observacao TEXT NOT NULL DEFAULT '',
    selecionavel INTEGER NOT NULL DEFAULT 0,
    ordem_num REAL, ordem_idx INTEGER NOT NULL DEFAULT 0,
    virtual INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contatos (
    id TEXT PRIMARY KEY,
    setor_id TEXT NOT NULL REFERENCES setores(id),
    nome TEXT NOT NULL, cargo TEXT NOT NULL DEFAULT '',
    telefone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
    descricao TEXT NOT NULL DEFAULT '',
    observacao TEXT NOT NULL DEFAULT '',
    -- procedência do dado: qual documento trouxe o valor e de quando ele é.
    -- No v1/v2 isso vivia como texto livre em `observacao` ("Contato provisório
    -- — validar vigência."), que não filtra, não ordena e não expira.
    fonte TEXT NOT NULL DEFAULT '',
    vigente_desde TEXT NOT NULL DEFAULT '',
    -- conferência: quando alguém olhou o dado e disse "continua valendo".
    -- Separado de `vigente_desde`: aquele é de quando o documento é; este é de
    -- quando uma pessoa conferiu. Um não substitui o outro — o ofício de 2024
    -- continua sendo de 2024 depois de reconferido hoje.
    conferido_em TEXT NOT NULL DEFAULT '',
    conferido_por TEXT NOT NULL DEFAULT '',
    ordem_num REAL, ordem_idx INTEGER NOT NULL DEFAULT 0,
    atualizado_em TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS uteis (
    id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL DEFAULT '',
    nome TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT '',
    valor TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS historico (
    id INTEGER PRIMARY KEY AUTOINCREMENT, acao TEXT NOT NULL,
    contato_id TEXT, detalhe TEXT NOT NULL DEFAULT '',
    usuario_id INTEGER REFERENCES usuarios(id),  -- autor; NULL = sem gente
    autor_nome TEXT NOT NULL DEFAULT '',        -- retrato do nome na hora
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
    alvo_id TEXT NOT NULL,
    PRIMARY KEY (usuario_id, nivel, alvo_id));
CREATE TABLE IF NOT EXISTS pedidos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
    email TEXT NOT NULL, usuario_desejado TEXT NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    comarca_id TEXT REFERENCES comarcas(id),
    nivel TEXT NOT NULL DEFAULT 'comarca', -- nível pedido
    alvo_id TEXT,                          -- id no nível pedido
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


def gerar_hash(senha):
    """PBKDF2-HMAC-SHA256 com salt aleatório. Formato: pbkdf2$iter$salt$hex."""
    import os as _os
    salt = _os.urandom(16).hex()
    dk = hashlib.pbkdf2_hmac("sha256", str(senha or "").encode("utf-8"),
                             bytes.fromhex(salt), 210_000)
    return f"pbkdf2$210000${salt}${dk.hex()}"


def confere_senha(guardada, senha):
    """Confere PBKDF2; aceita o legado sha256 puro (para migração)."""
    g = str(guardada or "")
    if g.startswith("pbkdf2$"):
        try:
            _, it, salt, hexd = g.split("$")
            dk = hashlib.pbkdf2_hmac("sha256", str(senha or "").encode("utf-8"),
                                     bytes.fromhex(salt), int(it))
            return dk.hex() == hexd
        except Exception:
            return False
    return g == sha(senha)


def precisa_upgrade_hash(guardada):
    return not str(guardada or "").startswith("pbkdf2$")


@functools.lru_cache(maxsize=1)
def _hierarquia_montada():
    con = get_db()
    try:
        return json.dumps(build_hierarquia(con), ensure_ascii=False)
    finally:
        con.close()


def hierarquia_resposta(handler):
    corpo = _hierarquia_montada().encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(corpo)))
    handler.end_headers()
    handler.wfile.write(corpo)


def invalidar_hierarquia():
    _hierarquia_montada.cache_clear()


def _send_email(to_addrs, subject, body):
    """E-mail real via SMTP (env SMTP_HOST/PORT/USER/PASS/FROM). Sem SMTP
    configurado, retorna False e o aviso fica só dentro do sistema."""
    host = os.environ.get("SMTP_HOST", "")
    if not host:
        return False
    try:
        import smtplib
        from email.mime.text import MIMEText
        port = int(os.environ.get("SMTP_PORT", "587"))
        user = os.environ.get("SMTP_USER", "")
        pwd = os.environ.get("SMTP_PASS", "")
        dests = to_addrs if isinstance(to_addrs, list) else [to_addrs]
        msg = MIMEText(body, "plain", "utf-8")
        msg["Subject"] = subject
        msg["From"] = os.environ.get("SMTP_FROM", user)
        msg["To"] = ", ".join(dests)
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.starttls()
            if user:
                s.login(user, pwd)
            s.send_message(msg)
        return True
    except Exception:
        return False


def get_db():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    return con


_CONT = {}
_CONT_LOCK = threading.Lock()

def novo_id(con, tabela, prefixo):
    """Próximo id global (prefixo + sequência), ex.: U12, S3, C1491."""
    with _CONT_LOCK:
        if (tabela, prefixo) not in _CONT:
            mx = 0
            try:
                linhas = con.execute("SELECT id FROM %s" % tabela).fetchall()
            except Exception:
                linhas = []
            for (v,) in linhas:
                s = str(v)
                if s.startswith(prefixo):
                    s = s[len(prefixo):]
                if s.isdigit():
                    mx = max(mx, int(s))
            _CONT[(tabela, prefixo)] = mx
        _CONT[(tabela, prefixo)] += 1
        return "%s%d" % (prefixo, _CONT[(tabela, prefixo)])

def _carregar_seed_legado(con, seed):
    """Formato antigo: sem suporte no esquema atual."""
    return False
    coms = {}
    for c in seed.get("comarcas", []):
        coms[c["id"]] = con.execute(
            "INSERT INTO comarcas (nome, ordem) VALUES (?,?)",
            (c["nome"], c.get("ordem", 0))).lastrowid
    fors = {}
    for f in seed.get("foruns", []):
        if f["comarca_id"] not in coms:
            continue
        fors[f["id"]] = con.execute(
            "INSERT INTO foruns (comarca_id, nome, endereco, cep, ordem)"
            " VALUES (?,?,?,?,?)",
            (coms[f["comarca_id"]], f["nome"], f.get("endereco", ""),
             f.get("cep", ""), f.get("ordem", 0))).lastrowid
    uns = {}
    for u in seed.get("unidades", []):
        if u["forum_id"] not in fors:
            continue
        uns[u["id"]] = con.execute(
            "INSERT INTO unidades (forum_id, nome, endereco, ordem)"
            " VALUES (?,?,?,?)",
            (fors[u["forum_id"]], u["nome"], u.get("endereco", ""),
             u.get("ordem", 0))).lastrowid
    # auto sob demanda: unidade "Atendimento geral" + setor "Contatos Gerais"
    auto_u, auto_s, auto_su = {}, {}, {}

    def _auto_unidade(fdb, ordem):
        if fdb not in auto_u:
            auto_u[fdb] = con.execute(
                "INSERT INTO unidades (forum_id, nome, ordem, virtual)"
                " VALUES (?,?,?,1)",
                (fdb, "Atendimento geral", ordem)).lastrowid
        return auto_u[fdb]

    def _auto_setor_geral(fdb):
        if fdb not in auto_s:
            auto_s[fdb] = con.execute(
                "INSERT INTO setores (unidade_id, nome, ordem, virtual)"
                " VALUES (?,?,?,1)",
                (_auto_unidade(fdb, 10 ** 9), "Contatos Gerais", 10 ** 9)).lastrowid
        return auto_s[fdb]

    def _auto_setor_unidade(udb):
        if udb not in auto_su:
            auto_su[udb] = con.execute(
                "INSERT INTO setores (unidade_id, nome, ordem, virtual)"
                " VALUES (?,?,?,1)",
                (udb, "Contatos Gerais", 10 ** 9)).lastrowid
        return auto_su[udb]

    sets = {}
    for s in seed.get("setores", []):
        if s["forum_id"] not in fors:
            continue
        uid = uns.get(s["unidade_id"])
        if uid is None:  # órfão com contato: vira card sob Atendimento geral
            uid = _auto_unidade(fors[s["forum_id"]], s.get("ordem", 0))
        sets[s["id"]] = con.execute(
            "INSERT INTO setores (unidade_id, nome, ordem) VALUES (?,?,?)",
            (uid, s["nome"], s.get("ordem", 0))).lastrowid
    import re as _re
    TIPO_COL = {"TELEFONE": "telefone", "EMAIL": "email", "RAMAL": "telefone",
                "WHATSAPP": "telefone"}
    for ct in seed.get("contatos", []):
        if ct["forum"] not in fors:
            continue
        fdb = fors[ct["forum"]]
        if ct.get("setor") and ct["setor"] in sets:
            sid = sets[ct["setor"]]
        elif ct.get("unidade") and ct["unidade"] in uns:
            sid = _auto_setor_unidade(uns[ct["unidade"]])
        else:
            sid = _auto_setor_geral(fdb)
        tnorm = _re.sub(r"[^A-Z]", "", str(ct.get("tipo", "")).upper())
        col = TIPO_COL.get(tnorm, "telefone")
        valor = ct.get("valor", "")
        nome = ct.get("desc", "") or valor
        con.execute(
            "INSERT INTO contatos (setor_id, nome, cargo, telefone, email, ordem)"
            " VALUES (?,?,?,?,?,?)",
            (sid, nome, str(ct.get("tipo", "")),
             valor if col == "telefone" else "",
             valor if col == "email" else "",
             ct.get("ordem", 0)))
    return True



# Procedência do contato: o que o documento de origem diz, em rótulo curto e data.
# No seed a única pista é a observação em texto livre; aqui ela vira campo.
PROCEDENCIA = (
    ("agosto/2026", "catálogo de ramais — agosto/2026", "2026-08-28"),
    ("provis", "ofício 432/2024 — diretoria do foro", "2024-03-01"),
)


def _procedencia(obs):
    """(fonte, vigente_desde) a partir da observação livre do seed."""
    o = (obs or "").lower()
    for marca, rotulo, data in PROCEDENCIA:
        if marca in o:
            return rotulo, data
    return "", ""


def _procedencia_preencher(con):
    """Preenche fonte/vigente_desde vazias. Idempotente e não destrutiva.

    Roda a cada boot: só toca linha com `fonte` vazio, então edição manual
    (que grava `edição manual`) nunca é sobrescrita. Linha sem observação de
    documento recebe o rótulo neutro — não se inventa data de vigência.
    """
    for marca, rotulo, data in PROCEDENCIA:
        con.execute(
            "UPDATE contatos SET fonte=?, vigente_desde=?"
            " WHERE COALESCE(fonte,'')='' AND lower(COALESCE(observacao,'')) LIKE ?",
            (rotulo, data, f"%{marca}%"))
    con.execute(
        "UPDATE contatos SET fonte='base do sistema (sem documento declarado)'"
        " WHERE COALESCE(fonte,'')=''")


def _carregar_seed_json(con):
    """Seed a partir da base mascarada (seed_mascarado.json). Devolve True se usou."""
    pj = BASE / "seed_mascarado.json"
    if not pj.exists():
        return False
    seed = json.loads(pj.read_text(encoding="utf-8"))
    if "nos" not in seed:
        return _carregar_seed_legado(con, seed)
    coms = {}
    for i, c in enumerate(seed.get("comarcas", [])):
        nid = novo_id(con, "comarcas", "M")
        con.execute(
            "INSERT INTO comarcas (id, nome, ordem_num, ordem_idx, codigo_ibge,"
            " tipo, endereco, cep, email, observacao)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (nid, c["nome"], c.get("ordem"), i, c.get("ibge", ""),
             c.get("tipo", ""), c.get("end", ""), c.get("cep", ""),
             c.get("email", ""), c.get("obs", "")))
        coms[c["id"]] = nid
    fors = {}
    for i, f in enumerate(seed.get("foruns", [])):
        if f["comarca_id"] not in coms:
            continue
        nid = novo_id(con, "foruns", "F")
        con.execute(
            "INSERT INTO foruns (id, comarca_id, nome, endereco, cep, ordem_num,"
            " ordem_idx, email, observacao) VALUES (?,?,?,?,?,?,?,?,?)",
            (nid, coms[f["comarca_id"]], f["nome"], f.get("end", ""),
             f.get("cep", ""), f.get("ordem"), i, f.get("email", ""),
             f.get("obs", "")))
        fors[f["id"]] = nid
    node_db, node_kind, node_row = {}, {}, {}
    for i, no in enumerate(seed.get("nos", [])):
        if not no.get("ativo", True):
            continue
        fdb = fors.get(no["forum"])
        mdb = coms.get(no["comarca"]) if not fdb else None
        if fdb is None and mdb is None:
            continue
        if no["pai"]:
            continue  # filhos na segunda passada
        uid = novo_id(con, "unidades", "U")
        con.execute(
            "INSERT INTO unidades (id, forum_id, comarca_id, nome, tipo,"
            " endereco, cep, observacao, selecionavel, ordem_num, ordem_idx)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uid, fdb, mdb, no["nome"], no.get("tipo", "UNIDADE") or "UNIDADE",
             no.get("end", ""), no.get("cep", ""), no.get("obs", ""),
             1 if no.get("sel") else 0, no.get("ordem"), i))
        node_db[no["id"]] = uid
        node_kind[no["id"]] = "u"
        node_row[no["id"]] = no
    for i, no in enumerate(seed.get("nos", [])):
        if not no.get("ativo", True) or not no["pai"]:
            continue
        p = None
        n = no
        seen = set()
        while n and n["id"] not in seen:
            seen.add(n["id"])
            if n["id"] in node_db and node_kind[n["id"]] == "u":
                p = n["id"]
                break
            pn = next((x for x in seed.get("nos", []) if x["id"] == n["pai"]), None)
            n = pn
        if p is None:
            continue
        sid = novo_id(con, "setores", "S")
        con.execute(
            "INSERT INTO setores (id, unidade_id, nome, tipo, endereco, cep,"
            " observacao, selecionavel, ordem_num, ordem_idx)"
            " VALUES (?,?,?,?,?,?,?,?,?,?)",
            (sid, node_db[p], no["nome"], no.get("tipo", "SETOR") or "SETOR",
             no.get("end", ""), no.get("cep", ""), no.get("obs", ""),
             1 if no.get("sel") else 0, no.get("ordem"), i))
        node_db[no["id"]] = sid
        node_kind[no["id"]] = "s"
        node_row[no["id"]] = no
    auto_u, auto_s = {}, {}

    def _auto_unidade(fdb, mdb):
        key = ("f", fdb) if fdb else ("m", mdb)
        if key not in auto_u:
            nid = novo_id(con, "unidades", "U")
            con.execute(
                "INSERT INTO unidades (id, forum_id, comarca_id, nome,"
                " ordem_num, virtual) VALUES (?,?,?,?,NULL,1)",
                (nid, fdb, mdb, "Atendimento geral"))
            auto_u[key] = nid
        return auto_u[key]

    def _auto_setor(udb):
        if udb not in auto_s:
            nid = novo_id(con, "setores", "S")
            con.execute(
                "INSERT INTO setores (id, unidade_id, nome, ordem_num, virtual)"
                " VALUES (?,?,?,NULL,1)",
                (nid, udb, "Contatos Gerais"))
            auto_s[udb] = nid
        return auto_s[udb]

    import re as _re
    TIPO_COL = {"TELEFONE": "telefone", "EMAIL": "email", "RAMAL": "telefone",
                "WHATSAPP": "telefone", "FAX": "telefone", "CELULAR": "telefone"}
    for i, ct in enumerate(seed.get("contatos", [])):
        alvo = ct.get("uo") or ""  # UO-only: vínculo é o nó da árvore
        kind = node_kind.get(alvo)
        if kind == "s":
            sid, dono = node_db[alvo], ("s", node_db[alvo])
        elif kind == "u":
            sid, dono = _auto_setor(node_db[alvo]), ("u", node_db[alvo])
        else:
            fdb = fors.get(ct.get("forum"))
            mkey = ct.get("comarca")
            if fdb:
                sid, dono = _auto_setor(_auto_unidade(fdb, None)), ("f", fdb)
            elif mkey and mkey in coms:
                sid = _auto_setor(_auto_unidade(None, coms[mkey]))
                dono = ("m", coms[mkey])
            else:
                continue
        tnorm = _re.sub(r"[^A-Z]", "", str(ct.get("tipo", "")).upper())
        col = TIPO_COL.get(tnorm, "telefone")
        valor = ct.get("valor", "")
        nome = ct.get("desc", "") or valor
        fonte, vigente = _procedencia(ct.get("obs", ""))
        con.execute(
            "INSERT INTO contatos (id, setor_id, nome, cargo, telefone, email,"
            " descricao, observacao, fonte, vigente_desde, ordem_num, ordem_idx)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (novo_id(con, "contatos", "C"), sid, nome, str(ct.get("tipo", "")),
             valor if col == "telefone" else "",
             valor if col == "email" else "", ct.get("desc", ""),
             ct.get("obs", ""), fonte or "base do sistema (sem documento declarado)",
             vigente, ct.get("ordem"), i))
    for u in seed.get("uteis", []):
        con.execute("INSERT INTO uteis (uid, nome, tipo, valor) VALUES (?,?,?,?)",
                    (u.get("id", ""), u.get("nome", ""), u.get("tipo", ""), u.get("valor", "")))
    return True


def _ordem(r):
    n = r["ordem_num"]
    if n is None:
        return (2, r["ordem_idx"])
    try:
        return (0, float(n))
    except (TypeError, ValueError):
        return (2, r["ordem_idx"])


def build_hierarquia(con):
    """Monta o JSON aninhado no formato do backend original (GAS)."""
    coms = [dict(r) for r in con.execute("SELECT * FROM comarcas")]
    fors = [dict(r) for r in con.execute("SELECT * FROM foruns")]
    unis = [dict(r) for r in con.execute("SELECT * FROM unidades")]
    sets = [dict(r) for r in con.execute("SELECT * FROM setores")]
    cts = [dict(r) for r in con.execute("SELECT * FROM contatos")]
    set_by_unidade = {}
    for s in sets:
        set_by_unidade.setdefault(s["unidade_id"], []).append(s)
    ct_por_setor = {}
    for c in cts:
        ct_por_setor.setdefault(c["setor_id"], []).append(c)
    for lst in ct_por_setor.values():
        lst.sort(key=_ordem)
    # setor auto "Contatos Gerais" de cada unidade auto -> dono (forum/comarca)
    gerais_por_forum, gerais_por_mun = {}, {}
    for u in unis:
        if not u["virtual"]:
            continue
        for s in set_by_unidade.get(u["id"], []):
            if not s["virtual"]:
                continue
            dest = (gerais_por_forum if u["forum_id"] else gerais_por_mun)
            dest.setdefault(u["forum_id"] or u["comarca_id"], []).extend(
                ct_por_setor.get(s["id"], []))
    for lst in gerais_por_forum.values():
        lst.sort(key=_ordem)
    for lst in gerais_por_mun.values():
        lst.sort(key=_ordem)

    def contato_pub(c, no_id=""):
        return {"id": c["id"], "tipo": c["cargo"], "descricao": c["descricao"],
                "valor": c["telefone"] or c["email"], "observacao": c["observacao"],
                "conferido_em": c["conferido_em"] if "conferido_em" in c.keys() else "",
                "conferido_por": c["conferido_por"] if "conferido_por" in c.keys() else "",
                "fonte": c["fonte"] if "fonte" in c.keys() else "",
                "vigente_desde": c["vigente_desde"] if "vigente_desde" in c.keys() else ""}

    def ser_no(u, raiz_end, raiz_cep):
        end_ex = u["endereco"] or raiz_end
        cep_ex = u["cep"] or raiz_cep
        pai_ex = {"enderecoExibicao": end_ex, "cepExibicao": cep_ex}
        filhos = sorted(
            (s for s in set_by_unidade.get(u["id"], []) if not s["virtual"]),
            key=_ordem)
        out_filhos = [ser_no_filho(s, pai_ex, raiz_end, raiz_cep) for s in filhos]
        auto_id = next((s["id"] for s in set_by_unidade.get(u["id"], [])
                        if s["virtual"]), None)
        diretos = [contato_pub(c) for c in ct_por_setor.get(auto_id, [])]
        qtd = len(diretos) + sum(f["qtdContatos"] for f in out_filhos)
        return {"id": u["id"], "tipo": u["tipo"], "nome": u["nome"],
                "endereco": u["endereco"], "cep": u["cep"],
                "enderecoExibicao": end_ex, "cepExibicao": cep_ex,
                "observacao": u["observacao"],
                "selecionavelAcesso": bool(u["selecionavel"]),
                "contatos": diretos, "filhos": out_filhos,
                "qtdFilhos": len(out_filhos),
                "qtdNos": 1 + sum(f["qtdNos"] for f in out_filhos),
                "qtdContatos": qtd}

    def ser_no_filho(s, pai, raiz_end, raiz_cep):
        diretos = [contato_pub(c) for c in ct_por_setor.get(s["id"], [])]
        end_ex = s["endereco"] or (pai.get("enderecoExibicao") if isinstance(pai, dict) else "") or raiz_end
        cep_ex = s["cep"] or (pai.get("cepExibicao") if isinstance(pai, dict) else "") or raiz_cep
        return {"id": s["id"], "tipo": s["tipo"], "nome": s["nome"],
                "endereco": s["endereco"], "cep": s["cep"],
                "enderecoExibicao": end_ex, "cepExibicao": cep_ex,
                "observacao": s["observacao"],
                "selecionavelAcesso": bool(s["selecionavel"]),
                "contatos": diretos, "filhos": [],
                "qtdFilhos": 0, "qtdNos": 1,
                "qtdContatos": len(diretos)}

    def cont_sel(lista):
        return sum(1 for n in lista if n["selecionavelAcesso"])

    comarcas = []
    for c in sorted((x for x in coms), key=_ordem):
        f_do = sorted((f for f in fors
                       if f["comarca_id"] == c["id"]), key=_ordem)
        foruns_pub = []
        for f in f_do:
            roots = sorted(
                (u for u in unis if u["forum_id"] == f["id"]
                 and not u["virtual"]),
                key=_ordem)
            nos = [ser_no(u, f["endereco"], f["cep"])
                   for u in roots]
            gerais = [contato_pub(x) for x in gerais_por_forum.get(f["id"], [])]
            foruns_pub.append({
                "id": f["id"], "nome": f["nome"], "endereco": f["endereco"],
                "cep": f["cep"], "email": f["email"],
                "observacao": f.get("observacao", ""),
                "qtdNos": sum(n["qtdNos"] for n in nos),
                "qtdUnidades": cont_sel(nos),
                "qtdContatos": len(gerais) + sum(n["qtdContatos"] for n in nos),
                "contatos": gerais, "nos": nos})
        roots_m = sorted(
            (u for u in unis if u["comarca_id"] == c["id"]
             and not u["virtual"]),
            key=_ordem)
        nos_m = [ser_no(u, c["endereco"], c["cep"])
                 for u in roots_m]
        gerais_m = [contato_pub(x) for x in gerais_por_mun.get(c["id"], [])]
        comarcas.append({
            "id": c["id"], "nome": c["nome"], "codigoIbge": c["codigo_ibge"],
            "tipo": c["tipo"], "endereco": c["endereco"], "cep": c["cep"],
            "email": c["email"], "observacao": c["observacao"],
            "qtdForuns": len(foruns_pub),
            "qtdUnidades": cont_sel(nos_m) + sum(f["qtdUnidades"] for f in foruns_pub),
            "qtdContatos": len(gerais_m) + sum(n["qtdContatos"] for n in nos_m) + sum(f["qtdContatos"] for f in foruns_pub),
            "contatos": gerais_m, "nos": nos_m, "foruns": foruns_pub})
    uteis = [{"id": u["uid"], "nome": u["nome"], "tipo": u["tipo"], "valor": u["valor"]}
             for u in con.execute("SELECT uid, nome, tipo, valor FROM uteis ORDER BY id").fetchall()]
    return {"comarcas": comarcas, "uteis": uteis}


def init_fts(con):
    """FTS5 sobre contatos (busca + autocomplete). Idempotente."""
    con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS contatos_fts USING fts5("
                "nome, cargo, valor, contato_id UNINDEXED, tokenize='unicode61')")
    con.executescript("""
        CREATE TRIGGER IF NOT EXISTS trg_ct_fts_ins AFTER INSERT ON contatos BEGIN
            INSERT INTO contatos_fts (nome, cargo, valor, contato_id)
            VALUES (NEW.nome, NEW.cargo, NEW.telefone || ' ' || NEW.email, NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_ct_fts_del AFTER DELETE ON contatos BEGIN
            DELETE FROM contatos_fts WHERE contato_id=OLD.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_ct_fts_upd AFTER UPDATE ON contatos BEGIN
            DELETE FROM contatos_fts WHERE contato_id=OLD.id;
            INSERT INTO contatos_fts (nome, cargo, valor, contato_id)
            VALUES (NEW.nome, NEW.cargo, NEW.telefone || ' ' || NEW.email, NEW.id);
        END;
    """)
    n_fts = con.execute("SELECT COUNT(*) FROM contatos_fts").fetchone()[0]
    n_ct = con.execute("SELECT COUNT(*) FROM contatos").fetchone()[0]
    if n_ct and not n_fts:
        con.execute("INSERT INTO contatos_fts (nome, cargo, valor, contato_id)"
                    " SELECT nome, cargo, telefone || ' ' || email, id FROM contatos")
        con.commit()


def _unificar_emails(con):
    """Um usuário por e-mail: a linha mais privilegiada fica com ele.

    O login Google procura por lower(email); sem unicidade, duas linhas com o
    mesmo e-mail deixavam o resultado depender da ordem da tabela. Duplicatas
    antigas perdem o e-mail (e ficam registradas no histórico)."""
    try:
        dup = con.execute(
            "SELECT lower(email) AS em, COUNT(*) AS n FROM usuarios"
            " WHERE TRIM(COALESCE(email,''))<>''"
            " GROUP BY lower(email) HAVING n>1").fetchall()
    except Exception:
        return
    for r in dup:
        linhas = con.execute(
            "SELECT id, usuario FROM usuarios WHERE lower(email)=?"
            " ORDER BY admin DESC, aprovado DESC, id ASC", (r["em"],)).fetchall()
        if not linhas:
            continue
        dono = linhas[0]
        for extra in linhas[1:]:
            con.execute("UPDATE usuarios SET email='' WHERE id=?", (extra["id"],))
            try:
                con.execute(
                    "INSERT INTO historico (acao, detalhe) VALUES (?,?)",
                    ("email_duplicado",
                     "e-mail %s removido de %s (mantido em %s)"
                     % (r["em"], extra["usuario"], dono["usuario"])))
            except Exception:
                pass
    try:
        con.execute("CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_email"
                    " ON usuarios(lower(email)) WHERE TRIM(email)<>''")
    except Exception:
        pass


# Histórico de demonstração: no ambiente público o banco é recriado a cada boot,
# então a trilha nasceria vazia e o gráfico mensal — que é a leitura da trilha —
# apareceria zerado para quem visita o demo. Estas linhas são fictícias, gravadas
# UMA vez na criação do banco, em datas relativas ao boot: data fixa envelheceria
# e deixaria o gráfico vazio de novo dentro de um ano.
MARCA_DEMO = "demonstração"

# (meses atrás, quantas alterações). Dois meses ficam zerados de propósito: o mês
# sem alteração é informação (o gráfico mostra o trilho) e é o que o teste da
# janela de 12 meses exercita.
DEMO_HISTORICO = (
    (11, 2), (10, 3), (9, 1), (8, 4), (7, 0), (6, 2),
    (5, 5), (4, 0), (3, 3), (2, 6), (1, 4), (0, 2),
)
# Ação -> detalhe neutro. Nenhum nome de pessoa, nenhum dado real: o detalhe
# declara que é demonstração, e o autor da linha também.
DEMO_ACOES = (
    ("editar", "contato de demonstração atualizado"),
    ("aprovar", "acesso de demonstração aprovado"),
    ("criar", "contato de demonstração incluído"),
    ("pedido", "pedido de acesso de demonstração"),
    ("backup", "backup do banco (demonstração)"),
)


def _mes_atras(atras):
    """(ano, mês) de N meses atrás, no mesmo calendário do /api/historico/mensal."""
    hoje = time.localtime()
    ano, mes = hoje.tm_year, hoje.tm_mon - atras
    while mes <= 0:
        mes += 12
        ano -= 1
    return ano, mes


def _historico_demonstracao(con):
    """Grava a trilha fictícia do demo e devolve quantas linhas criou.

    Chamada só quando o banco está nascendo; a marca (`autor_nome`) protege
    contra rodar duas vezes — base existente nunca é tocada, então o histórico
    de quem já usa o app não ganha linha inventada.
    """
    if con.execute("SELECT 1 FROM historico WHERE autor_nome=? LIMIT 1",
                   (MARCA_DEMO,)).fetchone():
        return 0
    n = 0
    hoje = time.localtime()
    for atras, quantas in DEMO_HISTORICO:
        ano, mes = _mes_atras(atras)
        for i in range(quantas):
            acao, detalhe = DEMO_ACOES[n % len(DEMO_ACOES)]
            dia = 5 + (i * 7) % 20
            if atras == 0:
                # Mês em curso: nada de alteração datada no futuro.
                dia = min(dia, hoje.tm_mday)
            con.execute(
                "INSERT INTO historico (acao, contato_id, detalhe, usuario_id,"
                " autor_nome, data) VALUES (?,NULL,?,NULL,?,?)",
                (acao, detalhe, MARCA_DEMO,
                 "%04d-%02d-%02d %02d:%02d:00"
                 % (ano, mes, dia, 9 + (i % 8), (i * 13) % 60)))
            n += 1
    return n


def init_db():
    con = get_db()
    tabelas = {r["name"] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    precisa_migrar = ("localidades" in tabelas or "usuarios_locais" in tabelas)
    if "unidades" in tabelas and not precisa_migrar:
        try:
            con.execute("SELECT comarca_id FROM unidades LIMIT 1")
        except Exception:
            precisa_migrar = True
    if precisa_migrar:
        # esquema antigo -> recria do zero (uso local)
        con.executescript("""
            DROP TABLE IF EXISTS pedidos; DROP TABLE IF EXISTS usuarios;
            DROP TABLE IF EXISTS historico; DROP TABLE IF EXISTS contatos;
            DROP TABLE IF EXISTS setores; DROP TABLE IF EXISTS unidades;
            DROP TABLE IF EXISTS localidades; DROP TABLE IF EXISTS usuarios_locais;
            DROP TABLE IF EXISTS foruns; DROP TABLE IF EXISTS comarcas;
            DROP TABLE IF EXISTS acessos; DROP TABLE IF EXISTS notificacoes;
        """)
    con.executescript(SCHEMA)
    for _tbl, _col, _ddl in [
        ("pedidos", "motivo_recusa", "ALTER TABLE pedidos ADD COLUMN motivo_recusa TEXT NOT NULL DEFAULT ''"),
        ("usuarios", "ultimo_login", "ALTER TABLE usuarios ADD COLUMN ultimo_login TEXT NOT NULL DEFAULT ''"),
        ("usuarios", "ativo", "ALTER TABLE usuarios ADD COLUMN ativo INTEGER NOT NULL DEFAULT 1"),
        ("pedidos", "usuario_id", "ALTER TABLE pedidos ADD COLUMN usuario_id INTEGER"),
        ("historico", "usuario_id", "ALTER TABLE historico ADD COLUMN usuario_id INTEGER REFERENCES usuarios(id)"),
        ("historico", "autor_nome", "ALTER TABLE historico ADD COLUMN autor_nome TEXT NOT NULL DEFAULT ''"),
        ("contatos", "fonte", "ALTER TABLE contatos ADD COLUMN fonte TEXT NOT NULL DEFAULT ''"),
        ("contatos", "vigente_desde", "ALTER TABLE contatos ADD COLUMN vigente_desde TEXT NOT NULL DEFAULT ''"),
        ("contatos", "conferido_em", "ALTER TABLE contatos ADD COLUMN conferido_em TEXT NOT NULL DEFAULT ''"),
        ("contatos", "conferido_por", "ALTER TABLE contatos ADD COLUMN conferido_por TEXT NOT NULL DEFAULT ''"),
    ]:
        try:
            nomes = {r[1] for r in con.execute(f"PRAGMA table_info({_tbl})").fetchall()}
            if _col not in nomes:
                con.execute(_ddl)
        except Exception:
            pass
    _procedencia_preencher(con)
    _unificar_emails(con)
    n = con.execute("SELECT COUNT(*) AS c FROM contatos").fetchone()["c"]
    if n == 0 and _carregar_seed_json(con):
        pass  # base mascarada completa
    elif n == 0:
        coms, fors, uns, sets = {}, {}, {}, {}
        for com, fr, un, st, nome, cargo, tel, mail in SEED:
            if com not in coms:
                nid = novo_id(con, "comarcas", "M")
                con.execute("INSERT INTO comarcas (id, nome) VALUES (?,?)",
                            (nid, com))
                coms[com] = nid
            key_f = (com, fr)
            if key_f not in fors:
                nid = novo_id(con, "foruns", "F")
                con.execute("INSERT INTO foruns (id, comarca_id, nome) VALUES (?,?,?)",
                            (nid, coms[com], fr))
                fors[key_f] = nid
            key_u = (com, fr, un)
            if key_u not in uns:
                nid = novo_id(con, "unidades", "U")
                con.execute("INSERT INTO unidades (id, forum_id, nome) VALUES (?,?,?)",
                            (nid, fors[key_f], un))
                uns[key_u] = nid
            key_s = (com, fr, un, st)
            if key_s not in sets:
                nid = novo_id(con, "setores", "S")
                con.execute("INSERT INTO setores (id, unidade_id, nome) VALUES (?,?,?)",
                            (nid, uns[key_u], st))
                sets[key_s] = nid
            con.execute(
                "INSERT INTO contatos (id, setor_id, nome, cargo, telefone, email)"
                " VALUES (?,?,?,?,?,?)",
                (novo_id(con, "contatos", "C"), sets[key_s], nome, cargo, tel, mail))
    if n == 0:
        con.execute(
            "INSERT INTO usuarios (usuario, senha_sha256, aprovado, admin, email)"
            " VALUES (?,?,1,1,?) ON CONFLICT(usuario) DO NOTHING",
            ("admin", gerar_hash("admin123"), "admin@" + DOMINIO_INSTITUCIONAL))
        con.execute(
            "INSERT INTO historico (acao, detalhe) VALUES (?,?)",
            ("init", "base inicial criada com dados fictícios"))
        # Banco acabou de nascer: o gráfico mensal ganha a trilha de demonstração
        # em vez de abrir zerado (no demo público o banco renasce a cada boot).
        _historico_demonstracao(con)
    init_fts(con)
    con.commit()
    con.close()


def eh_admin(con, uid):
    """True quando o usuário da sessão é admin (a linha pode ter sumido)."""
    linha = con.execute("SELECT admin FROM usuarios WHERE id=?", (uid,)).fetchone()
    return bool(linha and linha[0])


def log(con, acao, contato_id=None, detalhe="", usuario_id=None):
    """Registra auditoria. `usuario_id` é quem fez a ação; None quando não há
    pessoa por trás (base inicial, aprovação automática da simulação).

    Grava também o nome do autor no momento da ação: apagar o usuário depois
    não pode apagar a história de quem fez o quê.
    """
    autor_nome = ""
    if usuario_id:
        linha = con.execute(
            "SELECT usuario FROM usuarios WHERE id=?", (usuario_id,)).fetchone()
        if linha:
            autor_nome = linha["usuario"]
    con.execute(
        "INSERT INTO historico (acao, contato_id, detalhe, usuario_id, autor_nome)"
        " VALUES (?,?,?,?,?)",
        (acao, contato_id, detalhe, usuario_id, autor_nome))

def notify(con, usuario_id, tipo, texto):
    con.execute(
        "INSERT INTO notificacoes (usuario_id, tipo, texto) VALUES (?,?,?)",
        (usuario_id, tipo, texto))

def admin_ids(con):
    return [r["id"] for r in con.execute(
        "SELECT id FROM usuarios WHERE admin=1 AND aprovado=1").fetchall()]


# Uma linha por contato com o caminho até a comarca — base da lista plana
# (/api/contatos) e da busca de um contato só (/api/contatos/<id>).
# A unidade sem fórum (a estrutura central) não tem comarca vinda do fórum:
# o COALESCE cai na comarca da própria unidade, senão esses contatos somem.
CAMPOS_CONTATO = (
    "SELECT ct.id, ct.nome, ct.cargo, ct.telefone, ct.email,"
    " ct.descricao, ct.fonte, ct.vigente_desde,"
    " ct.conferido_em, ct.conferido_por,"
    " s.nome AS setor, s.id AS setor_id, s.virtual AS setor_virtual,"
    " u.nome AS unidade, u.id AS unidade_id, u.virtual AS unidade_virtual,"
    " f.nome AS forum, f.id AS forum_id,"
    " c.nome AS comarca, c.id AS comarca_id"
    " FROM contatos ct JOIN setores s ON s.id=ct.setor_id"
    " JOIN unidades u ON u.id=s.unidade_id"
    " LEFT JOIN foruns f ON f.id=u.forum_id"
    " LEFT JOIN comarcas c ON c.id=COALESCE(f.comarca_id, u.comarca_id)")


class Handler(BaseHTTPRequestHandler):
    server_version = "DiretorioContatos/3.0"

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
        # `?v=` é o hash curto do próprio arquivo (ver
        # scripts/atualizar-cache-busting.py): se bate, esta URL nunca muda de
        # conteúdo e o navegador pode guardar para sempre. O HTML fica com
        # no-cache — é ele que carrega o `?v=` novo, então a troca de versão
        # chega na próxima abertura sem F5 forçado.
        versao = (urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).get("v") or [""])[0]
        if name.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        elif versao and versao == hashlib.sha256(body).hexdigest()[:8]:
            self.send_header("Cache-Control",
                             "public, max-age=%d, immutable" % (60 * 60 * 24 * 365))
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
        tok = self.headers.get("X-Admin-Token") or self._cookie("tc_session") or ""
        return SESSIONS.get(tok)

    def _https(self):
        """True quando a requisição chegou por HTTPS (proxy do Render)."""
        proto = (self.headers.get("X-Forwarded-Proto") or "").strip().lower()
        return proto == "https" or self.headers.get("X-Forwarded-Ssl") == "on"

    def _cookie_sessao(self, tok, max_age=43200):
        seguro = "; Secure" if self._https() else ""
        return ("tc_session=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s"
                % (tok, max_age, seguro))

    def _cookie(self, name):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == name:
                return v
        return ""

    def _page(self, status, title, msg):
        body = (f"<!DOCTYPE html><html lang='pt-BR'><head><meta charset='utf-8'>"
                f"<title>{title}</title></head>"
                f"<body style='font-family:sans-serif;padding:40px;max-width:640px'>"
                f"<h1>{title}</h1><p>{msg}</p>"
                f"<p><a href='/admin'>Voltar ao acesso interno</a></p>"
                f"</body></html>").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

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
        """Resolve (comarca, forum, unidade, setor) de um setor ou contato.

        Unidade sem fórum (a estrutura central) não tem fórum nem comarca
        vindos do fórum: o caminho continua pela comarca da própria unidade.
        """
        base = ("SELECT c.id AS c, f.id AS f, u.id AS u, s.id AS s"
                " FROM setores s JOIN unidades u ON u.id=s.unidade_id"
                " LEFT JOIN foruns f ON f.id=u.forum_id"
                " LEFT JOIN comarcas c"
                " ON c.id=COALESCE(f.comarca_id, u.comarca_id)")
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
                "SELECT f.id AS f,"
                " COALESCE(f.comarca_id, u.comarca_id) AS c FROM unidades u"
                " LEFT JOIN foruns f ON f.id=u.forum_id WHERE u.id=?",
                (alvo_id,)).fetchone()
            out = [("unidade", alvo_id)]
            if r:
                if r["f"]:
                    out.append(("forum", r["f"]))
                if r["c"]:
                    out.append(("comarca", r["c"]))
            return out
        if nivel == "setor":
            r = con.execute(
                "SELECT u.id AS u, f.id AS f,"
                " COALESCE(f.comarca_id, u.comarca_id) AS c FROM setores s"
                " JOIN unidades u ON u.id=s.unidade_id"
                " LEFT JOIN foruns f ON f.id=u.forum_id WHERE s.id=?",
                (alvo_id,)).fetchone()
            out = [("setor", alvo_id)]
            if r:
                out.append(("unidade", r["u"]))
                if r["f"]:
                    out.append(("forum", r["f"]))
                if r["c"]:
                    out.append(("comarca", r["c"]))
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
        if u.path == "/healthz":
            # Health check da hospedagem: responde antes de tocar em banco ou seed,
            # para um seed lento não ser lido como serviço morto (que reinicia e
            # recria o banco efêmero).
            return self._json({"status": "ok"})
        if u.path in ("/", "/public.html"):
            return self._static("public.html", "text/html; charset=utf-8")
        if u.path == "/admin":
            if INTRANET_ONLY and not _ip_rede_local(self.client_address[0]):
                return self._page(403, "Restrito à intranet",
                                   "O acesso interno só abre dentro da rede interna. "
                                   "Este é o controle de intranet no v2 (no original, a URL "
                                   "privada só resolve dentro da rede). Para desligar, "
                                   "rode com INTRANET_ONLY=0.")
            return self._static("admin.html", "text/html; charset=utf-8")
        if u.path in ("/public.js", "/admin.js", "/mapa.js"):
            return self._static(u.path[1:], "application/javascript; charset=utf-8")
        if u.path == "/style.css":
            return self._static("style.css", "text/css; charset=utf-8")
        if u.path == "/oauth/login":
            cfg = google_client()
            if not cfg.get("client_id"):
                return self._page(500, "Login Google não configurado",
                                   "Defina GOOGLE_CLIENT_JSON (hospedagem) ou "
                                   "GOOGLE_CLIENT_FILE (local) com um client OAuth válido.")
            redir = _oauth_redirect_base(self)
            _podar_oauth_states()
            st = secrets.token_urlsafe(24)
            OAUTH_STATES[st] = time.time() + 600
            q = urllib.parse.urlencode({
                "client_id": cfg["client_id"], "redirect_uri": redir,
                "response_type": "code", "scope": "openid email profile",
                "state": st, "prompt": "select_account"})
            self.send_response(302)
            self.send_header("Location",
                             "https://accounts.google.com/o/oauth2/v2/auth?" + q)
            self.end_headers()
            return
        if u.path == "/oauth/callback":
            q = urllib.parse.parse_qs(u.query)
            code = (q.get("code") or [""])[0]
            st = (q.get("state") or [""])[0]
            if not code or not st or OAUTH_STATES.pop(st, 0) < time.time():
                return self._page(400, "Login expirado",
                                   "A sessão de login expirou. Tente entrar de novo.")
            cfg = google_client()
            redir = _oauth_redirect_base(self)
            try:
                treq = urllib.request.Request(
                    "https://oauth2.googleapis.com/token",
                    data=urllib.parse.urlencode({
                        "code": code, "client_id": cfg.get("client_id", ""),
                        "client_secret": cfg.get("client_secret", ""),
                        "redirect_uri": redir,
                        "grant_type": "authorization_code"}).encode(),
                    method="POST")
                with urllib.request.urlopen(treq, timeout=30) as r:
                    tdata = json.load(r)
                ureq = urllib.request.Request(
                    "https://openidconnect.googleapis.com/v1/userinfo",
                    headers={"Authorization": "Bearer " + tdata["access_token"]})
                with urllib.request.urlopen(ureq, timeout=30) as r:
                    ui = json.load(r)
            except Exception:
                return self._page(502, "Falha no Google",
                                   "Não foi possível validar a conta. Tente de novo.")
            email = str(ui.get("email") or "").strip().lower()
            if not email or ui.get("email_verified") is False:
                return self._page(403, "E-mail não verificado",
                                   "Use uma conta Google com e-mail verificado.")
            con = get_db()
            try:
                row = con.execute(
                    "SELECT * FROM usuarios WHERE lower(email)=? AND aprovado=1",
                    (email,)).fetchone()
                if not row:
                    # Sem cadastro: entra como visitante (só consulta). Admin vem
                    # exclusivamente da allowlist ADMIN_EMAILS.
                    base = email.split("@")[0]
                    nm, i = base, 0
                    while con.execute(
                            "SELECT 1 FROM usuarios WHERE usuario=?",
                            (nm,)).fetchone():
                        i += 1
                        nm = f"{base}{i}"
                    con.execute(
                        "INSERT INTO usuarios (usuario, senha_sha256, aprovado,"
                        " admin, email) VALUES (?,?,?,?,?)",
                        (nm, gerar_hash("google-oauth:" + secrets.token_hex(16)), 1,
                         1 if email in ADMIN_EMAILS else 0, email))
                    con.commit()
                    row = con.execute(
                        "SELECT * FROM usuarios WHERE lower(email)=? AND aprovado=1 AND ativo=1",
                        (email,)).fetchone()
                elif email in ADMIN_EMAILS and not row["admin"]:
                    # Allowlist manda: quem já tinha conta sobe para admin.
                    con.execute("UPDATE usuarios SET admin=1 WHERE id=?", (row["id"],))
                    con.commit()
                    row = con.execute(
                        "SELECT * FROM usuarios WHERE id=?", (row["id"],)).fetchone()
                if not row:
                    con.close()
                    return self._page(403, "Acesso desativado",
                                      "Sua conta foi desativada pelo administrador.")
                tok = secrets.token_hex(16)
                SESSIONS[tok] = row["id"]
                con.execute("UPDATE usuarios SET ultimo_login=datetime('now') WHERE id=?", (row["id"],))
                con.commit()
                con.close()
                self.send_response(302)
                self.send_header("Set-Cookie", self._cookie_sessao(tok))
                self.send_header("Location",
                                 _oauth_redirect_base(self).replace("/oauth/callback", f"/admin#token={tok}"))
                self.end_headers()
            except Exception:
                try:
                    con.close()
                except Exception:
                    pass
                raise
            return
        con = get_db()
        try:
            if u.path == "/api/hierarquia":
                hierarquia_resposta(self)
                return
            if u.path == "/api/comarcas":
                # Unidade sem fórum (a estrutura central) entra pela comarca da
                # própria unidade: por isso a contagem é por subconsulta, e não
                # pelo JOIN em foruns, que somava zero na Sede.
                rows = con.execute(
                    "SELECT c.id, c.nome,"
                    " (SELECT COUNT(*) FROM contatos ct"
                    "   JOIN setores s ON s.id=ct.setor_id"
                    "   JOIN unidades u ON u.id=s.unidade_id"
                    "   LEFT JOIN foruns f ON f.id=u.forum_id"
                    "  WHERE COALESCE(f.comarca_id, u.comarca_id)=c.id) AS total,"
                    " (SELECT COUNT(*) FROM foruns f2 WHERE f2.comarca_id=c.id)"
                    " AS n_foruns,"
                    " (SELECT COUNT(DISTINCT u.id) FROM unidades u"
                    "   LEFT JOIN foruns f ON f.id=u.forum_id"
                    "  WHERE COALESCE(f.comarca_id, u.comarca_id)=c.id"
                    "    AND EXISTS (SELECT 1 FROM setores s JOIN contatos ct2"
                    "                 ON ct2.setor_id=s.id WHERE s.unidade_id=u.id))"
                    " AS n_unidades,"
                    " (SELECT COUNT(DISTINCT s.id) FROM setores s"
                    "   JOIN unidades u ON u.id=s.unidade_id"
                    "   LEFT JOIN foruns f ON f.id=u.forum_id"
                    "  WHERE COALESCE(f.comarca_id, u.comarca_id)=c.id"
                    "    AND EXISTS (SELECT 1 FROM contatos ct3 WHERE ct3.setor_id=s.id))"
                    " AS n_setores"
                    " FROM comarcas c ORDER BY (c.ordem_num IS NULL),"
                    " c.ordem_num, c.ordem_idx").fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/foruns":
                rows = con.execute(
                    "SELECT f.id, f.nome, f.comarca_id, f.endereco, f.cep,"
                    " COUNT(DISTINCT CASE WHEN EXISTS"
                    " (SELECT 1 FROM setores s2 JOIN contatos ct2"
                    " ON ct2.setor_id=s2.id WHERE s2.unidade_id=u.id)"
                    " THEN u.id END) AS n_unidades,"
                    " COUNT(DISTINCT CASE WHEN EXISTS"
                    " (SELECT 1 FROM contatos ct3 WHERE ct3.setor_id=s.id)"
                    " THEN s.id END) AS n_setores,"
                    " COUNT(ct.id) AS total FROM foruns f"
                    " LEFT JOIN unidades u ON u.forum_id=f.id"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE f.comarca_id=? GROUP BY f.id ORDER BY (f.ordem_num IS NULL), f.ordem_num, f.ordem_idx",
                    (arg("comarca_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/unidades":
                rows = con.execute(
                    "SELECT u.id, u.nome, u.forum_id, u.endereco, u.virtual,"
                    " COUNT(DISTINCT CASE WHEN EXISTS"
                    " (SELECT 1 FROM contatos ct2 WHERE ct2.setor_id=s.id)"
                    " THEN s.id END) AS n_setores,"
                    " COUNT(ct.id) AS total FROM unidades u"
                    " LEFT JOIN setores s ON s.unidade_id=u.id"
                    " LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE u.forum_id=?"
                    " GROUP BY u.id HAVING COUNT(ct.id)>0"
                    " ORDER BY u.virtual, (u.ordem_num IS NULL), u.ordem_num, u.ordem_idx",
                    (arg("forum_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/setores":
                rows = con.execute(
                    "SELECT s.id, s.nome, s.unidade_id, s.virtual,"
                    " COUNT(ct.id) AS total"
                    " FROM setores s LEFT JOIN contatos ct ON ct.setor_id=s.id"
                    " WHERE s.unidade_id=?"
                    " GROUP BY s.id HAVING COUNT(ct.id)>0 ORDER BY (s.ordem_num IS NULL), s.ordem_num, s.ordem_idx",
                    (arg("unidade_id"),)).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/contatos":
                sql = CAMPOS_CONTATO + " WHERE 1=1"
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
                sql += " ORDER BY (ct.ordem_num IS NULL), ct.ordem_num, ct.ordem_idx"
                rows = con.execute(sql, params).fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/resumo":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                if not eh_admin(con, uid):
                    # O resumo carrega o histórico (nomes/e-mails) — só admin.
                    return self._json({"erro": "sem permissão"}, 403)
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
                alt30 = con.execute(
                    "SELECT COUNT(*) AS c FROM historico"
                    " WHERE data >= datetime('now','-30 days')").fetchone()["c"]
                total_ct = con.execute(
                    "SELECT COUNT(*) AS c FROM contatos").fetchone()["c"]
                obsoletos = con.execute(
                    "SELECT COUNT(*) AS c FROM contatos ct WHERE NOT EXISTS ("
                    " SELECT 1 FROM historico h WHERE h.contato_id=ct.id"
                    " AND h.data >= datetime('now','-180 days'))").fetchone()["c"]
                return self._json({
                    "por_forum": [dict(r) for r in por_for],
                    "por_unidade": [dict(r) for r in por_uni],
                    "por_setor": [dict(r) for r in por_set],
                    "ultimos": [dict(r) for r in ult],
                    "pendentes": pend,
                    "saude": {"alteracoes_30d": alt30, "total_contatos": total_ct,
                              "obsoletos_180d": obsoletos}})
            if u.path == "/api/usuarios":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                con = get_db()
                try:
                    if not con.execute("SELECT admin FROM usuarios WHERE id=?", (uid,)).fetchone()[0]:
                        return self._json({"erro": "sem permissão"}, 403)
                    lista = con.execute(
                        "SELECT u.id, u.usuario, u.email, u.admin, u.ativo, u.ultimo_login,"
                        " (SELECT COUNT(*) FROM acessos a WHERE a.usuario_id=u.id) AS n_acessos"
                        " FROM usuarios u ORDER BY u.usuario").fetchall()
                    return self._json([dict(r) for r in lista])
                finally:
                    con.close()
            parts = u.path.rstrip("/").split("/")
            if len(parts) == 4 and parts[1] == "api" and parts[2] == "contatos":
                # Um contato só: a edição do /admin cai aqui quando o contato
                # não está na lista plana já carregada.
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                cid = urllib.parse.unquote(parts[3]).strip()
                if not cid:
                    return self._json({"erro": "id inválido"}, 400)
                con = get_db()
                try:
                    row = con.execute(
                        CAMPOS_CONTATO + " WHERE ct.id=?", (cid,)).fetchone()
                    if not row:
                        return self._json({"erro": "não encontrado"}, 404)
                    if not self._cobre(con, uid, "setor",
                                       self._cadeia(con, contato_id=cid)[3] or 0):
                        return self._json({"erro": "sem acesso a este local"}, 403)
                    return self._json(dict(row))
                finally:
                    con.close()
            if len(parts) == 4 and parts[1] == "api" and parts[2] == "backup":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                import os as _os2
                arq = parts[3]
                if not _os2.path.basename(arq) == arq or ".." in arq or not arq.endswith(".db"):
                    return self._json({"erro": "arquivo inválido"}, 400)
                caminho = _os2.path.join("backups", arq)
                if not _os2.path.isfile(caminho):
                    return self._json({"erro": "não encontrado"}, 404)
                con = get_db()
                try:
                    if not con.execute("SELECT admin FROM usuarios WHERE id=?", (uid,)).fetchone()[0]:
                        return self._json({"erro": "sem permissão"}, 403)
                finally:
                    con.close()
                with open(caminho, "rb") as f:
                    dados = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-sqlite3")
                self.send_header("Content-Disposition", f"attachment; filename={arq}")
                self.send_header("Content-Length", str(len(dados)))
                self.end_headers()
                self.wfile.write(dados)
                return
            if u.path == "/api/meus-pedidos":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                con = get_db()
                try:
                    row = con.execute("SELECT email FROM usuarios WHERE id=?", (uid,)).fetchone()
                    if not row:
                        return self._json({"erro": "não autenticado"}, 403)
                    lista = con.execute(
                        "SELECT id, nome, nivel, alvo_id, status, motivo, motivo_recusa,"
                        " criado_em FROM pedidos WHERE lower(email)=?"
                        " ORDER BY id DESC",
                        (str(row["email"]).lower(),)).fetchall()
                    nomes = {"comarca": "comarcas", "forum": "foruns",
                             "unidade": "unidades", "setor": "setores"}
                    saida = []
                    for r in lista:
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
            if u.path == "/api/busca":
                q = urllib.parse.parse_qs(u.query)
                termo = (q.get("q") or [""])[0].strip()[:80]
                try:
                    lim = max(1, min(20, int((q.get("limite") or ["8"])[0])))
                except ValueError:
                    lim = 8
                if not termo:
                    return self._json([])
                toks = [t.replace('"', '""') for t in termo.split() if t]
                if not toks:
                    return self._json([])
                match = " OR ".join(f'"{t}"*' for t in toks)
                try:
                    rows = con.execute(
                        "SELECT c.id, c.nome, c.cargo, c.telefone, c.email,"
                        " highlight(contatos_fts, 0, '<b>', '</b>') AS nome_hl"
                        " FROM contatos_fts f JOIN contatos c ON c.id=f.contato_id"
                        " WHERE contatos_fts MATCH ? ORDER BY rank LIMIT ?",
                        (match, lim)).fetchall()
                    return self._json([dict(r) for r in rows])
                except Exception:
                    return self._json([])
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
            if u.path == "/api/historico/mensal":
                # Uma linha por (mês, ação) e a tela monta o gráfico. O mês vazio
                # entra com zero aqui, não no JavaScript: o calendário é do
                # servidor, para o gráfico não depender do relógio do navegador.
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                if not eh_admin(con, uid):
                    return self._json({"erro": "sem permissão"}, 403)
                contagem, por_acao = {}, {}
                for r in con.execute(
                        "SELECT substr(data,1,7) AS mes, acao, COUNT(*) AS total"
                        " FROM historico WHERE COALESCE(data,'')<>''"
                        " GROUP BY mes, acao").fetchall():
                    contagem[r["mes"]] = contagem.get(r["mes"], 0) + r["total"]
                    por_acao[r["mes"]] = por_acao.get(r["mes"], {})
                    por_acao[r["mes"]][r["acao"]] = r["total"]
                hoje = time.localtime()
                meses, acoes = [], {}
                for volta in range(11, -1, -1):
                    ano, mes = hoje.tm_year, hoje.tm_mon - volta
                    while mes <= 0:
                        mes += 12
                        ano -= 1
                    chave = "%04d-%02d" % (ano, mes)
                    meses.append({"mes": chave,
                                  "total": contagem.get(chave, 0)})
                    for acao, n in por_acao.get(chave, {}).items():
                        acoes[acao] = acoes.get(acao, 0) + n
                return self._json({
                    "meses": meses,
                    "acoes": sorted(({"acao": a, "total": n}
                                     for a, n in acoes.items()),
                                    key=lambda x: (-x["total"], x["acao"])),
                    "total": sum(m["total"] for m in meses),
                    "total_geral": con.execute(
                        "SELECT COUNT(*) FROM historico").fetchone()[0],
                    "mes_atual": meses[-1]["mes"],
                    # A tela avisa que a trilha inclui registros fictícios; o
                    # servidor é quem sabe, não o JavaScript.
                    "demonstracao": bool(con.execute(
                        "SELECT 1 FROM historico WHERE autor_nome=? LIMIT 1",
                        (MARCA_DEMO,)).fetchone()),
                })
            if u.path == "/api/historico":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                if not con.execute("SELECT admin FROM usuarios WHERE id=?",
                                   (uid,)).fetchone()[0]:
                    return self._json({"erro": "sem permissão"}, 403)
                rows = con.execute(
                    "SELECT h.*, COALESCE(NULLIF(h.autor_nome,''), u.usuario)"
                    " AS autor FROM historico h"
                    " LEFT JOIN usuarios u ON u.id=h.usuario_id"
                    " ORDER BY h.id DESC LIMIT 50").fetchall()
                return self._json([dict(r) for r in rows])
            if u.path == "/api/me":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                row = con.execute(
                    "SELECT id, usuario, email, admin, ativo FROM usuarios WHERE id=?",
                    (uid,)).fetchone()
                if not row or not row["ativo"]:
                    return self._json({"erro": "não autenticado"}, 403)
                me = dict(row)
                esc = self._escopo(con, uid)
                me["escopo"] = "all" if esc == "all" else (esc or [])
                me["email_ok"] = bool(os.environ.get("SMTP_HOST", ""))
                # Só o dono do ambiente (allowlist) vê a caixa de Administrador.
                me["pode_admin"] = str(row["email"] or "").strip().lower() in ADMIN_EMAILS
                # A interface usa isto para não prometer aprovação automática
                # quando o ambiente é somente leitura (demo público).
                me["aprovacao_automatica"] = SIMULACAO_AUTO_APROVAR
                return self._json(me)
            if u.path == "/api/pedidos":
                uid = self._uid()
                if not uid:
                    return self._json({"erro": "não autenticado"}, 403)
                if not con.execute("SELECT admin FROM usuarios WHERE id=?",
                                   (uid,)).fetchone()[0]:
                    return self._json({"erro": "sem permissão"}, 403)
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
        if u.path == "/api/logout":
            tok = self.headers.get("X-Admin-Token") or self._cookie("tc_session") or ""
            SESSIONS.pop(tok, None)
            self.send_response(200)
            self.send_header("Set-Cookie",
                             "tc_session=; Path=/; Max-Age=0; SameSite=Lax"
                             + ("; Secure" if self._https() else ""))
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok": true}')
            return
        if u.path == "/api/login":
            if not LOCAL_LOGIN:
                return self._json({"erro": "não encontrado"}, 404)
            data = self._body()
            con = get_db()
            ident = (data.get("usuario") or data.get("email") or "").strip().lower()
            row = con.execute(
                "SELECT * FROM usuarios WHERE (lower(usuario)=? OR lower(email)=?) AND ativo=1",
                (ident, ident)).fetchone()
            if not row or not confere_senha(row["senha_sha256"], data.get("senha") or ""):
                con.close()
                return self._json({"erro": "credenciais inválidas ou acesso não aprovado"}, 401)
            if row["aprovado"] and precisa_upgrade_hash(row["senha_sha256"]):
                con.execute("UPDATE usuarios SET senha_sha256=? WHERE id=?",
                            (gerar_hash(data.get("senha")), row["id"]))
            if row["aprovado"]:
                con.execute("UPDATE usuarios SET ultimo_login=datetime('now') WHERE id=?", (row["id"],))
                con.commit()
                con.close()
                tok = secrets.token_hex(16)
                SESSIONS[tok] = row["id"]
                return self._json({"token": tok})
            con.close()
            return self._json({"erro": "credenciais inválidas ou acesso não aprovado"}, 401)
        if u.path == "/api/pedidos":
            data = self._body()
            uid_post = self._uid()
            if not uid_post:
                return self._json({"erro": "Entre com sua conta Google para solicitar acesso."}, 401)
            con = get_db()
            try:
                sess_user = con.execute(
                    "SELECT usuario, email, admin FROM usuarios WHERE id=?",
                    (uid_post,)).fetchone()
            except Exception:
                sess_user = None
            if not sess_user:
                con.close()
                return self._json({"erro": "Sessão inválida. Entre de novo."}, 401)
            data["email"] = sess_user["email"]
            if not data.get("nome"):
                return self._json({"erro": "nome é obrigatório"}, 400)
            email = (data.get("email") or "").strip().lower()
            if "@" not in email or "." not in email.split("@")[-1]:
                return self._json({"erro": "informe um e-mail válido"}, 400)
            # O nome de usuário vem SEMPRE da sessão: aceitar o corpo permitia
            # reivindicar a linha de outro usuário (inclusive "admin") na aprovação.
            usuario = str(sess_user["usuario"] or "").strip() or email.split("@")[0]
            # árvore de locais: escopos=[{tipo|nivel, id|alvo_id}] -> um pedido por local.
            # Sem escopos, vale o caminho único (nivel+alvo_id ou comarca_id).
            itens = []
            raw_esc = data.get("escopos")
            esc_validos = 0
            if isinstance(raw_esc, list):
                for e in raw_esc:
                    if not isinstance(e, dict):
                        continue
                    nv = str(e.get("tipo") or e.get("nivel") or "").strip().lower()
                    if nv not in NIVEIS:
                        continue
                    try:
                        aid = str(e.get("id") or e.get("alvo_id") or "").strip() or None
                    except (TypeError, ValueError):
                        aid = None
                    if aid and (nv, aid) not in itens:
                        itens.append((nv, aid))
                        esc_validos += 1
            quer_admin = data.get("admin") is True
            if quer_admin:
                if sess_user["admin"]:
                    con.close()
                    return self._json({"erro": "Você já é Administrador."}, 400)
                itens.append(("admin", None))
            if not itens:
                nivel = (data.get("nivel") or "comarca").strip().lower()
                if nivel not in NIVEIS:
                    nivel = "comarca"
                try:
                    alvo = str(data.get("alvo_id") or data.get("comarca_id") or "").strip() or None
                except (TypeError, ValueError):
                    alvo = None
                itens = [(nivel, alvo)]
            nomes_nivel = {"comarca": "comarca", "forum": "fórum",
                           "unidade": "unidade", "setor": "setor",
                           "admin": "administrador"}
            existentes = con.execute(
                "SELECT nivel, alvo_id FROM pedidos WHERE lower(email)=? AND status='pendente'",
                (email,)).fetchall()
            if len(existentes) >= 5:
                con.close()
                return self._json({"erro": "Você já tem 5 pedidos pendentes. Aguarde a análise."}, 400)
            concedidos = set()
            ureg = con.execute(
                "SELECT id FROM usuarios WHERE lower(email)=? AND aprovado=1",
                (email,)).fetchall()
            if ureg:
                concedidos = {(r["nivel"], r["alvo_id"]) for r in con.execute(
                    "SELECT nivel, alvo_id FROM acessos WHERE usuario_id=?",
                    (ureg[0]["id"],)).fetchall()}
            vistos = {(r["nivel"], r["alvo_id"]) for r in existentes}
            novos = []
            ja_liberados = 0
            for (nv, aid) in itens:
                if (nv, aid) in concedidos:
                    ja_liberados += 1
                    continue
                if (nv, aid) in vistos:
                    continue
                vistos.add((nv, aid))
                novos.append((nv, aid))
            if not novos:
                con.close()
                if ja_liberados:
                    return self._json({"erro": "Você já tem esse acesso liberado."}, 400)
                return self._json({"erro": "Pedido idêntico já está pendente."}, 400)
            itens = novos
            primeiro_id = None
            novos_ids = []
            for (nivel, alvo) in itens:
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
                    " comarca_id, nivel, alvo_id, usuario_id) VALUES (?,?,?,?,?,?,?,?)",
                    (data.get("nome"), data.get("email", ""),
                     usuario, data.get("motivo", ""),
                     com_id, nivel, alvo, uid_post))
                novos_ids.append(cur.lastrowid)
                if primeiro_id is None:
                    primeiro_id = cur.lastrowid
            auto = False
            if SIMULACAO_AUTO_APROVAR:
                for pid in novos_ids:
                    linha = con.execute(
                        "SELECT nivel, alvo_id, email FROM pedidos WHERE id=?",
                        (pid,)).fetchone()
                    if linha and linha["nivel"] == "admin" and not linha["alvo_id"] \
                            and str(linha["email"] or "").strip().lower() not in ADMIN_EMAILS:
                        # Pedido de admin fora da allowlist fica pendente: a
                        # aprovação automática nunca concede gestão.
                        continue
                    ok_auto, _, _ = aprovar_pedido(con, pid, automatico=True)
                    auto = auto or ok_auto
            if len(itens) == 1:
                nv_txt = nomes_nivel.get(itens[0][0], itens[0][0])
                detalhe = f" {nv_txt} id {itens[0][1] or '-'}"
            else:
                detalhe = f" {len(itens)} locais"
            for aid in admin_ids(con):
                notify(con, aid, "solicitacao",
                       f"Nova solicitação de {data.get('nome')} ({usuario}):{detalhe}" +
                       (" (liberada automaticamente para avaliação)" if auto else ""))
            if auto:
                _send_email(email, "Acesso liberado — Diretório de Contatos",
                            f"Olá {data.get('nome')},\n\nSeu acesso foi liberado "
                            f"automaticamente (ambiente de avaliação).\n"
                            f"Entre com sua conta Google: {APP_BASE_URL}/admin")
            else:
                chefes = [r["email"] for r in con.execute(
                    "SELECT email FROM usuarios WHERE admin=1 AND aprovado=1").fetchall()
                    if r["email"]]
                extras = [e.strip() for e in
                          os.environ.get("NOTIFY_EMAILS", "").split(",") if e.strip()]
                for e in extras:
                    if e not in chefes:
                        chefes.append(e)
                if chefes:
                    _send_email(chefes, "Nova solicitação de acesso — Diretório de Contatos",
                                f"Nova solicitação de {data.get('nome')} ({usuario}):{detalhe}\n\n"
                                f"Analise em Solicitações de Acesso: {APP_BASE_URL}/admin")
            log(con, "pedido", None,
                f"solicitação de acesso: {data.get('nome')} ({usuario})" +
                (" (aprovada automaticamente para avaliação)" if auto else ""),
                uid_post)
            con.commit()
            con.close()
            return self._json({"ok": True, "id": primeiro_id, "auto_aprovado": auto}, 201)
        parts = u.path.rstrip("/").split("/")
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "pedidos" \
                and parts[4] == "aprovar":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            try:
                pid = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            con = get_db()
            try:
                if not eh_admin(con, uid):
                    return self._json({"erro": "sem permissão"}, 403)
                ok, payload, st = aprovar_pedido(con, pid, autor_id=uid)
            finally:
                con.close()
            return self._json(payload, st)
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "pedidos" \
                and parts[4] == "recusar":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            try:
                pid = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            try:
                corpo = self._body()
            except Exception:
                corpo = {}
            con = get_db()
            try:
                if not eh_admin(con, uid):
                    return self._json({"erro": "sem permissão"}, 403)
                ok, payload, st = recusar_pedido(con, pid, (corpo or {}).get("motivo"),
                                                 autor_id=uid)
            finally:
                con.close()
            return self._json(payload, st)
        if u.path == "/api/backup":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            con = get_db()
            try:
                if not con.execute("SELECT admin FROM usuarios WHERE id=?", (uid,)).fetchone()[0]:
                    return self._json({"erro": "sem permissão"}, 403)
                import datetime as _dt, os as _os
                _os.makedirs("backups", exist_ok=True)
                nome = "diretorio-" + _dt.datetime.now().strftime("%Y%m%d-%H%M%S") + ".db"
                alvo = ("backups/" + nome).replace("'", "''")
                con.execute(f"VACUUM INTO '{alvo}'")
                log(con, "backup", None, f"backup gerado: {nome}", uid)
                con.commit()
                kb = _os.path.getsize("backups/" + nome) // 1024
                return self._json({"ok": True, "arquivo": nome, "kb": kb})
            finally:
                con.close()
        if len(parts) == 5 and parts[1] == "api" and parts[2] == "usuarios" \
                and parts[4] == "ativo":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            try:
                alvo = int(parts[3])
            except ValueError:
                return self._json({"erro": "id inválido"}, 400)
            con = get_db()
            try:
                if not con.execute("SELECT admin FROM usuarios WHERE id=?", (uid,)).fetchone()[0]:
                    return self._json({"erro": "sem permissão"}, 403)
                if alvo == uid:
                    return self._json({"erro": "não é possível desativar a própria conta"}, 400)
                corpo = self._body()
                ativo = 1 if (corpo or {}).get("ativo") else 0
                con.execute("UPDATE usuarios SET ativo=? WHERE id=?", (ativo, alvo))
                log(con, "ativo", None, f"usuário {alvo} -> ativo={ativo}", uid)
                con.commit()
                return self._json({"ok": True})
            finally:
                con.close()
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
            if not LOCAL_LOGIN:
                return self._json({"erro": "não encontrado"}, 404)
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
            if not row or not confere_senha(row["senha_sha256"], data.get("atual") or ""):
                con.close()
                return self._json({"erro": "senha atual incorreta"}, 401)
            con.execute("UPDATE usuarios SET senha_sha256=? WHERE id=?",
                        (gerar_hash(nova), uid))
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
            sid = str(data.get("setor_id") or "").strip()
            if not sid:
                con.close()
                return self._json({"erro": "setor inválido"}, 400)
            if not self._cobre(con, uid, "setor", sid):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
            nid = novo_id(con, "contatos", "C")
            con.execute(
                "INSERT INTO contatos (id, setor_id, nome, cargo, telefone, email,"
                " descricao, fonte, vigente_desde)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (nid, data.get("setor_id"), data.get("nome"), data.get("cargo", ""),
                 data.get("telefone", ""), data.get("email", ""),
                 data.get("descricao") or data.get("nome") or "",
                 "criação manual", time.strftime("%Y-%m-%d")))
            log(con, "criar", nid, f"criado: {data.get('nome')}", uid)
            for aid in admin_ids(con):
                notify(con, aid, "contato",
                       f"Contato criado: {data.get('nome')}")
            con.commit()
            invalidar_hierarquia()
            row = con.execute(
                "SELECT * FROM contatos WHERE id=?", (nid,)).fetchone()
            con.close()
            return self._json(dict(row), 201)
        # Conferir: o dado continua valendo hoje. Não é edição — o valor e a
        # procedência ficam como estão; grava-se quem olhou e quando, e a
        # auditoria registra a conferência. Depende do escopo do setor, como
        # editar e remover.
        partes = u.path.rstrip("/").split("/")
        if len(partes) == 5 and partes[1:3] == ["api", "contatos"] and partes[4] == "conferir":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            cid = urllib.parse.unquote(partes[3]).strip()
            con = get_db()
            row = con.execute("SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
            if not row:
                con.close()
                return self._json({"erro": "não encontrado"}, 404)
            if not self._cobre(con, uid, "setor", self._cadeia(con, contato_id=cid)[3] or 0):
                con.close()
                return self._json({"erro": "sem acesso a este local"}, 403)
            quem = con.execute("SELECT usuario FROM usuarios WHERE id=?", (uid,)).fetchone()
            quando = time.strftime("%Y-%m-%d %H:%M")
            con.execute(
                "UPDATE contatos SET conferido_em=?, conferido_por=? WHERE id=?",
                (quando, quem["usuario"] if quem else "", cid))
            log(con, "conferir", cid,
                f"conferido: {row['nome']} ({row['cargo']})", uid)
            con.commit()
            invalidar_hierarquia()
            row = con.execute("SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
            con.close()
            return self._json(dict(row))
        return self.send_error(404)

    def do_DELETE(self):
        parts = urllib.parse.urlparse(self.path).path.rstrip("/").split("/")
        if len(parts) == 4 and parts[1] == "api" and parts[2] == "contatos":
            uid = self._uid()
            if not uid:
                return self._json({"erro": "não autenticado"}, 403)
            try:
                cid = urllib.parse.unquote(parts[3]).strip()
                if not cid:
                    raise ValueError()
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
                # edição de telefone/e-mail é uma confirmação humana do dado:
                # passa a ser a procedência, com a data de hoje
                mudou_valor = (data.get("telefone", "") != row["telefone"]
                               or data.get("email", "") != row["email"])
                con.execute(
                    "UPDATE contatos SET nome=?, cargo=?, telefone=?, email=?"
                    " WHERE id=?",
                    (data.get("nome"), data.get("cargo", ""),
                     data.get("telefone", ""), data.get("email", ""), cid))
                if mudou_valor:
                    con.execute(
                        "UPDATE contatos SET fonte=?, vigente_desde=? WHERE id=?",
                        ("edição manual", time.strftime("%Y-%m-%d"), cid))
                log(con, "editar", cid, f"editado: {data.get('nome')}", uid)
                for aid in admin_ids(con):
                    notify(con, aid, "contato",
                           f"Contato editado: {data.get('nome')}")
                con.commit()
                invalidar_hierarquia()
                row = con.execute(
                    "SELECT * FROM contatos WHERE id=?", (cid,)).fetchone()
                con.close()
                return self._json(dict(row))
            con.execute("DELETE FROM contatos WHERE id=?", (cid,))
            log(con, "remover", cid, f"removido: {row['nome']}", uid)
            for aid in admin_ids(con):
                notify(con, aid, "contato",
                       f"Contato removido: {row['nome']}")
            con.commit()
            invalidar_hierarquia()
            con.close()
            return self._json({"ok": True})
        return self.send_error(404)

    do_PUT = do_DELETE

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    init_db()
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer.allow_reuse_address = True
    print("Pública: http://%s:%d  |  Admin: http://%s:%d/admin (INTRANET_ONLY=%s)"
          % (host, port, host, port, "1" if INTRANET_ONLY else "0"))
    # Quem é admin sai daqui, não do banco: sem esta linha, "pode_admin: false"
    # com o e-mail digitado errado na allowlist vira uma caçada silenciosa.
    print("Admin por allowlist: %s"
          % (", ".join(sorted(ADMIN_EMAILS)) if ADMIN_EMAILS
             else "vazia (ninguém é promovido por e-mail)"))
    if LOCAL_LOGIN:
        print("AVISO: login local ativo (dev/testes). Produção: LOCAL_LOGIN=0.")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
