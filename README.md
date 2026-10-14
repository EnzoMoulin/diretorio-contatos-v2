# Diretório de Contatos — demo para portfólio

> Projeto genérico criado do zero para demonstração. Inspirado em experiência
> prévia com diretório institucional (consulta pública + gestão interna +
> histórico de alterações). **Nenhum dado real ou interno é usado aqui** —
> todos os contatos são fictícios.

## O que faz
- Busca pública de contatos (nome, setor, telefone, e-mail)
- Área interna com login demo (`admin` / `admin123`)
- Criar, editar e remover contatos (com token)
- Histórico de alterações (criar / atualizar / remover)

## Stack
- Backend: Python 3, somente biblioteca padrão (`http.server` + `sqlite3`) — zero dependências
- Frontend: HTML + CSS + JS puro (sem framework)
- Banco: SQLite local (`contatos.db`, criado na primeira execução)

## Como rodar
```bash
python3 app.py
# abre http://localhost:8000
```

## Endpoints
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/api/contatos?q=` | não | lista/busca |
| GET | `/api/historico` | não | últimas 50 alterações |
| POST | `/api/login` | não | `{usuario, senha}` → `{token}` |
| POST | `/api/contatos` | `X-Admin-Token` | cria |
| PUT | `/api/contatos/<id>` | `X-Admin-Token` | atualiza |
| DELETE | `/api/contatos/<id>` | `X-Admin-Token` | remove |

## Screenshots
_Vídeo/screenshots entram aqui após primeira execução (só tela + legendas, sem voz/webcam)._
- `screenshots/` — reservado

## Estrutura
```
app.py                 backend + API (stdlib)
frontend/index.html    página única
frontend/app.js        busca + admin + histórico
frontend/style.css     estilo mínimo
```

## Próximos passos (ideias)
- Paginação e ordenação
- Papéis (leitor / editor / admin)
- Exportar CSV
- Testes automatizados com `unittest`

## Licença
MIT — Enzo Moulin.
