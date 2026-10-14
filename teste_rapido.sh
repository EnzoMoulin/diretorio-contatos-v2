#!/bin/bash
# Verificação rápida da demo (1 comando, sem dependências).
# Sobe o servidor, testa os endpoints e desliga.
set -u
cd "$(dirname "$0")"
rm -f contatos.db
python3 app.py &>/tmp/demo_test.log &
PID=$!
sleep 2
echo "== lista ==";        curl -s "http://127.0.0.1:8000/api/contatos" | head -c 200; echo
echo "== busca ==";        curl -s "http://127.0.0.1:8000/api/contatos?q=ti" | head -c 200; echo
echo "== login ==";        curl -s -X POST http://127.0.0.1:8000/api/login -H 'Content-Type: application/json' -d '{"usuario":"admin","senha":"admin123"}'; echo
echo "== home ==";         curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/
kill $PID 2>/dev/null
rm -f contatos.db /tmp/demo_test.log
echo "OK"
