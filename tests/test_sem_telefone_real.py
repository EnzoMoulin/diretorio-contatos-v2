#!/usr/bin/env python3
"""Privacidade do que fica publicado: nenhum contato real no repositório.

Regra dura do projeto: telefone sai da planilha já mascarado (`XXXX` no lugar
dos dígitos variáveis, mantendo o formato), e-mail fica no domínio fictício e
o dado de exemplo embutido no `app.py` usa o bloco `3333-00NN`. Nome de pessoa
também é dado real: a base de demonstração usa rótulo de unidade ("Gabinete de
Desembargador 01"), nunca o nome de quem atende. Este caso varre o seed
estruturado e a árvore inteira: se alguém reintroduzir um contato de verdade, o
CI fica vermelho antes de o repositório ser publicado.

O detector de nome de pessoa é espelho do `--seed` de
`diretorio-contatos-v3/scripts/varrer_privacidade.py`. A cópia existe porque o
seed mora aqui: a proteção não pode depender de rodar o script do outro
repositório. Se mexer nas listas de um lado, mexa no outro — o gabarito
`GABARITO_PESSOA` é o contrato que os dois têm de cumprir.
"""
import json
import os
import re
import unicodedata
import unittest

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED = os.path.join(RAIZ, "seed_mascarado.json")
PULAR_DIR = {".git", "node_modules", "__pycache__", "backups", "screenshots"}
PULAR_EXT = {".png", ".jpg", ".jpeg", ".mp4", ".pdf", ".ico", ".woff",
             ".woff2", ".db", ".sqlite", ".zip", ".pyc"}
TIPOS_TELEFONE = {"Telefone", "Ramal", "WhatsApp"}
# Telefone completo: DDD opcional + 8 ou 9 dígitos, com ou sem separadores.
TELEFONE = re.compile(
    r"(?<![\w-])(?:\(?\d{2}\)?[\s.\-]?)?\d{4,5}[\s.\-]?\d{4}(?![\w-])")
EXEMPLO = re.compile(r"\(27\) 3333-00\d\d")  # bloco do dado de exemplo
DOMINIO = "exemplo.jus.br"  # único domínio de e-mail aceito no seed

# --- detector de nome de pessoa --------------------------------------------
# Um nome de pessoa no seed aparece como "Alexandre Puppim" ou "Desembargador
# Fulano de Tal". Nome de unidade nunca é assim: ou tem número/ordinal ("1ª
# Vara"), ou tem palavra institucional ("Secretaria", "Gabinete", "Fórum"), ou
# é nome de cidade (campo de comarca, que não entra aqui).
CONECTORES = {"de", "da", "do", "das", "dos", "e"}
INSTITUCIONAIS = {
    "secretaria", "secao", "seção", "setor", "nucleo", "núcleo", "gabinete",
    "assessoria", "contadoria", "coordenadoria", "coordenacao", "coordenação",
    "diretoria", "divisao", "divisão", "servico", "serviço", "turma", "vara",
    "juizado", "cartorio", "cartório", "oficio", "ofício", "sala", "equipe",
    "unidade", "departamento", "gerencia", "gerência", "central", "atendimento",
    "apoio", "protocolo", "plenario", "plenário", "comissao", "comissão",
    "ouvidoria", "escola", "presidencia", "presidência", "vice", "corregedoria",
    "conselho", "tribunal", "forum", "fórum", "contatos", "geral", "gerais",
    "institucional", "judiciario", "judiciário", "predio", "prédio", "anexo",
    "sede", "justica", "justiça", "telefone", "email", "e-mail", "whatsapp",
    "ramal", "ajuda", "publico", "público", "recepcao", "recepção",
    "almoxarifado", "patrimonio", "patrimônio", "arquivo", "biblioteca",
    "auditorio", "auditório", "distribuicao", "distribuição", "certidoes",
    "certidões", "controle", "planejamento", "gestao", "gestão", "projetos",
    "estagio", "estágio", "pesquisa", "estatistica", "estatística", "imprensa",
    "cerimonial", "seguranca", "segurança", "copa", "balcao", "balcão",
    "guiche", "guichê", "cep", "endereco", "endereço", "telefonia",
    "informatica", "informática", "sistemas", "redes", "financeiro", "compras",
    "contratos", "licitacao", "licitação", "orcamento", "orçamento", "pessoal",
    "folha", "pagamento", "precatorio", "precatório", "magistrados", "chefia",
    "assistente", "assistentes", "analista", "agentes", "adjunto", "adjunta",
    "jecrim", "ceja", "nupemec", "pid", "help", "desk", "caixa", "fila",
    "infancia", "infância", "juventude", "criminais", "civeis", "cíveis",
    "reunidas", "manutencao", "manutenção", "predial", "instalacoes",
    "instalações", "eletricas", "elétricas", "transporte", "agendamento",
    "certidao", "certidão", "negativa", "escolta", "presos", "ordem",
    "advogados", "salao", "salão", "juri", "júri", "assessor", "juiz",
}
PROPRIA = re.compile(r"^[A-ZÁÉÍÓÚÂÊÔÃÕÇ][a-zà-ÿ]+\.?$")

