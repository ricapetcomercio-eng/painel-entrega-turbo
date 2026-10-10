# -*- coding: utf-8 -*-
"""
enviar_fechamento.py -- envia o Fechamento Mensal (planilha Excel gerada
pelo sistema de fechamento em C:\\FECHAMENTO) para o painel
ricapetadministrativo (aba "Fechamento").

Roda no computador do Ricardo, NAO na Vercel. Le a planilha com openpyxl
(valores ja calculados pelo Excel), monta um JSON de UM mes por vez e manda
para /api/debug?tipo=fechamento-enviar, autenticado pelo CRON_SECRET.

Uso:
    python enviar_fechamento.py                     # mes mais recente
    python enviar_fechamento.py --mes "26 - Agosto" # um mes especifico
    python enviar_fechamento.py --todos             # todo o historico
    python enviar_fechamento.py --simular           # so le e mostra, nao envia

Configuracao (URL e segredo NUNCA ficam no repositorio): arquivo
C:\\FECHAMENTO\\painel_config.ini (modelo em painel_config.exemplo.ini) ou
variaveis de ambiente PAINEL_URL / PAINEL_SECRET.

Privacidade: a coluna OBS dos lancamentos nunca e enviada, e qualquer
sequencia com cara de CPF/CNPJ e removida dos textos antes do envio.
"""

import argparse
import configparser
import datetime as dt
import glob
import json
import os
import re
import sys
import unicodedata

try:
    import openpyxl
except ImportError:
    print('ERRO: falta instalar o openpyxl. Rode:  py -m pip install openpyxl')
    sys.exit(2)

VERSAO_FORMATO = 1

MESES = {
    'janeiro': 1, 'fevereiro': 2, 'marco': 3, 'abril': 4, 'maio': 5, 'junho': 6,
    'julho': 7, 'agosto': 8, 'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12,
}

# Nome canonico de cada canal -- o bloco de faturamento usa "ML", a tabela
# de produtos usa "MERCADO LIVRE"; os dois viram "Mercado Livre" pra a tela
# conseguir cruzar.
CANAIS = {
    'ml': 'Mercado Livre', 'mercado livre': 'Mercado Livre', 'mercadolivre': 'Mercado Livre',
    'shopee': 'Shopee', 'magalu': 'Magalu', 'site': 'Site', 'amazon': 'Amazon',
    'shein': 'Shein', 'b2w': 'B2W', 'americanas': 'B2W',
}

TIPOS_VARIACAO = ('cor', 'modelo', 'tamanho', 'cores', 'modelos')

COLUNAS_PRODUTO = {
    'unidades': 'unidades',
    'valor unitario': 'valor_unitario',
    'valor de entrada': 'valor_entrada',
    'custo unitario': 'custo_unitario',
    'custo total': 'custo_total',
    'lucro por unidade': 'lucro_unitario',
    'lucro total': 'lucro_total',
}


class ErroFechamento(Exception):
    """Erro com mensagem pronta pra mostrar ao Ricardo."""


# ---------------------------------------------------------------- utilitarios

def norm(valor):
    if valor is None:
        return ''
    s = str(valor)
    s = unicodedata.normalize('NFKD', s)
    s = ''.join(ch for ch in s if not unicodedata.combining(ch))
    return re.sub(r'\s+', ' ', s).strip().lower()


def eh_numero(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float('inf'), float('-inf'))


RE_NUM_TEXTO = re.compile(r'^\(?-?\s*(R\$)?\s*-?[\d.]+(,\d+)?\)?$')


def num_flex(v):
    """Como num(), mas tambem aceita numero digitado como texto
    ("R$ 1.234,56", "(1.234,56)" = negativo)."""
    if eh_numero(v):
        return float(v)
    if not isinstance(v, str):
        return None
    t = v.strip().replace('\xa0', ' ')
    if not t or not RE_NUM_TEXTO.match(t):
        return None
    negativo = t.startswith('(') or '-' in t
    t = re.sub(r'[^\d,.]', '', t).replace('.', '').replace(',', '.')
    try:
        x = float(t)
    except ValueError:
        return None
    return -x if negativo else x


def num(v):
    return float(v) if eh_numero(v) else None


def texto(v):
    if v is None:
        return ''
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%Y-%m-%d')
    return re.sub(r'\s+', ' ', str(v)).strip()


