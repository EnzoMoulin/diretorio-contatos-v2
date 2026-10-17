#!/bin/bash
# Verificação rápida da demo v3 (1 comando, sem dependências).
# Sobe o servidor, testa o fluxo completo (incl. escopo por local) e desliga.
set -u
cd "$(dirname "$0")"
rm -f contatos.db
pkill -9 -f "python3 app.py" 2>/dev/null
sleep 2
python3 app.py &>/tmp/demo_test.log &
PID=$!
# espera o servidor responder (com timeout)
for i in $(seq 1 15); do
  curl -s -m 2 -o /dev/null http://localhost:8000/api/localidades && break
  sleep 1
done
if ! kill -0 $PID 2>/dev/null; then echo "FALHOU: servidor não subiu"; cat /tmp/demo_test.log; exit 1; fi
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
CIDV=$(curl -s "$B/api/contatos?localidade_id=2" | python3 -c "$SID")
echo -n "editar no proprio escopo (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X PUT $B/api/contatos/$CIDV -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"nome":"QA VV editado"}'
echo -n "editar fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X PUT $B/api/contatos/1 -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"nome":"invasao"}'
echo "== pedido de setor =="
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d "{\"nome\":\"User VV\",\"email\":\"u@empresa-exemplo.com.br\",\"usuario\":\"uservv\",\"motivo\":\"mais um setor\",\"nivel\":\"setor\",\"alvo_id\":$SVV}"; echo
echo "== pendentes com nivel =="; curl -s "$B/api/pedidos" -H "X-Admin-Token: $TA" | head -c 300; echo
echo "== historico =="; curl -s "$B/api/historico" -H "X-Admin-Token: $TA" | head -c 150; echo
echo "== resumo =="; curl -s "$B/api/resumo" -H "X-Admin-Token: $TA" | head -c 200; echo
echo -n "resumo sem token (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" $B/api/resumo
echo -n "trocar senha curta (400 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/me/senha -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"atual":"bemvindo123","nova":"123"}'
echo -n "trocar senha (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/me/senha -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"atual":"bemvindo123","nova":"novasenha123"}'
echo -n "login com nova senha (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/login -H 'Content-Type: application/json' -d '{"usuario":"uservv","senha":"novasenha123"}'
echo "== pedido sem usuario (default = inicio do email) =="
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"Sem User","email":"semuser@empresa-exemplo.com.br","motivo":"t","localidade_id":1}'; echo
echo "== notificacoes do admin (deve listar solicitacoes) =="
curl -s "$B/api/notificacoes" -H "X-Admin-Token: $TA" | head -c 300; echo
echo -n "notificacoes sem token (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" $B/api/notificacoes
NID=$(curl -s "$B/api/notificacoes" -H "X-Admin-Token: $TA" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['lista'][0]['id'] if d['lista'] else 0)")
echo "marcar lida id=$NID:"; curl -s -X POST $B/api/notificacoes/lida -H 'Content-Type: application/json' -H "X-Admin-Token: $TA" -d "{\"id\":$NID}"; echo
echo -n "marcar todas lidas (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/notificacoes/lidas -H "X-Admin-Token: $TA"
kill $PID 2>/dev/null
rm -f contatos.db /tmp/demo_test.log
echo "OK"