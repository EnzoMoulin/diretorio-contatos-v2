# Roteiro de prints e vídeo (só tela + legendas, sem voz/webcam)

## Demo executável (`diretorio-contatos-demo`)
1. `python3 app.py` e abrir http://localhost:8000
2. Prints (salvar em `screenshots/`):
   - `01-busca.png` — página inicial com a lista de 6 contatos
   - `02-busca-filtrada.png` — campo de busca com "ti" digitado
   - `03-area-interna.png` — área interna após login demo + histórico
3. Subir: `git add screenshots && git commit -m "Screenshots" && git push`
4. Referenciar no README (trocar a linha de reserva pelos prints).

## Versão completa (`diretorio-contatos`)
1. Rodar a demo com `carregarDadosExemplo()` e abrir o web app publicado
2. Prints (salvar em `docs/` do repo):
   - `01-consulta.png` — consulta pública com hierarquia
   - `02-mapa.png` — mapa com município destacado
   - `03-gestao.png` — área de gestão (dados fictícios visíveis)
3. Subir e referenciar no README da mesma forma.

## Vídeo curto (30–60s, qualquer um dos dois)
- Gravação de tela: abrir → buscar "ti" → fazer login demo → criar um contato →
  mostrar o histórico. Sem voz, sem webcam.
- Adicionar legendas na edição com os 4 passos acima.
- Subir no YouTube como "não listado" e colar o link no README + LinkedIn.