RE_CPF = re.compile(r'\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}\b')
RE_CNPJ = re.compile(r'\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-.\s]?\d{2}\b')
RE_DIGITOS_LONGOS = re.compile(r'\d[\d.\-/\s]{9,}\d')


def sem_documento(s):
    """Remove qualquer coisa com cara de CPF/CNPJ (ou sequencia longa de
    digitos) de um texto livre."""
    s = texto(s)
    if not s:
        return ''
    s = RE_CNPJ.sub('', s)
    s = RE_CPF.sub('', s)
    s = RE_DIGITOS_LONGOS.sub(lambda m: '' if len(re.sub(r'\D', '', m.group(0))) >= 11 else m.group(0), s)
    s = re.sub(r'\b(cpf|cnpj)\s*[:.-]?\s*', '', s, flags=re.I)
    return re.sub(r'\s{2,}', ' ', s).strip(' -:/,')


def mes_da_aba(nome):
    """'26 - Setembro' / '25- Maio' / '22-Setembro' / '23- Julho ' -> (2026, 9)."""
    m = re.match(r'^\s*(\d{2})\s*-\s*([A-Za-z\u00c0-\u00ff]+)\s*$', nome or '')
    if not m:
        return None
    mes = MESES.get(norm(m.group(2)))
    if not mes:
        return None
    return 2000 + int(m.group(1)), mes


def letra_coluna(c):
    return openpyxl.utils.get_column_letter(c)


class Aba:
    """Acesso 1-indexado (linha, coluna) aos valores ja calculados."""

    def __init__(self, ws_valores, ws_formulas):
        self.nome = ws_valores.title
        self.linhas = [list(r) for r in ws_valores.iter_rows(values_only=True)]
        self.formulas = [list(r) for r in ws_formulas.iter_rows(values_only=True)] if ws_formulas is not None else None
        self.max_linha = len(self.linhas)
        self.max_coluna = max((len(r) for r in self.linhas), default=0)

    def v(self, r, c):
        if r < 1 or c < 1 or r > self.max_linha:
            return None
        linha = self.linhas[r - 1]
        return linha[c - 1] if c <= len(linha) else None

    def formula(self, r, c):
        if self.formulas is None or r < 1 or c < 1 or r > len(self.formulas):
            return None
        linha = self.formulas[r - 1]
        f = linha[c - 1] if c <= len(linha) else None
        return f if isinstance(f, str) and f.startswith('=') else None

    def celulas(self):
        for r, linha in enumerate(self.linhas, start=1):
            for c, v in enumerate(linha, start=1):
                if v is not None:
                    yield r, c, v

    def achar(self, rotulo_norm, coluna=None):
        for r, c, v in self.celulas():
            if isinstance(v, str) and norm(v) == rotulo_norm and (coluna is None or c == coluna):
                return r, c
        return None


# ------------------------------------------------------- formulas sem valor

def checar_formulas_calculadas(aba):
    """Planilha salva por script (e nao pelo Excel) fica com as formulas sem
    valor calculado -- com data_only=True elas vem como None. Mandar isso
    viraria um mes inteiro de zeros na tela; melhor parar com aviso claro."""
    if aba.formulas is None:
        return
    total = sem_valor = 0
    for r, linha in enumerate(aba.formulas, start=1):
        for c, f in enumerate(linha, start=1):
            if isinstance(f, str) and f.startswith('='):
                total += 1
                if aba.v(r, c) is None:
                    sem_valor += 1
    if total >= 10 and sem_valor / total > 0.3:
        raise ErroFechamento(
            f'A aba "{aba.nome}" tem {sem_valor} de {total} formulas SEM valor calculado. '
            'Isso acontece quando a planilha foi salva por um programa e nao pelo Excel. '
            'Abra o arquivo no Excel, aperte Ctrl+S para salvar e rode este envio de novo.'
        )


# ----------------------------------------------------------- blocos da aba

