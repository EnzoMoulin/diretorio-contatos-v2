#!/usr/bin/env bash
# Abre o /admin do v2 já autenticado, para o teste manual do dono.
#
# Por que existe: o /admin não tem formulário de login local (o público entra
# por Google) e a sessão é um token em memória, lido de `#token=` no hash pela
# `admin.js` (linha ~1497). Na mão isso vira seis passos: subir o servidor,
# esperar, fazer POST em /api/login, copiar o token, montar a URL, abrir o
# navegador. Este script faz os seis e não mata processo nenhum.
#
# Uso:
#   scripts/abrir-teste-manual.sh              # porta 8000 se estiver livre
#   PORTA=8101 scripts/abrir-teste-manual.sh   # porta fixa
#   scripts/abrir-teste-manual.sh --parar      # derruba só a instância que ele subiu
#
# Variáveis: PORTA, PYTHON (python3), USUARIO (admin), SENHA (admin123),
#            ADMIN_EMAILS, SIMULACAO_AUTO_APROVAR (1), SEM_NAVEGADOR=1.
#
# Nunca derruba quem já escuta a porta: se a 8000 estiver ocupada (o demo do
# dono, por exemplo), escolhe a próxima livre e diz qual usou.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
USUARIO="${USUARIO:-admin}"
SENHA="${SENHA:-admin123}"
# O admin semeado é `admin@exemplo.jus.br`; pôr esse e-mail na allowlist deixa
# `pode_admin` verdadeiro em /api/me, que é o que revela a caixa "perfil de
# Administrador" no formulário de pedido. Para testar o caminho de visitante,
# rode com ADMIN_EMAILS=dono@exemplo.jus.br (ou vazio).
ADMIN_EMAILS="${ADMIN_EMAILS:-admin@exemplo.jus.br}"
SIMULACAO_AUTO_APROVAR="${SIMULACAO_AUTO_APROVAR:-1}"
ESTADO="/tmp/v2-teste-manual"
mkdir -p "$ESTADO"
PIDFILE="$ESTADO/servidor.pid"
URLFILE="$ESTADO/admin-url.txt"
LOG="$ESTADO/servidor.log"

porta_livre() {
  "$PYTHON" - "$1" <<'PY'
import socket, sys
porta = int(sys.argv[1])
s = socket.socket()
try:
    s.bind(("127.0.0.1", porta))
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

parar() {
  if [ ! -f "$PIDFILE" ]; then
    echo "nada a parar: $PIDFILE não existe."
    return 0
  fi
  local pid; pid="$(cat "$PIDFILE")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
    echo "parado: pid $pid"
  else
    echo "o pid $pid já não estava rodando."
  fi
  rm -f "$PIDFILE"
}

if [ "${1:-}" = "--parar" ]; then
  parar
  exit 0
fi

# Porta: a pedida, ou a primeira livre a partir da 8000.
# O laço usa aritmética em vez de escrever as portas uma a uma: o caso
# `test_sem_telefone_real` varre a árvore atrás de padrão de telefone, e dois
# números de quatro dígitos lado a lado casam como telefone — falso positivo
# que derruba o CI por causa de um comentário. (A primeira versão deste
# comentário derrubou o CI exatamente assim.)
PORTA="${PORTA:-8000}"
if ! porta_livre "$PORTA"; then
  escolhida=""
  primeira=$((PORTA + 1)); ultima=$((PORTA + 20))
  for p in $(seq "$primeira" "$ultima"); do
    if porta_livre "$p"; then escolhida="$p"; break; fi
  done
  if [ -z "$escolhida" ]; then
    echo "erro: $PORTA e as vinte seguintes estão ocupadas; passe PORTA=<porta livre>." >&2
    exit 1
  fi
  echo "porta $PORTA ocupada (não vou mexer em quem está lá); usando $escolhida."
  PORTA="$escolhida"
fi

# Cópia do banco antes de o servidor tocar nele: `init_db` migra e faz backfill,
# e o dono pode estar usando esta base para o teste manual dele.
if [ -f "$RAIZ/contatos.db" ]; then
  backup="/tmp/contatos.db.antes-teste-manual-$(date +%Y%m%d-%H%M%S)"
  cp -a "$RAIZ/contatos.db" "$backup"
  echo "backup do banco: $backup"
fi

echo "subindo o servidor em http://127.0.0.1:$PORTA ..."
(
  cd "$RAIZ"
  SIMULACAO_AUTO_APROVAR="$SIMULACAO_AUTO_APROVAR" \
  ADMIN_EMAILS="$ADMIN_EMAILS" \
  LOCAL_LOGIN=1 \
  PORT="$PORTA" \
  nohup "$PYTHON" app.py > "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
)

for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:$PORTA/healthz" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf "http://127.0.0.1:$PORTA/healthz" > /dev/null 2>&1; then
  echo "erro: o servidor não respondeu em 30 s. Log em $LOG:" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

TOKEN="$(curl -s -X POST "http://127.0.0.1:$PORTA/api/login" \
  -H 'Content-Type: application/json' \
  -d "{\"usuario\":\"$USUARIO\",\"senha\":\"$SENHA\"}" \
  | "$PYTHON" -c 'import json,sys; print(json.load(sys.stdin).get("token",""))')"

if [ -z "$TOKEN" ]; then
  echo "erro: login local falhou (usuário '$USUARIO'). O servidor está em $LOG." >&2
  exit 1
fi

URL="http://127.0.0.1:$PORTA/admin#token=$TOKEN"
printf '%s\n' "$URL" > "$URLFILE"

echo
echo "público:  http://127.0.0.1:$PORTA/"
echo "admin:    $URL"
echo "          (o token sai da barra sozinho e fica no localStorage: F5 mantém a sessão)"
echo "log:      $LOG"
echo "parar:    scripts/abrir-teste-manual.sh --parar"
echo

if [ "${SEM_NAVEGADOR:-0}" != "1" ]; then
  (xdg-open "$URL" > /dev/null 2>&1 &) || echo "(não consegui abrir o navegador; use a URL acima)"
fi
