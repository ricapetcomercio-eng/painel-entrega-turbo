#!/usr/bin/env python3
"""Confere se os valores documentados na skill ricapet-expedicao ainda
batem com o codigo. So LE arquivos; nao altera nada.

Uso (na raiz do repo):
  python3 .claude/skills/ricapet-expedicao/scripts/conferir_constantes.py

Saida: uma linha por item -- "ok" ou "DIFERENTE" (com o trecho atual do
codigo). Sai com codigo 1 se algo mudou: aí o codigo e a verdade -- avise
e atualize a skill no mesmo PR.
"""
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[4]

# (descricao, arquivo, regex que precisa casar, trecho para mostrar se falhar)
CHECAGENS = [
    ('Gate geral / Flex = 5 min', 'api/collect.js', r'INTERVALO_MINIMO_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000', r'INTERVALO_MINIMO_MS\s*=.*'),
    ('Shopee = 15 min', 'api/collect.js', r'INTERVALO_MINIMO_SHOPEE_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000', r'INTERVALO_MINIMO_SHOPEE_MS\s*=.*'),
    ('Todos ML = 5 min', 'api/collect.js', r'INTERVALO_MINIMO_TODOS_ML_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000', r'INTERVALO_MINIMO_TODOS_ML_MS\s*=.*'),
    ('Devolucoes = 30 min', 'api/collect.js', r'INTERVALO_MINIMO_DEVOLUCOES_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000', r'INTERVALO_MINIMO_DEVOLUCOES_MS\s*=.*'),
    ('Atraso semana = 30 min', 'api/collect.js', r'INTERVALO_MINIMO_ATRASO_SEMANA_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000', r'INTERVALO_MINIMO_ATRASO_SEMANA_MS\s*=.*'),
    ('Flex sem SLA: limite 21h', 'lib/mlFlexOrders.js', r'HORA_LIMITE_ENTREGA\s*=\s*21\b', r'HORA_LIMITE_ENTREGA\s*=.*'),
    ('Turbo ML = 3h', 'lib/mlFlexOrders.js', r'HORAS_TURBO\s*=\s*3\b', r'HORAS_TURBO\s*=.*'),
    ('Agora = 25 min', 'lib/mlFlexOrders.js', r'MINUTOS_ENVIOS_AGORA\s*=\s*25\b', r'MINUTOS_ENVIOS_AGORA\s*=.*'),
    ('Turbo Shopee = carrier "turbo"', 'lib/shopeeOrders.js', r"NOME_TURBO_ENVIO\s*=\s*'turbo'", r'NOME_TURBO_ENVIO\s*=.*'),
    ('Substatus ja despachado', 'lib/historicoTodos.js',
     r"STATUS_SUBSTATUS_JA_DESPACHADO\s*=\s*\[\s*'in_packing_list',\s*'in_hub',\s*'authorized_by_carrier'\s*\]",
     r'STATUS_SUBSTATUS_JA_DESPACHADO\s*=.*'),
    ('Teto aguardando = 15 dias', 'lib/historicoTodos.js', r'IDADE_MAXIMA_AGUARDANDO_MS\s*=\s*15\s*\*\s*24', r'IDADE_MAXIMA_AGUARDANDO_MS\s*=.*'),
    ('ML geral: status_envio aguardando', 'lib/historicoTodos.js', r"'pending',\s*'handling',\s*'ready_to_ship'", r"status_envio IN.*"),
    ('Shopee geral: READY_TO_SHIP/PROCESSED', 'lib/historicoTodos.js', r"'READY_TO_SHIP',\s*'PROCESSED'", r"status_pedido IN.*"),
    ('TV busca a cada 20 s', 'public/tv.html', r'INTERVALO_BUSCA_MS\s*=\s*20000', r'INTERVALO_BUSCA_MS\s*=.*'),
    ('TV zonas: <2h vermelho, <3h laranja', 'public/tv.html',
     r'DUAS_HORAS_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000[\s\S]{0,200}TRES_HORAS_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000',
     r'function zonaPorPrazo.*'),
    ('TV ML geral sem prazo: proximas 16h', 'public/tv.html', r'T16:00:00-03:00', r'calcularProximoDespachoMl16h.*'),
    ('TV ML geral nao desativado', 'public/tv.html', r'ML_TODOS_DESATIVADO\s*=\s*false', r'ML_TODOS_DESATIVADO\s*=.*'),
    ('Resolver bipagem: max 50 por clique', 'api/debug.js', r'LIMITE_MAXIMO_RESOLVER_BIPAGEM\s*=\s*50\b', r'LIMITE_MAXIMO_RESOLVER_BIPAGEM\s*=.*'),
]


def main():
    mudou = 0
    for desc, arq, padrao, mostrar in CHECAGENS:
        caminho = RAIZ / arq
        if not caminho.exists():
            print(f'DIFERENTE  {desc}: arquivo {arq} nao existe mais')
            mudou += 1
            continue
        texto = caminho.read_text(encoding='utf-8')
        if re.search(padrao, texto):
            print(f'ok         {desc}')
        else:
            atual = re.search(mostrar, texto)
            trecho = atual.group(0).strip()[:120] if atual else '(nao encontrado)'
            print(f'DIFERENTE  {desc} [{arq}] -> {trecho}')
            mudou += 1
    print()
    print('Tudo bate com a skill.' if not mudou else
          f'{mudou} item(ns) mudaram: o codigo vale. Atualize a skill no mesmo PR e avise o dono do projeto.')
    return 1 if mudou else 0


if __name__ == '__main__':
    sys.exit(main())