def ler_metas(aba):
    cab = None
    for r, c, v in aba.celulas():
        if norm(v) == 'resultado':
            linha = {norm(aba.v(r, cc)): cc for cc in range(max(1, c - 6), c + 1)}
            if 'meta' in linha and 'porcentagem' in linha:
                cab = (r, linha)
                break
    if not cab:
        return [], None
    r0, cols = cab
    c_valor = cols.get('valor', cols['porcentagem'] - 1)
    c_rotulo = c_valor - 1
    metas, vazias = [], 0
    for r in range(r0 + 1, r0 + 15):
        rotulo = texto(aba.v(r, c_rotulo))
        if not rotulo:
            vazias += 1
            if metas and vazias >= 2:
                break
            continue
        vazias = 0
        n = norm(rotulo)
        tipo = 'custo' if any(p in n for p in ('taxa', 'cmv', 'custo', 'despesa', 'imposto')) else 'resultado'
        metas.append({
            'linha': rotulo,
            'tipo': tipo,
            'valor': num(aba.v(r, c_valor)),
            'porcentagem': num(aba.v(r, cols['porcentagem'])),
            'meta': num(aba.v(r, cols['meta'])),
            'resultado_planilha': num(aba.v(r, cols['resultado'])),
        })
    regiao = (r0, r0 + 15, c_rotulo)
    return metas, regiao


CAMPOS_RESUMO = [
    ('faturamento bruto', 'faturamento_bruto'), ('lucro bruto', 'lucro_bruto'),
    ('custos mensais', 'custos_mensais'), ('lucro liquido', 'lucro_liquido'), ('lucro empresa', 'lucro_empresa'),
]


def rotulo_norm(v):
    """Rotulo normalizado sem pontuacao no fim ("Faturamento Bruto:" -> "faturamento bruto")."""
    return re.sub(r'[\s:=.\-]+$', '', norm(v))


def valor_ao_lado(aba, r, c, aceita_texto=False):
    """Primeiro valor a direita do rotulo (ate 5 colunas); se nao houver, o
    de baixo. Numero digitado como texto tambem vale."""
    for rr, cc in [(r, c + k) for k in range(1, 6)] + [(r + 1, c)]:
        v = aba.v(rr, cc)
        if v is None or (isinstance(v, str) and not v.strip()):
            continue
        if num_flex(v) is not None:
            return v
        if isinstance(v, str) and rotulo_norm(v) and (rr, cc) != (r + 1, c):
            return v if aceita_texto else None
    return None


def ler_resumo(aba, regiao_metas, metas=None):
    # Pode haver mais de um "Custos Mensais" na aba (ex.: em outro bloco);
    # usa o primeiro que tiver o Faturamento Bruto por perto.
    ocorrencias = [(r, c) for r, c, v in aba.celulas() if isinstance(v, str) and rotulo_norm(v).startswith('custos mensais')]
    if not ocorrencias:
        raise ErroFechamento(f'Nao achei o rotulo "Custos Mensais" na aba "{aba.nome}" (layout antigo ou diferente). '
                             'Rode com --diagnostico e mande o print.')
    melhor = None
    for r_custos, col in ocorrencias:
        resumo = {'bonus': []}
        for r in range(max(1, r_custos - 10), r_custos + 14):
            if regiao_metas and regiao_metas[0] <= r <= regiao_metas[1] and regiao_metas[2] == col:
                continue
            rotulo = texto(aba.v(r, col))
            n = rotulo_norm(rotulo)
            if not n:
                continue
            chave = next((k for prefixo, k in CAMPOS_RESUMO if n.startswith(prefixo)), None)
            if chave and chave not in resumo:
                resumo[chave] = num_flex(valor_ao_lado(aba, r, col))
            elif n.startswith('retirada') and 'retirada_socios' not in resumo:
                valor = valor_ao_lado(aba, r, col, aceita_texto=True)
                resumo['retirada_socios'] = num_flex(valor)
                if resumo['retirada_socios'] is None and valor is not None:
                    resumo['retirada_socios_texto'] = texto(valor)
            elif n.startswith('bonus'):
                resumo['bonus'].append({'rotulo': rotulo, 'valor': num_flex(valor_ao_lado(aba, r, col))})
        if melhor is None or (resumo.get('faturamento_bruto') is not None and melhor[0].get('faturamento_bruto') is None):
            melhor = (resumo, col)
        if resumo.get('faturamento_bruto') is not None:
            break
    resumo, col = melhor
    # Plano B: o quadro de metas tambem tem o valor em R$ de Faturamento
    # Bruto e Lucro liquido (coluna "Valor").
    for m in metas or []:
        n = rotulo_norm(m['linha'])
        if n.startswith('faturamento') and resumo.get('faturamento_bruto') is None:
            resumo['faturamento_bruto'] = m['valor']
        if n.startswith('lucro liquido') and resumo.get('lucro_liquido') is None:
            resumo['lucro_liquido'] = m['valor']
    if resumo.get('faturamento_bruto') is None:
        raise ErroFechamento(f'Nao achei o valor de "Faturamento Bruto" no resumo da aba "{aba.nome}". '
                             'Rode de novo com --diagnostico e mande o print da janela (ele nao mostra valores).')
    return resumo, col


