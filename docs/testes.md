# Testes

O `README` traz os números; este arquivo explica o que cada script faz. A regra do
repositório é uma só: **nenhum teste roda contra a base real**. Quem precisa de
banco ganha uma cópia temporária em `/tmp` e a apaga ao final.

## `unittest` — a API por HTTP

```bash
SIMULACAO_AUTO_APROVAR=1 ADMIN_EMAILS=seu@gmail.com python3 app.py   # numa aba
python3 -m unittest discover -s tests -t . -v                       # noutra
```

`SIMULACAO_AUTO_APROVAR` e `ADMIN_EMAILS` são lidas do **ambiente de quem roda** o
`unittest`, não do processo que está servindo — exportar só no servidor deixa a
contagem diferente da esperada. O `medir-modos-testes.sh` roda as três pernas de
uma vez e é a ferramenta certa quando o número precisa ser remedido de propósito,
não para conferir o estado a cada mudança.

Os módulos são os `tests/test_*.py` — 16 arquivos — mais `tests/base.py`, que traz
o `setUp` de banco temporário compartilhado. A lista não é copiada aqui de
propósito: a versão anterior desta linha ainda citava `test_api` e
`test_historico`, que não existem há semanas. `ls tests/test_*.py` é a lista.

## Fumaça do admin (navegador real)

Os testes de Python batem na API e conferem o HTML servido; não provam que o
JavaScript monta a tela. Três scripts Playwright fazem isso numa cópia temporária
do app (nunca tocam no `contatos.db` de quem testa). Uma vez só, para instalar:
`cd tests/fumaca && npm ci && npx playwright install chromium`.

**`smoke.mjs`** é o caminho feliz inteiro: entra com o login local, clica em
**Reconfirmar**, abre a primeira linha da fila, **baixa o CSV** e confere as linhas
do arquivo contra os contatos da tela, confere o gráfico de alterações por mês e
mede a barra de ações em 390 px (o alvo de toque tem de continuar valendo no
celular). Depois reinicia a mesma cópia em `SIMULACAO_AUTO_APROVAR=0` — o modo que
o `render.yaml` publica — e confere o que o visitante lê: chip **Aguardando
Administrador** desabilitado, com o motivo no `title` e no `aria-label`, aviso de
somente leitura, nenhum escopo ganho e nenhum rótulo neutro aposentado na
procedência, enquanto quem tem documento mostra a fonte no texto. São 44
verificações no total.

**`smoke-fila.mjs`** cobre o que o caminho feliz não visita, numa cópia em que todo
`vigente_desde` é apagado e existe um usuário de escopo parcial: com a fila vazia o
**Reconfirmar** fica desabilitado, com o motivo no `title` e no `aria-label`, e o
clique não abre caixa nenhuma; para o usuário de escopo parcial o botão não
aparece — e o mesmo script prova pela API que o `conferir` dele responde 200 dentro
do escopo e 403 fora, que é o motivo da regra.

**`acessibilidade.mjs`** mede o que o teste de API e o olho de quem desenhou a tela
não pegam: nome acessível de todo controle visível, anel de foco percorrido com
**Tab** de verdade e contraste WCAG AA do texto nos dois temas (10 checagens).
Nasceu medindo e corrigiu três contrastes do tema escuro que estavam abaixo do
mínimo: a legenda do mapa, a atribuição do Leaflet e o rodapé.

O teste pagou o próprio custo na primeira execução: o **Reconfirmar** pintava a
fila e a fechava no mesmo clique, porque o listener de "clique fora" da busca não
distinguia o botão da área de resultados. O `stopPropagation` está comentado no
`admin.js` para ninguém refazer o caminho.

## Cache dos estáticos (`?v=`)

Cada asset referenciado nos HTML carrega `?v=` com os oito primeiros caracteres do
sha256 do próprio arquivo. Editar um `.js`/`.css` e esquecer o `?v=` fazia o
navegador servir a versão velha — e o teste manual concluir que "não funcionou".

- `scripts/atualizar-cache-busting.py` recalcula (idempotente).
- `scripts/pre-commit` faz o recálculo antes do commit — copie para
  `.git/hooks/pre-commit`; hooks não são versionados.
