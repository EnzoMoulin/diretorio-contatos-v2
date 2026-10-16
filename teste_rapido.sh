#!/bin/bash
# Verificação rápida da demo v3 (1 comando, sem dependências).
# Sobe o servidor, testa o fluxo completo (incl. escopo por local) e desliga.
set -u
cd "$(dirname "$0")"
rm -f contatos.db
python3 app.py &>/tmp/demo_test.log &
PID=$!
sleep 4
B=http://localhost:8000
TOK="import sys,json; print(json.load(sys.stdin)['token'])"
SID="import sys,json; print(json.load(sys.stdin)[0]['id'])"
echo "== paginas =="
curl -s -o /dev/null -w "publica:%{http_code}\n" $B/
curl -s -o /dev/null -w "admin:%{http_code}\n" $B/admin
curl -s -o /dev/null -w "mapa.js:%{http_code}\n" $B/mapa.js
echo "== localidades =="; curl -s "$B/api/localidades"; echo
echo "== login admin =="
TA=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"usuario":"admin","senha":"admin123"}' | python3 -c "$TOK")
echo "== me =="; curl -s "$B/api/me" -H "X-Admin-Token: $TA"; echo
echo -n "login via email (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/login -H 'Content-Type: application/json' -d '{"email":"admin@empresa-exemplo.com.br","senha":"admin123"}'
echo "== pedido c/ local =="
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"User VV","email":"u@empresa-exemplo.com.br","usuario":"uservv","motivo":"demo","localidade_id":2}'; echo
echo -n "pedido c/ email externo (400 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"Fora","email":"f@gmail.com","usuario":"fora","localidade_id":2}'
echo "== aprovar =="; curl -s -X POST $B/api/pedidos/1/aprovar -H "X-Admin-Token: $TA"; echo
echo "== login uservv =="
TV=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"usuario":"uservv","senha":"bemvindo123"}' | python3 -c "$TOK")
curl -s "$B/api/me" -H "X-Admin-Token: $TV"; echo
SVV=$(curl -s "$B/api/setores?unidade_id=3" | python3 -c "$SID")
SVT=$(curl -s "$B/api/setores?unidade_id=1" | python3 -c "$SID")
echo -n "criar no proprio local (201 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/contatos -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d "{\"setor_id\":$SVV,\"nome\":\"QA VV\",\"telefone\":\"(27) 3333-0088\"}"
echo -n "criar fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/contatos -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d "{\"setor_id\":$SVT,\"nome\":\"QA VT\",\"telefone\":\"(27) 3333-0088\"}"
echo -n "remover fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE $B/api/contatos/1 -H "X-Admin-Token: $TV"
echo "== historico =="; curl -s "$B/api/historico" -H "X-Admin-Token: $TA" | head -c 150; echo
kill $PID 2>/dev/null
rm -f contatos.db /tmp/demo_test.log
echo "OK"