def diagnostico(aba):
    """Mostra ONDE o script achou cada rotulo e o TIPO das celulas ao lado
    (numero / texto / formula sem valor / vazio) -- nunca o valor em si."""
    def tipo(r, c):
        v = aba.v(r, c)
        if v is None:
            return 'formula SEM valor' if aba.formula(r, c) else 'vazio'
        if eh_numero(v):
            return 'numero'
        if isinstance(v, (dt.datetime, dt.date)):
            return 'data'
        return 'numero em texto' if num_flex(v) is not None else f'texto "{texto(v)[:25]}"'
    procurados = ('faturamento', 'custos mensais', 'lucro', 'retirada', 'resultado', 'porcentagem', 'meta',
                  'referencia', 'unidades', 'algo errado', 'total geral')
    print(f'--- Diagnostico da aba "{aba.nome}" ({aba.max_linha} linhas x {aba.max_coluna} colunas) ---')
    achou = 0
    for r, c, v in aba.celulas():
        if not isinstance(v, str):
            continue
        n = rotulo_norm(v)
        if any(n.startswith(p) for p in procurados) and len(n) <= 40:
            achou += 1
            if achou > 60:
                print('  ... (mais rotulos omitidos)')
                break
            lado = ' | '.join(tipo(r, c + k) for k in range(1, 5))
            print(f'  {letra_coluna(c)}{r}: "{texto(v)[:40]}" -> a direita: {lado} ; abaixo: {tipo(r + 1, c)}')
    if not achou:
        print('  Nenhum rotulo conhecido encontrado nesta aba.')
    print('--- fim do diagnostico (nenhum valor foi mostrado nem enviado) ---')


def ler_conferencias(aba, col_resumo):
    itens = []
    for r, c, v in aba.celulas():
        if not isinstance(v, str):
            continue
        n = norm(v)
        if n == 'algo errado' or (n == 'ok' and c == col_resumo):
            # Rotulo so da celula IMEDIATAMENTE a esquerda: ir mais longe
            # pegava nome de produto de outro bloco (ex.: "Lavavel" na T45).
            esquerda = aba.v(r, c - 1)
            rotulo = texto(esquerda) if isinstance(esquerda, str) and norm(esquerda) not in ('ok', 'algo errado') else ''
            itens.append({'celula': f'{letra_coluna(c)}{r}', 'status': 'erro' if n == 'algo errado' else 'ok', 'rotulo': rotulo[:80]})
    return itens


def colunas_canal_categoria(aba):
    """Acha as colunas 'canal' dos blocos canal x categoria (M e P no layout
    atual) pelos nomes de canal, sem depender de posicao fixa."""
    contagem = {}
    for r, c, v in aba.celulas():
        if isinstance(v, str) and norm(v) in CANAIS:
            contagem[c] = contagem.get(c, 0) + 1
    candidatas = []
    for c, qtd in sorted(contagem.items()):
        if qtd < 2:
            continue
        # A tabela de produtos (coluna B) tem "Cor"/"Modelo" logo ao lado.
        vizinho = {norm(aba.v(r, c + 1)) for r in range(1, aba.max_linha + 1)}
        if vizinho & set(TIPOS_VARIACAO):
            continue
        numericos = sum(1 for r in range(1, aba.max_linha + 1) if eh_numero(aba.v(r, c + 2)))
        if numericos >= 2:
            candidatas.append(c)
    return candidatas


def ler_canal_categoria(aba, c):
    canais, atual, total, vazias = [], None, None, 0
    inicio = next((r for r in range(1, aba.max_linha + 1) if norm(aba.v(r, c)) in CANAIS), None)
    if inicio is None:
        return [], None
    for r in range(inicio, aba.max_linha + 1):
        m, n, o = aba.v(r, c), aba.v(r, c + 1), aba.v(r, c + 2)
        if m is None and n is None and o is None:
            vazias += 1
            if vazias >= 25:
                break
            continue
        vazias = 0
        nm = norm(m)
        if nm == 'total':
            total = num(o)
            break
        if nm in CANAIS:
            atual = {'canal': CANAIS[nm], 'rotulo': texto(m), 'categorias': [], 'subtotal': None}
            canais.append(atual)
        if atual is None or not eh_numero(o):
            continue
        nn = norm(n)
        if not nn:
            atual['subtotal'] = float(o)
        elif nn != 'ok' and not nn.startswith('#') and not eh_numero(n):
            atual['categorias'].append({'categoria': sem_documento(n)[:80], 'valor': float(o)})
    for cn in canais:
        soma = sum(x['valor'] for x in cn['categorias'])
        cn['total'] = cn['subtotal'] if cn['subtotal'] is not None else soma
        del cn['subtotal']
    return canais, total


