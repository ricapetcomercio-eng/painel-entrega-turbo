#!/usr/bin/env python3
"""Verificador rápido do padrão visual dos painéis Ricapet.

Uso: python3 .claude/skills/ricapet-paineis/scripts/checar_pagina.py public/fechamento.html [outra.html ...]

Não altera nada — só lista desvios do manual (SKILL.md) para o autor
conferir. "ERRO" = quebra o padrão de forma objetiva; "AVISO" = vale
olhar, pode ter motivo. Sai com código 1 se houver algum ERRO.
"""
import re
import sys
from pathlib import Path

# Páginas com identidade própria/fora do padrão admin, de propósito.
FORA_DO_PADRAO = {"tv.html", "backfill-runner.html"}
SEM_SIDEBAR = {"login.html", "estoque-atualizar.html"}
FONTES_PERMITIDAS = {"inter", "ibm plex mono"}
GENERICAS = {"system-ui", "-apple-system", "sans-serif", "monospace", "serif",
             "ui-monospace", "sfmono-regular", "segoe ui", "arial", "inherit"}


def blocos_style(html):
    return re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S | re.I)


def sem_print(css):
    """Remove @media print { ... } (1 nível de aninhamento) — impressão em
    preto e branco usa cor fixa de propósito (ex.: Cartão de Ponto)."""
    return re.sub(r"@media\s+print\s*\{(?:[^{}]|\{[^{}]*\})*\}", "", css)


def sem_blocos_root(css):
    """Remove declarações de :root (inclusive dentro de @media) — hex ali é
    definição de token, que é o lugar certo."""
    return re.sub(r":root[^{]*\{[^}]*\}", "", css)


