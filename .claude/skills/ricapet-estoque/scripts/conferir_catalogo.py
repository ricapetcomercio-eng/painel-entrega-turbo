#!/usr/bin/env python3
"""Confere a consistência entre o catálogo de estoque e a tabela de SKU.

Uso (na raiz do repo):
    python3 .claude/skills/ricapet-estoque/scripts/conferir_catalogo.py [--detalhe]

Somente leitura. Compara:
  - public/catalog.json                (produto -> cor -> [tamanhos])
  - lib/tabelaProdutos.json            (SKU -> produto/cor/tamanho/custo)
  - CATALOG em public/estoque-atualizar.html (deve ser igual ao catalog.json)

Aponta divergências que fazem a venda baixar numa linha de estoque e a
contagem gravar em outra (ver references/pendencias.md item 2), SKUs de
kit/par (item 1) e SKUs sem custo. NÃO corrige nada — corrigir nome de
produto muda saldo existente e precisa de decisão do dono.
"""
import json
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[4]
CATALOGO = RAIZ / "public" / "catalog.json"
TABELA = RAIZ / "lib" / "tabelaProdutos.json"
ATUALIZAR = RAIZ / "public" / "estoque-atualizar.html"

PADRAO_KIT = re.compile(r"(kit\s*\d*|_par\b|-par\b)", re.I)


def combos_catalogo(cat):
    return {(p, c, t) for p, cores in cat.items() for c, tams in cores.items() for t in tams}


def main(detalhe=False):
    cat = json.loads(CATALOGO.read_text(encoding="utf-8"))
    tab = json.loads(TABELA.read_text(encoding="utf-8"))

    print(f"Catálogo: {len(cat)} produtos, {len(combos_catalogo(cat))} combinações")
    print(f"Tabela de SKU: {len(tab)} SKUs, {len({v['produto'] for v in tab.values()})} produtos")

    # 1) CATALOG embutido na tela mobile x catalog.json
    html = ATUALIZAR.read_text(encoding="utf-8")
    m = re.search(r"const CATALOG = (\{.*?\});", html)
    if not m:
        print("\n[AVISO] não achei 'const CATALOG = {...};' em estoque-atualizar.html")
    else:
        embutido = json.loads(m.group(1))
        if embutido == cat:
            print("\n[OK] CATALOG da tela mobile = catalog.json")
        else:
            a, b = combos_catalogo(embutido), combos_catalogo(cat)
            print(f"\n[DIVERGE] CATALOG da tela mobile x catalog.json: "
                  f"{len(a - b)} só na tela, {len(b - a)} só no catalog.json "
                  f"— regenerar catalog.json depois de editar CATALOG")

    # 2) produtos/combinações da tabela que não existem no catálogo
    prods_cat = set(cat)
    prods_tab = {v["produto"] for v in tab.values()} - {"Não identificado"}
    so_tab = sorted(prods_tab - prods_cat)
    print(f"\nProdutos da tabela de SKU sem nome igual no catálogo: {len(so_tab)} de {len(prods_tab)}")
    cat_lower = {p.lower(): p for p in prods_cat}
    for p in so_tab if detalhe else so_tab[:15]:
        parecido = [c for c in prods_cat if p.lower() in c.lower() or c.lower() in p.lower()]
        dica = f"  ~ catálogo: {', '.join(sorted(parecido)[:3])}" if parecido else ""
        if p.lower() in cat_lower:
            dica = f"  ~ só difere em maiúscula: {cat_lower[p.lower()]}"
        print(f"  - {p}{dica}")
    if not detalhe and len(so_tab) > 15:
        print(f"  … (+{len(so_tab) - 15}; use --detalhe)")

    combos_cat = combos_catalogo(cat)
    combos_cat_lower = {(p.lower(), c.lower(), t.lower()) for p, c, t in combos_cat}
    exatas = so_caixa = nenhuma = 0
    for v in tab.values():
        k = (v["produto"], v["cor"], v["tamanho"])
        if k in combos_cat:
            exatas += 1
        elif tuple(x.lower() for x in k) in combos_cat_lower:
            so_caixa += 1
        else:
            nenhuma += 1
    print(f"\nSKUs cuja combinação produto/cor/tamanho existe no catálogo: "
          f"{exatas} exatas, {so_caixa} só diferem em maiúscula, {nenhuma} sem correspondência")

    # 3) kit/par — baixam 1 unidade hoje (pendência 1)
    kits = sorted(s for s in tab if PADRAO_KIT.search(s))
    print(f"\nSKUs que parecem kit/par (baixam 1 unidade hoje, sem multiplicador): {len(kits)}")
    for s in kits if detalhe else kits[:10]:
        v = tab[s]
        print(f"  - {s} -> {v['produto']} / {v['cor']} / {v['tamanho']} (custo {v['custo']})")
    if not detalhe and len(kits) > 10:
        print(f"  … (+{len(kits) - 10}; use --detalhe)")

    # 4) sem custo / não identificado
    sem_custo = [s for s, v in tab.items() if v.get("custo") is None]
    nao_id = [s for s, v in tab.items() if v["produto"] == "Não identificado"]
    print(f"\nSKUs sem custo: {len(sem_custo)} · SKUs com produto 'Não identificado': {len(nao_id)}")

    print("\nNada foi alterado. Divergências de nome/kit são decisões do dono "
          "(references/pendencias.md itens 1 e 2).")
    return 0


if __name__ == "__main__":
    sys.exit(main(detalhe="--detalhe" in sys.argv))