def ler_produtos(aba):
    cabecalhos = []
    for r, c, v in aba.celulas():
        if isinstance(v, str) and norm(v) in TIPOS_VARIACAO and norm(aba.v(r, c + 1)) == 'unidades':
            cabecalhos.append((r, c))
    if not cabecalhos:
        return [], None
    c_tipo = cabecalhos[0][1]
    c_nome = c_tipo - 1

    def mapa_colunas(r):
        mapa = {}
        for cc in range(c_tipo + 1, c_tipo + 12):
            chave = COLUNAS_PRODUTO.get(norm(aba.v(r, cc)))
            if chave and chave not in mapa:
                mapa[chave] = cc
        if 'lucro_total' in mapa:
            mapa['margem'] = mapa['lucro_total'] + 1
        return mapa

    padrao = mapa_colunas(cabecalhos[0][0])
    linhas_cab = {r for r, c in cabecalhos if c == c_tipo}

    def valores(r, mapa):
        return {k: num(aba.v(r, cc)) for k, cc in mapa.items()}

    canais, canal, produto, subgrupo, total_geral = [], None, None, None, None
    mapa = padrao
    for r in range(1, aba.max_linha + 1):
        b, cc = aba.v(r, c_nome), aba.v(r, c_tipo)
        nb, ncc = norm(b), norm(cc)
        if nb == 'total geral':
            total_geral = valores(r, padrao)
            break
        if r in linhas_cab:
            mapa = mapa_colunas(r) or padrao
            if canal is None:
                canal = {'canal': 'Sem canal', 'rotulo': '', 'produtos': [], 'total': None}
                canais.append(canal)
            produto = {'nome': sem_documento(b)[:80] or 'Produto', 'tipo_variacao': texto(cc), 'variacoes': [], 'subtotais': [], 'total': None}
            canal['produtos'].append(produto)
            subgrupo = None
            continue
        vals = valores(r, mapa)
        tem_numero = any(x is not None for x in vals.values())
        if nb == 'total' or nb.startswith('total '):
            if canal is not None:
                canal['total'] = valores(r, padrao)
            produto, subgrupo = None, None
            continue
        if nb in CANAIS and not ncc and not tem_numero:
            canal = {'canal': CANAIS[nb], 'rotulo': texto(b), 'produtos': [], 'total': None}
            canais.append(canal)
            produto, subgrupo = None, None
            continue
        if produto is None:
            continue
        if ncc:
            if nb:
                subgrupo = texto(b)[:40]
            if tem_numero:
                produto['variacoes'].append(dict(nome=sem_documento(cc)[:60], subgrupo=subgrupo, **vals))
        elif nb and not tem_numero:
            subgrupo = texto(b)[:40]
        elif tem_numero:
            if produto['total'] is not None:
                produto['subtotais'].append(produto['total'])
            produto['total'] = dict(vals, subgrupo=texto(b)[:40] or None)
    for cn in canais:
        for p in cn['produtos']:
            if p['total'] is None and p['variacoes']:
                p['total'] = {k: sum(v[k] or 0 for v in p['variacoes']) for k in ('unidades', 'valor_entrada', 'custo_total', 'lucro_total')}
                p['total']['calculado'] = True
            if not p['subtotais']:
                del p['subtotais']
    return [cn for cn in canais if cn['produtos'] or cn['total']], total_geral


