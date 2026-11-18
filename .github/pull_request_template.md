<!-- Preencha todas as seções; o que não se aplica, escreva "n/a" — não apague o título. -->

## Resumo

<!-- O que este PR resolve, em 1–3 frases, no presente do indicativo:
     "A busca passa a aceitar termo sem acento e a filtrar por competência." -->

## Issue

Closes #

<!-- `Closes #12` fecha a issue quando o merge entra; `Refs #12` só referencia.
     PR sem issue: explique aqui por que não havia problema a resolver. -->

## Alterações principais

-

## Por que assim (trade-offs)

<!-- A parte que a revisão de código não mostra: qual alternativa foi descartada e por quê,
     o que fica pior com esta escolha, o que ficou fora do escopo de propósito. -->

## Validação

<!-- O CI roda o mesmo; aqui vai o que foi rodado na mão e o resultado medido. -->

- [ ] `python3 -m unittest discover -s tests -t . -v` — *(94 casos)*
- [ ] `python3 scripts/conferir-contagens.py` — *(se o número de testes ou checagens mudou, `scripts/contagens.json` mudou primeiro)*
- [ ] `cd tests/fumaca && node smoke.mjs` — *(quando o PR toca o frontend)*
- [ ] `cd tests/fumaca && node acessibilidade.mjs` — *(quando o PR toca o frontend)*
- [ ] `sha256sum -c docs/demo-fluxo.sha256` — *(quando o PR toca o screencast)*
- [ ] Diff completo lido (não só o que a suíte cobre)