# Pré-nomes comuns em português: é o sinal que separa "Alexandre Puppim" de
# "Manutenção Predial" — as duas têm duas palavras capitalizadas e nenhuma
# palavra institucional, mas só a primeira tem prenome. Sem esta lista o
# detector acusa todo rótulo de duas palavras do catálogo.
NOMES_PROPRIOS = set("""
alexandre arthur aldary dair debora eder eliana ewerton fabio fernando
helimar heloisa janete jorge jose julio luiz marcos marianne namyr pedro rachel
raphael robson samuel sergio ubiratan walace willian patricia simone ana andre
antonio bruno carlos catarina cristina daniel daniela davi diana diego eduardo
elaine elias emerson enzo estevão evandro felipe filipe gabriel gabriela gilberto
giovana gustavo helena henrique hugo igor isabel ivan jair joao joaquim juliana
karina laura leandro leonardo leticia lucas luciana manoel marcelo marcia maria
marcio mateus matheus mauro miguel monica nelson nicolas otavio paulo rafael
renata ricardo roberto rodrigo roger rogerio ronaldo rosa sandra silvana taina
tatiana teresa thiago tiago valeria vanessa veronica vera vinicius vitor wagner
wesley yuri rafaela camila carla claudia denise elisa fernanda flavia giovanna
iara joana kim lais larissa lorena lucia marta miriam nadia natalia priscila rita
sonia sueli tania viviane""".split())
HONORIFICOS = {"des", "desembargador", "desembargadora", "comissario",
               "comissaria", "dr", "dra", "juiz", "juiza"}

# O gabarito que os dois repos têm de cumprir: nome de pessoa entra, rótulo de
# unidade (mesmo com duas palavras capitalizadas) fica de fora.
GABARITO_PESSOA = {
    "pegar": ["Alexandre Puppim", "Janete Vargas Simões",
              "Débora Maria Ambos C. da Silva", "Comissária Patrícia Dantas",
              "Aldary Nunes Júnior", "Namyr Carlos de Souza Filho",
              "Comissário José Paulo", "Walace Pandolpho Kiffer"],
    "passar": ["Gabinete de Desembargador 01", "Comissário 03", "1ª Vara Cível",
               "10ª Secretaria Inteligente", "Contatos Gerais",
               "Fórum Desembargador Cassiano Ribeiro", "Presidência",
               "PID • Central de Atendimento", "Subsecretaria Geral",
               "Vara de Execuções Penais", "Atendimento geral",
               "Central de ajuda", "Sede Administrativa",
               "Criminais Reunidas", "Cíveis Reunidas", "Manutenção Predial",
               "Instalações Elétricas", "Transporte Agendamento",
               "Certidão Negativa", "Escolta de Presos", "Ordem dos Advogados",
               "Comissários da Infância e Juventude", "Salão do Júri",
               "Infância e Juventude", "Assessor do Juiz"],
}


def mascarado(valor):
    """Máscara `XXXX` ou o bloco fictício do exemplo: só isso passa."""
    return "X" in valor or bool(EXEMPLO.fullmatch(valor.strip()))


def sem_acento(texto):
    decomposto = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in decomposto if not unicodedata.combining(c)).lower()