def ler_lancamentos(aba):
    cab = None
    for r, c, v in aba.celulas():
        if norm(v) == 'referencia':
            linha = {norm(aba.v(r, cc)): cc for cc in range(max(1, c - 4), c + 6)}
            if 'valor' in linha and 'categoria' in linha:
                cab = (r, linha)
                break
    if not cab:
        return [], None
    r0, cols = cab
    c_data, c_valor = cols.get('data'), cols['valor']
    c_ref, c_cat, c_onde = cols['referencia'], cols['categoria'], cols.get('onde')
    c_obs = cols.get('obs', (c_onde or c_cat) + 1)
    itens, vazias = [], 0
    for r in range(r0 + 1, aba.max_linha + 1):
        valor = aba.v(r, c_valor)
        if not eh_numero(valor):
            if all(aba.v(r, cc) is None for cc in (c_valor, c_ref, c_cat)):
                vazias += 1
                if vazias >= 15:
                    break
            continue
        vazias = 0
        d = aba.v(r, c_data) if c_data else None
        itens.append({
            'data': d.strftime('%Y-%m-%d') if isinstance(d, (dt.datetime, dt.date)) else texto(d)[:20],
            'valor': float(valor),
            'referencia': sem_documento(aba.v(r, c_ref))[:60],
            'categoria': sem_documento(aba.v(r, c_cat))[:60],
            # OBS nunca e enviada (as vezes tem CPF); ONDE vai sem CPF/CNPJ.
            'onde': sem_documento(aba.v(r, c_onde))[:80] if c_onde else '',
        })
    return itens, c_obs


def ler_investimentos(aba, c_obs):
    inicio, col = None, None
    for r, c, v in aba.celulas():
        if isinstance(v, str) and 'investimento' in norm(v) and (c_obs is None or c > c_obs):
            inicio, col = r, c
            break
    if col is None:
        if c_obs is None:
            return []
        inicio, col = 1, c_obs + 2  # layout atual: AG/AH, logo depois de OBS
    itens = []
    for r in range(inicio + 1 if inicio > 1 else 1, aba.max_linha + 1):
        a, b = aba.v(r, col), aba.v(r, col + 1)
        if eh_numero(a) and isinstance(b, str) and norm(b) and not norm(b).startswith('total'):
            itens.append({'valor': float(a), 'descricao': sem_documento(b)[:100]})
        elif eh_numero(b) and isinstance(a, str) and norm(a) and not norm(a).startswith('total'):
            itens.append({'valor': float(b), 'descricao': sem_documento(a)[:100]})
    return itens


def montar_fechamento(aba, ano, mes, arquivo):
    checar_formulas_calculadas(aba)
    metas, regiao = ler_metas(aba)
    resumo, col_resumo = ler_resumo(aba, regiao, metas)
    cols = colunas_canal_categoria(aba)
    fat_canais, fat_total = ler_canal_categoria(aba, cols[0]) if len(cols) >= 1 else ([], None)
    luc_canais, luc_total = ler_canal_categoria(aba, cols[1]) if len(cols) >= 2 else ([], None)
    produtos, total_geral = ler_produtos(aba)
    lancamentos, c_obs = ler_lancamentos(aba)
    avisos = []
    if not metas:
        avisos.append('Quadro de metas nao encontrado.')
    if not fat_canais:
        avisos.append('Faturamento por canal x categoria nao encontrado.')
    if not luc_canais:
        avisos.append('Lucro por canal x categoria nao encontrado.')
    if not produtos:
        avisos.append('Tabela de produtos nao encontrada.')
    if not lancamentos:
        avisos.append('Lancamentos de custos nao encontrados.')
    return {
        'versao_formato': VERSAO_FORMATO,
        'mes': f'{ano:04d}-{mes:02d}',
        'aba': aba.nome.strip(),
        'arquivo': os.path.basename(arquivo),
        'gerado_em': dt.datetime.now().astimezone().isoformat(timespec='seconds'),
        # De onde veio o envio -- hoje o PC do Ricardo; no futuro pode ser um
        # servidor rodando o fechamento, mandando o MESMO JSON pra mesma rota.
        'origem': os.environ.get('PAINEL_ORIGEM') or 'script-local',
        'resumo': resumo,
        'metas': metas,
        'conferencias': ler_conferencias(aba, col_resumo),
        'faturamento_canais': fat_canais,
        'faturamento_total': fat_total,
        'lucro_canais': luc_canais,
        'lucro_total': luc_total,
        'produtos': produtos,
        'produtos_total_geral': total_geral,
        'lancamentos': lancamentos,
        'investimentos': ler_investimentos(aba, c_obs),
        'avisos': avisos,
    }


# ----------------------------------------------------------- config / envio

