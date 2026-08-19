#!/usr/bin/env python3
"""
Gera lib/tabelaProdutos.json a partir de
C:\\FECHAMENTO\\03 AUXILIARES\\TABELA_AUXILIAR.xlsx (aba TABELA_PRODUTOS).

Rode sempre que TABELA_AUXILIAR.xlsx for atualizado, e dê git push depois —
é o dado que o painel-entrega-turbo usa pra cruzar o SKU de cada item de
pedido com PRODUTO/COR/TAMANHO/CUSTO.

Uso:
    python scripts/gerar_tabela_produtos.py
"""
import json
from pathlib import Path

import openpyxl

PLANILHA = Path(r"C:\FECHAMENTO\03 AUXILIARES\TABELA_AUXILIAR.xlsx")
SAIDA = Path(__file__).parent.parent / "lib" / "tabelaProdutos.json"


def main():
    wb = openpyxl.load_workbook(PLANILHA, data_only=True)
    ws = wb["TABELA_PRODUTOS"]

    # Colunas: Código do anúncio, Número do produto, Número da variação,
    # SKU, Título, PRODUTO, COR, TAMANHO, UNIDADE, CUSTO
    mapa = {}
    sem_sku = 0
    for row in ws.iter_rows(min_row=2, values_only=True):
        sku, produto, cor, tamanho, custo = row[3], row[5], row[6], row[7], row[9]
        if not sku:
            sem_sku += 1
            continue
        # Última ocorrência de cada SKU vence, se houver duplicatas
        # divergentes na planilha (existem ~7 casos hoje, inconsistências
        # de cadastro pré-existentes — não é papel deste script corrigir).
        mapa[str(sku).strip()] = {
            "produto": produto or "Não identificado",
            "cor": cor or "-",
            "tamanho": tamanho or "-",
            "custo": float(custo) if isinstance(custo, (int, float)) else None,
        }

    SAIDA.write_text(
        json.dumps(mapa, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    print(f"{len(mapa)} SKUs gravados em {SAIDA}")
    if sem_sku:
        print(f"{sem_sku} linha(s) da planilha ignorada(s) por não ter SKU preenchido")


if __name__ == "__main__":
    main()
