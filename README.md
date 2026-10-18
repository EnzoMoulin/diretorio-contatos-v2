# Diretório de Contatos — demo para portfólio

> Projeto genérico criado do zero para demonstração. Inspirado em experiência
> prévia com diretório institucional (consulta pública + área administrativa
> com login, permissões por local, solicitações de acesso, registro de
> alterações e navegação em camadas com mapa).
> **Nenhum dado real ou interno é usado aqui** — todos os contatos são
> fictícios (Empresa Exemplo).

## Arquitetura (espelha o sistema original)
- **Duas implantações isoladas, sem trânsito entre elas** — como no original
  (implantação pública no site × privada na intranet, definidas por propriedade):
  - `/` pública: só consulta; falha fechada (nenhuma mutação sem token)
  - `/admin` interna: portão de login; sem token válido, nada além do portão aparece
- **Portão institucional**: no original, sessão Google + intranet + domínio
  institucional (`AuthService.emailPermitidoNoPrivado`); aqui, login demo +
  pedido exigindo e-mail `@empresa-exemplo.com.br` (validado no servidor, 400 fora do domínio)
- **Tabela de usuários decide permissões**: sem cadastro, mesmo no interno a
  visão seria só consulta; com cadastro, edita os locais do seu escopo
  (`acessos`, com herança municipio > unidade > setor); admin edita tudo
- **Consulta em cards por nível**: sem tabela — Localidade → Unidade → Setor
  em cards clicáveis com contagem, botão voltar e breadcrumb; contato em card
  com `tel:` + `mailto:`; Criar/Editar/Remover só onde há cobertura

## O que faz
- **Consulta pública** (`/`): **mapa clicável à esquerda como porta de entrada**
  (Leaflet + GeoJSON público do IBGE filtra por município) + **painel à direita**
  com busca global (alcança todos os níveis: nome, cargo, telefone, e-mail,
  setor, unidade e localidade) e **menus em cascata** Localidade → Unidade →
  Setor, com breadcrumb do caminho. A tabela **começa vazia**, com orientação
  — nada de despejar todos os contatos de cara. Sem nenhum caminho para o acesso interno.
- **Acesso interno** (`/admin`, URL separada, sem nenhum caminho a partir do
  público): entra direto em **consulta** (mapa + cascata + tabela vazia), sem login e
  sem funções administrativas; logado, os locais liberados vêm marcados com ✓
  (consulta em todos, edição só no escopo); clicar no mapa filtra qualquer local.
  Botões na base da sidebar: **Acesso administrativo** (modal de login com
  e-mail + senha; com cadastro, eleva e libera gestão por escopo + Solicitações
  + Registro) e **Solicitar acesso** (modal do formulário); **Sair do acesso
  administrativo** volta à consulta, continua no interno.
  Demo: admin@empresa-exemplo.com.br / admin123.
- **Gestão dentro da consulta, com escopo por nível**: o usuário cria/edita/remove
  contatos só onde tem cobertura (município, unidade ou setor, com herança de
  cima); fora dela, só consulta. Ao lado de cada nível selecionado sem cobertura,
  botão **Solicitar acesso** com modal de confirmação dinâmico (município inteiro
  = todas as unidades e setores; unidade inteira = todos os setores; setor = só ele).
  Admin aprova e a cobertura amplia. Servidor barra tudo fora do escopo (403).
- **Solicitação de acesso**: modal (nome, e-mail institucional, usuário, local,
  motivo) → pedido pendente → admin aprova e o novo usuário entra com senha
  inicial, já com o escopo do local pedido (e-mails fora do domínio: 400)
- **Registro de alterações**: criar / editar / remover / pedidos / aprovações
- **Dashboard** (só logado): cards (municípios, unidades, setores, contatos,
  editáveis, pendências), barras por município com ✓ de cobertura e últimas
  alterações — tudo recortado pelo seu escopo
- **Notificações** (só logado): solicitações chegam aos admins, aprovação
  chega ao solicitante, criar/editar/remover avisa os admins; badge de não
  lidas, marcar uma/todas como lidas. A aba só aparece após o login.
- **Configurações**: tema claro/escuro para todo mundo (externo e interno,
  com ou sem login); logado ganha dados da conta e troca de senha
- **E-mails clicáveis**: toda coluna de e-mail abre o app de e-mail (mailto),
  igual ao original
- **Imprimir / Salvar PDF**: botão aparece após selecionar um município e
  imprime todos os contatos do nível atual (município, unidade ou setor);
  Dashboard e Registro têm botão próprio; folha limpa em A4

## Stack
- Backend: Python 3, somente biblioteca padrão (`http.server` + `sqlite3`) — zero dependências
- Frontend: HTML + CSS + JS puro (sem framework); mapa com Leaflet via CDN
- Banco: SQLite local (`contatos.db`, criado na primeira execução, 12 registros fictícios)

## Como rodar
```bash
python3 app.py
# pública: http://localhost:8000
# admin:   http://localhost:8000/admin   (demo: admin / admin123)
bash teste_rapido.sh   # verifica o fluxo completo, incl. escopo por local
```

## Endpoints
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/localidades` | não | localidades + total de contatos |
| GET | `/api/unidades?localidade_id=` | não | unidades da localidade |
| GET | `/api/setores?unidade_id=` | não | setores da unidade |
| GET | `/api/contatos?q=&setor_id=&unidade_id=&localidade_id=` | não | lista/busca com escopo |
| GET | `/api/me` | `X-Admin-Token` | usuário + flag admin + escopo |
| GET | `/api/historico` | `X-Admin-Token` | últimas 50 alterações |
| POST | `/api/login` | não | `{usuario, senha}` → `{token}` |
| POST | `/api/contatos` | `X-Admin-Token` | cria (só no seu escopo) |
| DELETE | `/api/contatos/<id>` | `X-Admin-Token` | remove (só no seu escopo) |
| POST | `/api/pedidos` | não | solicita acesso (com local) |
| GET | `/api/pedidos` | `X-Admin-Token` | pendentes (com local pedido) |
| POST | `/api/pedidos/<id>/aprovar` | `X-Admin-Token` | aprova, cria usuário e concede escopo |
| GET | `/api/resumo` | `X-Admin-Token` | totais por unidade/setor + últimos 5 + pendentes |
| POST | `/api/me/senha` | `X-Admin-Token` | troca a própria senha |
| GET | `/api/notificacoes` | `X-Admin-Token` | minhas notificações + `nao_lidas` |
| POST | `/api/notificacoes/lida` | `X-Admin-Token` | marca uma como lida (`{"id"}`) |
| POST | `/api/notificacoes/lidas` | `X-Admin-Token` | marca todas como lidas |

## Versão completa (Google Apps Script)
Mesmo domínio, implementação corporativa completa (auth, papéis, hierarquia,
auditoria): [EnzoMoulin/diretorio-contatos](https://github.com/EnzoMoulin/diretorio-contatos).

## Screenshots
_Vídeo/screenshots entram aqui após primeira execução (só tela + legendas, sem voz/webcam)._
- `screenshots/` — reservado

## Estrutura
```
app.py                 backend + API (stdlib, com escopo por local)
frontend/public.html   consulta pública (busca + camadas + mapa + modal)
frontend/public.js     lógica da consulta pública
frontend/admin.html    área administrativa (consulta + modais)
frontend/admin.js      estados de acesso + gestão por escopo + solicitações + registro
frontend/mapa.js       mapa Leaflet compartilhado (densidade + clique filtra)
frontend/style.css     tema (identidade do app original)
```

## Licença
MIT — Enzo Moulin.