def carregar_config(caminho_arg):
    candidatos = [caminho_arg, os.environ.get('PAINEL_FECHAMENTO_CONFIG'),
                  r'C:\FECHAMENTO\painel_config.ini',
                  os.path.join(os.path.dirname(os.path.abspath(__file__)), 'painel_config.ini')]
    cfg = configparser.ConfigParser()
    usado = None
    for c in candidatos:
        if c and os.path.isfile(c):
            cfg.read(c, encoding='utf-8')
            usado = c
            break
    conf = {
        'url': os.environ.get('PAINEL_URL') or cfg.get('painel', 'url', fallback=''),
        'secret': os.environ.get('PAINEL_SECRET') or cfg.get('painel', 'secret', fallback=''),
        'pasta': cfg.get('planilha', 'pasta', fallback=r'C:\FECHAMENTO\05 FECHAMENTOS'),
        'padrao': cfg.get('planilha', 'padrao', fallback='Fechamento_*.xlsx'),
        'arquivo_config': usado,
    }
    conf['url'] = conf['url'].strip().rstrip('/')
    conf['secret'] = conf['secret'].strip()
    return conf


def achar_planilha(conf):
    """Padrao do fechamento: C:\\FECHAMENTO\\05 FECHAMENTOS\\AAAA_MM\\Fechamento_<Mes>_<AA>.xlsx.
    Pega a subpasta AAAA_MM mais recente (pelo NOME, nao pela data do
    arquivo) e, dentro dela, o Fechamento_*.xlsx mais recente. Sem subpastas
    AAAA_MM, procura direto na pasta configurada."""
    pasta = conf['pasta']
    if not os.path.isdir(pasta):
        raise ErroFechamento(f'Pasta nao encontrada: "{pasta}". Ajuste [planilha] pasta no painel_config.ini ou use --arquivo.')
    meses = sorted(d for d in os.listdir(pasta)
                   if re.match(r'^\d{4}_\d{2}$', d) and os.path.isdir(os.path.join(pasta, d)))
    for d in reversed(meses) if meses else [None]:
        base = os.path.join(pasta, d) if d else pasta
        arquivos = [a for a in glob.glob(os.path.join(base, conf['padrao'])) if not os.path.basename(a).startswith('~$')]
        if arquivos:
            return max(arquivos, key=os.path.getmtime)
    onde = os.path.join(pasta, 'AAAA_MM' if meses else '', conf['padrao'])
    raise ErroFechamento(f'Nenhuma planilha encontrada em "{onde}". Ajuste [planilha] pasta/padrao no painel_config.ini ou use --arquivo.')