def pessoa_provavel(nome):
    """True quando o rótulo tem cara de nome de pessoa, não de unidade.

    Precisa de prenome: duas palavras capitalizadas sozinhas não bastam, senão
    "Manutenção Predial" e "Cíveis Reunidas" entram como nome de pessoa.
    Honorífico também conta ("Comissária Simone"), e honorífico mascarado sai
    pelo teste de dígito ("Comissário 03").
    """
    if not nome or any(c.isdigit() for c in nome):
        return False
    palavras = [p for p in re.split(r"[\s]+", nome.strip()) if p]
    if not 2 <= len(palavras) <= 6:
        return False
    # compara sem acento: "Comissária Patrícia" tem de casar com as listas
    simples = [sem_acento(p).strip(".") for p in palavras]
    if any(p in INSTITUCIONAIS for p in simples):
        return False
    if not all(PROPRIA.match(p) or re.fullmatch(r"[A-ZÁÉÍÓÚÂÊÔÃÕÇ]\.", p)
               or p.lower() in CONECTORES for p in palavras):
        return False
    if simples[0] in HONORIFICOS:
        return True
    return any(p in NOMES_PROPRIOS for p in simples)


class TestSemTelefoneReal(unittest.TestCase):
    def test_seed_nao_guarda_contato_real(self):
        """Telefone e ramal com máscara; e-mail fictício; rótulo sem pessoa.

        Nome de pessoa entra no mesmo caso de propósito: é o terceiro tipo de
        dado real que o seed não pode guardar, e ele mora no rótulo (`desc` do
        contato, `nome` do nó), não no valor. Um caso novo só para o nome
        mudaria a contagem declarada em cinco lugares por nada.
        """
        for nome in GABARITO_PESSOA["pegar"]:
            self.assertTrue(pessoa_provavel(nome),
                            "o detector deixou passar nome de pessoa: %s" % nome)
        for nome in GABARITO_PESSOA["passar"]:
            self.assertFalse(pessoa_provavel(nome),
                             "o detector acusou rótulo de unidade: %s" % nome)

        with open(SEED, encoding="utf-8") as f:
            dados = json.load(f)
        for item in dados["contatos"] + dados["uteis"]:
            tipo, valor = item.get("tipo"), item.get("valor") or ""
            with self.subTest(id=item["id"], tipo=tipo):
                if tipo in TIPOS_TELEFONE:
                    self.assertTrue(mascarado(valor),
                                    "telefone/ramal sem a máscara XXXX")
                elif tipo == "E-mail":
                    self.assertTrue(valor.endswith("@" + DOMINIO),
                                    "e-mail fora do domínio fictício")

        # Comarca e fórum ficam de fora: comarca é nome de cidade e fórum
        # oficial pode homenagear desembargador — os dois são informação
        # pública e o projeto aceita.
        pessoas = []
        for colecao, campo in (("nos", "nome"), ("contatos", "desc"),
                              ("uteis", "nome")):
            for item in dados[colecao]:
                rotulo = str(item.get(campo, "")).strip()
                if pessoa_provavel(rotulo):
                    pessoas.append("%s:%s: %s" % (colecao, item.get("id"), rotulo))
        self.assertEqual(pessoas, [],
                         "nome de pessoa num rótulo do seed (o demo usa "
                         "\"Gabinete de Desembargador 01\")")

    def test_nenhum_arquivo_do_repo_tem_telefone_real(self):
        achados = []
        for base, dirs, arquivos in os.walk(RAIZ):
            dirs[:] = [d for d in dirs if d not in PULAR_DIR]
            for nome in arquivos:
                if os.path.splitext(nome)[1].lower() in PULAR_EXT:
                    continue
                caminho = os.path.join(base, nome)
                try:
                    with open(caminho, encoding="utf-8") as f:
                        texto = f.read()
                except (OSError, UnicodeDecodeError):
                    continue
                for achado in TELEFONE.finditer(texto):
                    if mascarado(achado.group()):
                        continue
                    linha = texto.count("\n", 0, achado.start()) + 1
                    achados.append("%s:%d: %s" % (
                        os.path.relpath(caminho, RAIZ), linha, achado.group()))
        self.assertEqual(achados, [],
                         "telefone fora do padrão sintético (XXXX ou 3333-00NN)")


if __name__ == "__main__":
    unittest.main(verbosity=2)