def checar(caminho):
    nome = Path(caminho).name
    html = Path(caminho).read_text(encoding="utf-8")
    erros, avisos = [], []

    if nome in FORA_DO_PADRAO:
        ref = "references/painel-tv.md" if nome == "tv.html" else "ferramenta interna avulsa"
        return [], [f"{nome} fica fora do padrão admin de propósito ({ref}) — checagem pulada"]

    if not re.search(r'<html[^>]*lang="pt-BR"', html):
        erros.append('falta <html lang="pt-BR">')
    if "name=\"viewport\"" not in html:
        erros.append("falta <meta name=\"viewport\">")
    if not re.search(r"<title>[^<]{3,}</title>", html):
        erros.append("falta <title> descritivo")

    pos_tokens = html.find("assets/tokens-admin.css")
    pos_style = html.lower().find("<style")
    if pos_tokens == -1:
        erros.append("não linka assets/tokens-admin.css")
    elif pos_style != -1 and pos_style < pos_tokens:
        erros.append("tokens-admin.css precisa vir ANTES do <style> da página")

    if "ricapet_tema2" not in html:
        erros.append("falta o script inline de tema (localStorage 'ricapet_tema2') no <head>")
    else:
        pos_tema = html.find("ricapet_tema2")
        if pos_tokens != -1 and pos_tema > pos_tokens:
            avisos.append("script de tema vem depois do CSS — pode piscar claro→escuro")

    if nome not in SEM_SIDEBAR and nome != "login.html":
        if 'class="sidebar' not in html and 'class="topbar' not in html:
            avisos.append("sem sidebar nem topbar — página admin deveria ter navegação")
        if "marca-dagua" not in html and "body::before" not in html:
            avisos.append("sem marca d'água (body class=\"marca-dagua\")")

    css = "\n".join(blocos_style(html))
    # fontes
    for m in re.finditer(r"font-family\s*:\s*([^;}{]+)", css):
        for f in m.group(1).split(","):
            f = f.strip().strip("'\"").lower()
            if f.startswith("var(") or not f:
                continue
            if f not in FONTES_PERMITIDAS and f not in GENERICAS:
                erros.append(f"fonte fora da identidade: '{f}' (use var(--font-body))")
    for m in re.finditer(r"fonts\.googleapis\.com/css2\?([^\"']+)", html):
        familias = re.findall(r"family=([^:&]+)", m.group(1))
        for fam in familias:
            fam_n = fam.replace("+", " ").lower()
            if fam_n not in FONTES_PERMITIDAS:
                erros.append(f"carrega fonte Google fora da identidade: {fam.replace('+', ' ')}")

    # cor solta fora de :root
    resto = sem_blocos_root(sem_print(css))
    hexes = re.findall(r"#[0-9a-fA-F]{3,8}\b", resto)
    soltos = [h for h in hexes if h.lower() not in ("#fff", "#ffffff", "#000", "#000000")]
    if soltos:
        unicos = sorted(set(soltos))
        avisos.append(f"{len(soltos)} cor(es) hex fora de :root ({', '.join(unicos[:8])}{'…' if len(unicos) > 8 else ''}) — prefira var(--token)")
    inline = re.findall(r'style="[^"]*#[0-9a-fA-F]{3,8}', html)
    if inline:
        avisos.append(f"{len(inline)} style inline com cor hex — prefira classe/token")

    # tokens novos sem versão escura
    raiz_claro = re.findall(r"(?<![\w-]):root\s*\{([^}]*)\}", css)
    vars_claro = set()
    for b in raiz_claro:
        vars_claro.update(re.findall(r"(--[\w-]+)\s*:\s*#", b))
    css_escuro = " ".join(re.findall(r':root\[data-theme="dark"\][^{]*\{([^}]*)\}', css))
    faltando = sorted(v for v in vars_claro if v not in css_escuro)
    if faltando:
        erros.append("cor declarada no :root sem versão para :root[data-theme=\"dark\"]: " + ", ".join(faltando))

    # gradiente de marca fora do lugar
    if re.search(r"--brand-gradient-cta", resto) and not re.search(r"\.btn|sidebar", resto):
        avisos.append("--brand-gradient-cta usado fora de botão principal/sidebar")

    # acessibilidade de botões só com ícone/símbolo
    for m in re.finditer(r"<button([^>]*)>\s*(<svg.*?</svg>|[^\w<\s]{1,2})\s*</button>", html, flags=re.S):
        attrs = m.group(1)
        if "aria-label" not in attrs and "title=" not in attrs:
            erros.append("botão só com ícone sem aria-label/title: " + re.sub(r"\s+", " ", m.group(0))[:80])

    # classes usadas no HTML estático que não estão definidas em lugar nenhum
    # (nem no CSS da página nem no tokens-admin.css) — costuma ser bloco
    # copiado de outra página sem trazer o CSS junto (ex.: submenu da sidebar).
    tokens_css = Path(caminho).resolve().parent / "assets" / "tokens-admin.css"
    css_total = css + (tokens_css.read_text(encoding="utf-8") if tokens_css.exists() else "")
    definidas = set(re.findall(r"\.(-?[_a-zA-Z][\w-]*)", css_total))
    corpo = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", html, flags=re.S | re.I)
    usadas = set()
    for m in re.finditer(r'class="([^"$`{}]*)"', corpo):
        usadas.update(m.group(1).split())
    # classes que só servem de gancho pro JS (estado) são comuns e legítimas
    ganchos = {"ativo", "aberto", "oculto", "active", "hidden", "selected"}
    sem_css = sorted(c for c in usadas - definidas - ganchos)
    if sem_css:
        avisos.append("classe(s) no HTML sem CSS definido (nem na página nem no tokens-admin): "
                      + ", ".join(sem_css[:12]) + ("…" if len(sem_css) > 12 else "")
                      + " — confira se não faltou trazer o CSS de outra página")

    # data em UTC
    if re.search(r"toISOString\(\)\.slice\(0,\s*10\)", html):
        avisos.append("toISOString().slice(0,10) dá o dia em UTC — use o fuso America/Sao_Paulo")

    # outra lib de gráfico
    if re.search(r"(apexcharts|highcharts|echarts|plotly)", html, flags=re.I):
        avisos.append("biblioteca de gráfico diferente do Chart.js usado no resto do painel")

    # innerHTML com interpolação sem escape (heurística)
    if "innerHTML" in html and "${" in html and not re.search(r"function\s+esc\w*\s*\(|const\s+esc\w*\s*=", html):
        avisos.append("monta innerHTML com ${…} e não tem função de escape (esc) — dado de marketplace precisa ser escapado")

    return erros, avisos


def main(args):
    if not args:
        print(__doc__)
        return 2
    algum_erro = False
    for caminho in args:
        erros, avisos = checar(caminho)
        print(f"== {caminho}")
        for e in erros:
            print(f"  ERRO  {e}")
        for a in avisos:
            print(f"  AVISO {a}")
        if not erros and not avisos:
            print("  ok — segue o padrão")
        algum_erro = algum_erro or bool(erros)
    return 1 if algum_erro else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