def enviar(conf, fechamento):
    url = f"{conf['url']}/api/debug?tipo=fechamento-enviar"
    corpo = json.dumps({'fechamento': fechamento}, ensure_ascii=False).encode('utf-8')
    headers = {'Content-Type': 'application/json; charset=utf-8'}
    try:
        import requests  # opcional; sem ele usa urllib
    except ImportError:
        requests = None
    if requests is not None:
        try:
            resp = requests.post(url, params={'secret': conf['secret']}, data=corpo, headers=headers, timeout=60)
        except requests.RequestException as e:
            raise ErroFechamento(f'Nao consegui falar com o painel ({conf["url"]}). Confira a internet e a url no painel_config.ini. Detalhe: {e.__class__.__name__}')
        status, texto_resp = resp.status_code, resp.text
    else:
        import urllib.error
        import urllib.parse
        import urllib.request
        req = urllib.request.Request(url + '&secret=' + urllib.parse.quote(conf['secret']), data=corpo, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                status, texto_resp = r.status, r.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as e:
            status, texto_resp = e.code, e.read().decode('utf-8', 'replace')
        except (urllib.error.URLError, OSError) as e:
            raise ErroFechamento(f'Nao consegui falar com o painel ({conf["url"]}). Confira a internet e a url no painel_config.ini. Detalhe: {e}')
    try:
        dados = json.loads(texto_resp)
    except ValueError:
        dados = {'error': texto_resp[:300]}
    if status == 401:
        raise ErroFechamento('O painel recusou o segredo (401). Confira o "secret" no painel_config.ini (e o CRON_SECRET da Vercel).')
    if status >= 300 or not dados.get('ok'):
        raise ErroFechamento(f'O painel respondeu erro {status}: {dados.get("error") or dados}')
    return dados


def main():
    try:
        sys.stdout.reconfigure(errors='replace')  # console do Windows com acento
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='Envia o Fechamento Mensal para o painel ricapetadministrativo.')
    ap.add_argument('--arquivo', help='Caminho do .xlsx (padrao: o mais recente que bate com [planilha] no painel_config.ini)')
    ap.add_argument('--mes', help='Nome da aba, ex.: "26 - Agosto" (padrao: o mes mais recente)')
    ap.add_argument('--todos', action='store_true', help='Envia todos os meses da planilha (historico)')
    ap.add_argument('--config', help='Caminho do painel_config.ini')
    ap.add_argument('--simular', action='store_true', help='So le a planilha e mostra o resumo, sem enviar')
    ap.add_argument('--diagnostico', action='store_true', help='Mostra onde achou cada rotulo (sem valores) e nao envia nada')
    ap.add_argument('--salvar-json', help='Salva o JSON gerado neste arquivo (para conferencia)')
    args = ap.parse_args()

    try:
        conf = carregar_config(args.config)
        arquivo = args.arquivo or achar_planilha(conf)
        if not os.path.isfile(arquivo):
            raise ErroFechamento(f'Arquivo nao encontrado: {arquivo}')
        if not (args.simular or args.diagnostico) and (not conf['url'] or not conf['secret']):
            raise ErroFechamento('Falta configurar url e secret em C:\\FECHAMENTO\\painel_config.ini (veja painel_config.exemplo.ini).')

        print(f'Lendo {arquivo} ...')
        wb_val = openpyxl.load_workbook(arquivo, data_only=True)
        wb_form = openpyxl.load_workbook(arquivo, data_only=False)

        abas_mes = []
        for nome in wb_val.sheetnames:
            am = mes_da_aba(nome)
            if am:
                abas_mes.append((am, nome))
        if not abas_mes:
            raise ErroFechamento('Nenhuma aba de mes encontrada (esperado nome tipo "26 - Setembro").')
        abas_mes.sort()

        if args.todos:
            escolhidas = abas_mes
        elif args.mes:
            alvo = norm(args.mes).replace(' ', '')
            escolhidas = [x for x in abas_mes if norm(x[1]).replace(' ', '') == alvo]
            if not escolhidas:
                raise ErroFechamento(f'Aba "{args.mes}" nao encontrada. Abas de mes: ' + ', '.join(n.strip() for _, n in abas_mes))
        else:
            escolhidas = [abas_mes[-1]]

        enviados, pulados, gerados = 0, [], []
        for (ano, mes), nome in escolhidas:
            try:
                aba = Aba(wb_val[nome], wb_form[nome])
                if args.diagnostico:
                    diagnostico(aba)
                    continue
                fech = montar_fechamento(aba, ano, mes, arquivo)
            except ErroFechamento as e:
                if not args.todos:
                    raise
                pulados.append((nome.strip(), str(e)))
                print(f'  - {nome.strip()}: PULADO ({e})')
                continue
            gerados.append(fech)
            r = fech['resumo']
            linha = (f"  - {nome.strip()} ({fech['mes']}): faturamento {r.get('faturamento_bruto') or 0:,.2f} | "
                     f"lucro liquido {r.get('lucro_liquido') or 0:,.2f} | {len(fech['lancamentos'])} lancamentos")
            erros = [c for c in fech['conferencias'] if c['status'] == 'erro']
            if erros:
                linha += f" | ATENCAO: conferencia 'Algo Errado' em {', '.join(c['celula'] for c in erros)}"
            if args.simular:
                print(linha + ' [simulacao, nao enviado]')
            else:
                enviar(conf, fech)
                enviados += 1
                print(linha + ' -> ENVIADO')
            for a in fech['avisos']:
                print(f'      aviso: {a}')

        if args.salvar_json:
            with open(args.salvar_json, 'w', encoding='utf-8') as f:
                json.dump(gerados if len(gerados) != 1 else gerados[0], f, ensure_ascii=False, indent=2)
            print(f'JSON salvo em {args.salvar_json}')

        print()
        if args.diagnostico:
            print('Diagnostico concluido, nada enviado. Mande um print desta janela.')
        elif args.simular:
            print(f'Simulacao concluida: {len(gerados)} mes(es) lido(s), nada enviado.')
        else:
            print(f'Pronto! {enviados} mes(es) enviado(s) para o painel.')
        if pulados:
            print(f'{len(pulados)} aba(s) pulada(s) (layout antigo ou incompleto) -- veja acima.')
        return 0
    except ErroFechamento as e:
        print()
        print('ERRO: ' + str(e))
        return 1


if __name__ == '__main__':
    sys.exit(main())
