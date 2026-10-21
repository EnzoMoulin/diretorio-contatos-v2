#!/bin/bash
# Verificação rápida da demo (1 comando, sem dependências).
# Sobe o servidor, testa o fluxo completo (incl. escopo por nível) e desliga.
set -u
cd "$(dirname "$0")"
rm -f contatos.db
pkill -9 -f "python3 app.py" 2>/dev/null
sleep 2
python3 app.py &>/tmp/demo_test.log &
PID=$!
# espera o servidor responder (com timeout)
for i in $(seq 1 15); do
  curl -s -m 2 -o /dev/null http://localhost:8000/api/comarcas && break
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
echo "== comarcas =="; curl -s "$B/api/comarcas"; echo
echo "== cadeia comarca 1 =="
curl -s "$B/api/foruns?comarca_id=1" | head -c 200; echo
echo "== login admin =="
TA=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"usuario":"admin","senha":"admin123"}' | python3 -c "$TOK")
echo "== me =="; curl -s "$B/api/me" -H "X-Admin-Token: $TA"; echo
echo -n "login via email (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/login -H 'Content-Type: application/json' -d '{"email":"admin@exemplo.jus.br","senha":"admin123"}'
echo "== pedido c/ comarca =="
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"User VV","email":"u@exemplo.jus.br","usuario":"uservv","motivo":"demo","comarca_id":2}'; echo
echo -n "pedido c/ email externo (400 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"Fora","email":"f@gmail.com","usuario":"fora","comarca_id":2}'
echo "== aprovar =="; curl -s -X POST $B/api/pedidos/1/aprovar -H "X-Admin-Token: $TA"; echo
echo "== login uservv =="
TV=$(curl -s -X POST $B/api/login -H 'Content-Type: application/json' -d '{"usuario":"uservv","senha":"bemvindo123"}' | python3 -c "$TOK")
curl -s "$B/api/me" -H "X-Admin-Token: $TV"; echo
# setor de Vila Velha (unidade da comarca 2) vs setor de Vitória (comarca 1)
# primeiro setor com conteúdo de cada comarca (1=Vitória, 2=Vila Velha na base atual)
IDS=$(curl -s "$B/api/comarcas" | python3 -c "
import json,sys,urllib.request
base = 'http://localhost:8000'
def get(p):
    return json.load(urllib.request.urlopen(base + p))
out = {}
for cid in ('1', '2'):
    for f in get('/api/foruns?comarca_id=' + cid):
        for u in get('/api/unidades?forum_id=%d' % f['id']):
            ss = get('/api/setores?unidade_id=%d' % u['id'])
            if ss:
                out[cid] = (f['id'], u['id'], ss[0]['id'])
                break
        if cid in out: break
print(out['1'][0], out['1'][1], out['1'][2], out['2'][0], out['2'][1], out['2'][2])")
set -- $IDS; FIDVT=$1; UIDVT=$2; SVT=$3; FIDVV=$4; UIDVV=$5; SVV=$6
echo -n "criar no proprio local (201 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/contatos -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d "{\"setor_id\":$SVV,\"nome\":\"QA VV\",\"telefone\":\"(27) 3333-0088\"}"
echo -n "criar fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/contatos -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d "{\"setor_id\":$SVT,\"nome\":\"QA VT\",\"telefone\":\"(27) 3333-0088\"}"
echo -n "remover fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X DELETE $B/api/contatos/1 -H "X-Admin-Token: $TV"
CIDV=$(curl -s "$B/api/contatos?comarca_id=2" | python3 -c "$SID")
echo -n "editar no proprio escopo (200 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X PUT $B/api/contatos/$CIDV -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"nome":"QA VV editado"}'
echo -n "editar fora do escopo (403 esperado): "
curl -s -o /dev/null -w "%{http_code}\n" -X PUT $B/api/contatos/1 -H 'Content-Type: application/json' -H "X-Admin-Token: $TV" -d '{"nome":"invasao"}'
echo "== pedido de unidade (heranca: forum cobre?) =="
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d "{\"nome\":\"User VV\",\"email\":\"u@exemplo.jus.br\",\"usuario\":\"uservv\",\"motivo\":\"mais uma unidade\",\"nivel\":\"unidade\",\"alvo_id\":$UIDVV}"; echo
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
curl -s -X POST $B/api/pedidos -H 'Content-Type: application/json' -d '{"nome":"Sem User","email":"semuser@exemplo.jus.br","motivo":"t","comarca_id":1}'; echo
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
