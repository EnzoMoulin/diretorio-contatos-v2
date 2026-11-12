#!/usr/bin/env python3
"""Confere se os quatro lugares que citam a contagem de testes concordam.

O número aparece em quatro arquivos que não se leem entre si: `README.md`,
`docs/cartilha-deploy.html`, o PDF da cartilha e o rótulo `esperado:` do
`medir-modos-testes.sh`. Já divergiram duas vezes (73/72/73 no script contra
78/77/78 no README), e divergir é pior que errar: o instrumento de medir passa a
contradizer o documento que ele deveria confirmar.

A fonte única é `scripts/contagens.json` — não se copia número dele para cá. Cada
lugar é lido por padrão (regex) e comparado; divergência sai com o valor
encontrado e o esperado, e o script termina em 1.

    python3 scripts/conferir-contagens.py            # só confere o que está escrito
    python3 scripts/conferir-contagens.py --medir    # roda a suíte nas 3 pernas e compara

O PDF depende de `pdftotext` (poppler): sem ele o passo é *pulado*, não reprovado
— o runner do GitHub Actions não traz poppler, e reprovar por falta de ferramenta
ensinaria a ignorar o script.
"""
import json
import os
import re
import shutil
import subprocess
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CANONICO = os.path.join(RAIZ, "scripts", "contagens.json")
MEDIR = os.path.expanduser(
    "~/.hermes/skills/diretorio-contatos-v2/scripts/medir-modos-testes.sh")


def ler(*partes):
    caminho = os.path.join(RAIZ, *partes)
    if not os.path.exists(caminho):
        return None
    with open(caminho, encoding="utf-8") as f:
        return f.read()


def textos_do_pdf(partes):
    """Camada de texto do PDF, ou None quando não dá para extrair."""
    if not shutil.which("pdftotext"):
        return None
    caminho = os.path.join(RAIZ, *partes)
    if not os.path.exists(caminho):
        return None
    saida = subprocess.run(["pdftotext", caminho, "-"], capture_output=True, text=True)
    return saida.stdout if saida.returncode == 0 else None


def arquivos_de_texto():
    """Arquivos versionados ou novos que valem varrer: markdown e html.

    `--cached --others --exclude-standard` inclui o arquivo novo que ainda não
    foi `git add` (senão a conferência só enxergaria o documento depois do
    commit, que é tarde) e ao mesmo tempo respeita o que está ignorado — o bundle
    do Playwright em node_modules e o artefato de sessão que mora no diretório
    mas não pertence ao repositório. Sem Git, cai no walk com as mesmas exclusões.
    """
    if shutil.which("git"):
        saida = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard",
             "*.md", "*.html"],
            cwd=RAIZ, capture_output=True, text=True)
        if saida.returncode == 0:
            return [l for l in saida.stdout.splitlines() if l.strip()]
    achados = []
    for raiz, dirs, arquivos in os.walk(RAIZ):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
        for nome in arquivos:
            if nome.endswith((".md", ".html")):
                achados.append(os.path.relpath(os.path.join(raiz, nome), RAIZ))
    return sorted(achados)


class Checagem:
    def __init__(self):
        self.falhas = []
        self.pulados = []

    def igual(self, onde, encontrado, esperado):
        if encontrado == esperado:
            print(f"  ok   {onde}: {encontrado}")
            return True
        print(f"  FALHA {onde}: {encontrado} (esperado {esperado})")
        self.falhas.append(f"{onde}: {encontrado} != {esperado}")
        return False

    def pulado(self, onde, motivo):
        print(f"  --   {onde}: pulado ({motivo})")
        self.pulados.append(onde)


def main():
    with open(CANONICO, encoding="utf-8") as f:
        canonico = json.load(f)
    casos = canonico["casos"]
    pernas = canonico["pernas"]
    fumaca = canonico["fumaca"]
    c = Checagem()

    print("Contagens canônicas:", casos, "casos;",
          "/".join(str(p["rodando"]) for p in pernas), "rodando;",
          fumaca, "verificações de fumaça")

    # 1) Varredura: todo "N casos" em markdown ou html versionado.
    #    Qualquer documento novo que cite a contagem entra sozinho na conferência
    #    — era o buraco do README-e-cartilha-por-nome, que não via um terceiro
    #    arquivo nascendo.
    citantes = {}
    for rel in arquivos_de_texto():
        texto = ler(rel)
        if not texto:
            continue
        numeros = sorted({int(n) for n in re.findall(r"(\d+)\s+casos", texto)})
        if numeros:
            citantes[rel] = numeros
    c.igual("'N casos' em *.md/*.html", citantes,
            {rel: [casos] for rel in citantes})

    # 2) README: a tabela das três pernas e o número da fumaça.
    readme = ler("README.md")
    if readme is None:
        c.pulado("README.md", "ausente")
    else:
        tabela = re.findall(
            r"(\d+) rodando, (\d+) pulados? \(`Ran (\d+)`\)", readme)
        c.igual("README · linhas da tabela",
                [[int(r), int(s), int(n)] for r, s, n in tabela],
                [[p["rodando"], p["skipped"], p["ran"]] for p in pernas])
        verificacoes = sorted({int(n) for n in re.findall(r"(\d+)\s+verificações", readme)})
        c.igual("README · verificações de fumaça",
                verificacoes, [fumaca] if verificacoes else [fumaca])

    # 3) Cartilha em PDF (a que o recrutador abre).
    pdf = textos_do_pdf(("docs", "cartilha-deploy.pdf"))
    if pdf is None:
        c.pulado("docs/cartilha-deploy.pdf", "pdftotext ausente ou PDF ilegível")
    else:
        achado = sorted({int(n) for n in re.findall(r"(\d+) casos de teste", pdf)})
        c.igual("cartilha PDF · 'N casos de teste'", achado, [casos] if achado else [casos])

    # 4) Rótulo do instrumento que mede a suíte (fora do repositório).
    if not os.path.exists(MEDIR):
        c.pulado(os.path.basename(MEDIR), "script ausente nesta máquina")
    else:
        with open(MEDIR, encoding="utf-8") as f:
            script = f.read()
        achado = [[int(a), int(b), int(d)] for a, b, d in re.findall(
            r"esperado: (\d+) rodando, OK \(skipped=(\d)\), Ran (\d+)", script)]
        c.igual("medir-modos-testes.sh · rótulos", achado,
                [[p["rodando"], p["skipped"], p["ran"]] for p in pernas])

    # 5) Opcional: medir de verdade, em vez de conferir o que está escrito.
    if "--medir" in sys.argv:
        print("\nMedindo a suíte nas três pernas (leva ~2 min)...")
        saida = subprocess.run(["bash", MEDIR], capture_output=True, text=True).stdout
        blocos = re.findall(
            r"Ran (\d+) tests? in [\d.]+s\s*\n\s*(OK|FAILED)(?: \(skipped=(\d+)\))?", saida)
        c.igual("suíte medida · (Ran, skipped, resultado)",
                [[int(r), int(s or 0), res] for r, res, s in blocos],
                [[p["ran"], p["skipped"], "OK"] for p in pernas])

    print()
    if c.falhas:
        print(f"{len(c.falhas)} divergência(s): os quatro lugares não contam a mesma coisa.")
        for f in c.falhas:
            print("  -", f)
        print("Atualize scripts/contagens.json e os arquivos que discordaram dele.")
        return 1
    pulados = f" ({len(c.pulados)} pulado(s))" if c.pulados else ""
    print(f"CONTAGENS OK — README, cartilha e rótulo do medir concordam{pulados}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