- `tests/test_cache_busting.py` reprova o CI quando o HTML diverge do disco.
- `tests/test_cache_http.py` guarda os headers: `immutable` só quando o `?v=` bate
  com o conteúdo entregue; HTML nunca é cacheado, porque é ele que carrega a versão
  nova.

## De onde vem o 94

**94 é `Ran − skipped`, não a contagem de métodos no disco.** Quem conta
`def test_` na árvore chega a **98** — e é aí que o número anunciado no currículo
parece não fechar.

A diferença não é código morto: são as duas classes que existem para provar a
configuração oposta, e elas nunca rodam junto com o resto.

| Classe | métodos | só roda com | na outra perna |
| :--- | ---: | :--- | :--- |
| `TestSomenteLeitura` | 3 | `SIMULACAO_AUTO_APROVAR=0` | a classe inteira é pulada |
| `TestAdminPorAllowlist` | 2 | `SIMULACAO_AUTO_APROVAR=1` | a classe inteira é pulada |

E aí entra a contabilidade do `unittest`: **classe pulada no `setUpClass` vira um
objeto só**, não três nem dois. Por isso o rodapé imprime `Ran 95` numa perna e
`Ran 96` na outra — nunca 98 —, e é `Ran − skipped` que fecha em 94.

Medido no run do commit `5751b62` (`gh run list --commit 5751b62`):

| Perna | objetos (`Ran`) | `skipped` | rodando |
| :--- | ---: | ---: | ---: |
| modo 1 + `ADMIN_EMAILS` | 95 | 1 | **94** |
| modo 1 sem `ADMIN_EMAILS` | 95 | 2 | 93 |
| modo 0 + `ADMIN_EMAILS` | 96 | 2 | **94** |

Conta fechada: no modo 1, 98 métodos menos os três de `TestSomenteLeitura`, que a
classe pulada absorve num objeto (95 objetos), menos esse objeto pulado = 94. No
modo 0 são os dois de `TestAdminPorAllowlist` absorvidos (96 objetos), menos dois
pulados — a classe e o caso que exige a flag em 1 — = 94. Ou seja: o "4 de
diferença" até 98 não é o mesmo 4 nas duas pernas.

**Regra prática:** o número publicável é **94** e ele só sai de `Ran − skipped`.
`grep -c 'def test_'` dá 98 e não serve para conferir CV, README nem cartilha: a
fonte é `scripts/contagens.json`, remedida pelo `medir-modos-testes.sh`. Este
arquivo entra na varredura do `conferir-contagens.py`, então qualquer número
seguido de "casos" aqui tem de ser 94.

## Conferência de contagens

`scripts/contagens.json` é a fonte única. `scripts/conferir-contagens.py` varre
**todo** `*.md` e `*.html` versionado atrás de "N casos" — documento novo entra na
conferência sozinho —, confere a tabela das três pernas no `README`, o número da
fumaça, o PDF da cartilha e os rótulos do `medir-modos-testes.sh`, e falha quando
discordam. Na mesma passada ele confere os **links de documentação**: todo link
relativo em `.md` e `.html` versionado tem de apontar para alvo existente e, quando
mira um `.md` com âncora, para um título que gere aquela âncora. Renomear a seção
*De onde vem o 94*, ou uma captura que o README mostra, reprova o CI em vez de
deixar o link apontando para o vazio. `--medir` roda a suíte nas três pernas em vez
de confiar no que está
escrito. O CI roda essa conferência antes dos testes e, antes ainda, só
`tests/test_integridade_dados.py`: base quebrada aparece em segundos, não no fim da
suíte.

### Quem cita a contagem

O script alcança quatro lugares; o quinto está fora do repositório e só se confere
a olho:

| Onde | O script vê? |
| :--- | :--- |
| `README.md` (tabela das pernas, fumaça e "N casos") | sim |
| `docs/cartilha-deploy.html` | sim |
| `docs/cartilha-deploy.pdf` | sim — pulado, não reprovado, sem `pdftotext` |
| rótulo `esperado:` do `medir-modos-testes.sh` | sim |
| currículo PT e EN — `.docx`, `.pdf`, `.txt` (fora do repo) | **não** |

Mexer no número é uma operação em cinco artefatos. Ordem que evita divergência:
`scripts/contagens.json` → `medir-modos-testes.sh` → README → cartilha (HTML e PDF
no mesmo commit) → currículo.
