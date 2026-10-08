---
name: ricapet-paineis
description: Manual de design vivo dos painéis internos da Ricapet/Thapets (public/*.html deste repo) — identidade visual turquesa, tokens de cor, tipografia Inter, componentes prontos de assets/tokens-admin.css (card, kpi, botão, badge, tabela, filtro, alerta, modal, estado vazio), gráficos Chart.js, tema claro/escuro, responsividade, acessibilidade e a identidade própria do Painel TV. Use SEMPRE que for criar, alterar, revisar ou opinar sobre qualquer tela, aba, card, botão, tabela, gráfico, cor, aviso ou layout dos painéis Ricapet — inclusive pedidos curtos como "deixa mais bonito", "coloca um aviso no topo", "cria uma aba nova", "o card tá feio", "revisa esse PR de tela", mesmo que a palavra "design" não apareça.
---

# Ricapet Painéis — manual de design vivo

Os painéis da Ricapet já têm uma identidade madura e consistente. O trabalho
aqui quase nunca é "desenhar" — é **reaproveitar** o que existe, para a tela
nova parecer que sempre esteve ali. Uma tela que inventa cor, fonte ou
componente próprio envelhece mal: na próxima troca de tema (já foram 4 em
2026: roxo → teal/terracota → verde → turquesa) ela fica para trás, porque
não herda nada.

**Fonte da verdade:** `public/assets/tokens-admin.css`. Se este manual e
aquele arquivo discordarem, o arquivo vence (e vale atualizar o manual).
O `CLAUDE.md` tem trechos antigos sobre identidade (teal/terracota, Space
Grotesk) — estão desatualizados, ignore-os nesse ponto.

## Os dois mundos visuais

| | Páginas admin (todas, menos a TV) | Painel TV (`tv.html`) |
|---|---|---|
| Uso | computador/celular, leitura de perto | TV no galpão, lida a 3-5 m, sem interação |
| Tema | claro + escuro (segue sistema ou botão) | sempre escuro |
| Fonte | Inter | Atkinson Hyperlegible + Barlow Condensed (números) |
| Cores | tokens de `tokens-admin.css` | paleta própria no `:root` da TV |
| Referência | `references/tokens-e-componentes.md` | `references/painel-tv.md` |

Nunca misture: não leve fonte/cor da TV para o admin, nem componentes do
admin para a TV. `backfill-runner.html` é ferramenta interna avulsa — fica
fora do padrão de propósito.

## Fluxo de trabalho

1. **Olhe antes de escrever.** Abra a página mais parecida com o que vai
   fazer e copie a estrutura dela. Boas referências:
   - página nova com menu lateral → `fechamento.html` (a mais recente e limpa);
   - página com topbar horizontal → `bipagem-v2.html`;
   - tabela-planilha densa → `projecao-financeira.html`;
   - gráficos → `index.html` / `bipagem-v2.html`.
2. **Procure o componente pronto** em `references/tokens-e-componentes.md`
   antes de escrever qualquer CSS. Card, KPI, botão, badge, tabela, filtro,
   alerta, modal, drawer, paginação, estado vazio e skeleton já existem.
3. **CSS próprio da página só para o que é realmente dela** (layout da
   grade, uma coluna específica) — e sempre usando `var(--token)`, nunca
   hex solto fora de `:root`.
4. **Confira claro e escuro.** Toda cor nova precisa existir nos dois temas
   (ver "Cor nova" abaixo).
5. **Rode o verificador** antes de entregar:
   `python3 .claude/skills/ricapet-paineis/scripts/checar_pagina.py public/<pagina>.html`
   Ele aponta os desvios mais comuns (fonte estranha, hex solto, falta do
   script de tema, tokens linkados na ordem errada, botão sem texto).
6. **Na resposta/PR, diga quais componentes reaproveitou** e qualquer
   exceção ao padrão com o motivo — facilita a revisão automática dos PRs.

## Regras de identidade (o porquê de cada uma)

**Cor de marca é turquesa e é escassa.** `--brand-primary` (#00A9C7) marca
o que é interativo ou ativo: link ativo, botão principal, foco, chip
selecionado, 1ª série de gráfico. Se tudo for turquesa, nada se destaca.
O gradiente `--brand-gradient-cta` é a "assinatura" — só na sidebar e nos
botões principais (`.btn.primary`), nunca em card, cabeçalho ou fundo.

**Semânticas não viram turquesa.** Verde `--success`, laranja `--warning`,
vermelho `--danger`, azul `--info` — decisão explícita do dono. Use pelo
significado, não pela estética: vermelho = problema real (atraso, saldo
negativo, erro), laranja = atenção (dado velho, perto do limite), verde =
ok/concluído, azul = informação neutra. Texto sobre fundo semântico usa as
variantes `--danger-text`, `--warning-text`, `--success-text` (contraste AA).

**Neutros "slate".** Fundo `--bg-page`, cartão `--bg-card`, superfície
secundária `--bg-card-2` (cabeçalho de tabela, hover, chip), borda
`--border`/`--border-soft`, texto `--text-primary` > `--text-soft` >
`--text-secondary`. Três níveis de texto bastam; não crie um quarto cinza.

**Tipografia: só Inter**, pesos 400-800, `font-variant-numeric:
tabular-nums` no body (números alinham em coluna). Escala usada de fato:
- título da página: ~1.05rem/700 no header sticky, subtítulo 0.72rem/500 `--text-secondary`;
- título de card/tabela: 13.5px/700;
- rótulo de KPI e cabeçalho de tabela: 10.5-11px/700-800, CAIXA ALTA, `letter-spacing: .03em`;
- valor de KPI: 22px/800;
- corpo de tabela e controles: 12.5px;
- notas e dicas: 11-11.5px `--text-secondary`.
Não suba tudo de tamanho para "ficar mais legível": a densidade é escolha
consciente — são painéis de trabalho com muita informação por tela.

**Forma e espaço.** Raio `--radius` (16px) em card/tabela/modal, 14px em
KPI, `--radius-sm`/8px em botão e input, `--radius-pill` em badge e chip.
Sombra sempre leve (`0 1px 3px var(--shadow)`, um pouco mais no hover).
Espaçamento em passos de 4 (4, 8, 12, 16, 18/20, 24); conteúdo em `.shell`
com `max-width: 1320px`, padding `20px 24px`, `gap: 18px` entre blocos.
Bordas de 1px; tracejada só em `.alert`.

**Ícones:** SVG inline, traço (`fill="none" stroke="currentColor"
stroke-width="2"`, viewBox 24), 16-18px. Herdam a cor do texto. Emoji é
aceito em selo/rótulo curto (padrão já usado: 🛍️ Shopee, 📦 ML, ✓, ⚠, ⏱),
não como ícone de botão de ação.

**Números e datas em pt-BR**, sempre: `toLocaleString('pt-BR', ...)`,
moeda `{ style: 'currency', currency: 'BRL' }`, datas DD/MM/AAAA. "Hoje" e
"dia" sempre no fuso `America/Sao_Paulo` (`Intl.DateTimeFormat('en-CA', {
timeZone: 'America/Sao_Paulo' })`), nunca `toISOString().slice(0,10)` — o
servidor e o navegador podem estar em UTC e o pedido das 21h vira "amanhã".

## Estados — toda tela tem quatro

Pense em cada bloco que carrega dado em quatro estados e desenhe os quatro:
1. **Carregando:** `.skeleton` ou `.loading-note` — nunca tela em branco.
2. **Vazio:** `.empty-state` com frase que diga o porquê e o que fazer
   ("Nenhum pedido aguardando — tudo despachado.").
3. **Erro:** `.alert.danger` com a mensagem real do servidor, sem jargão,
   e o próximo passo. Falha silenciosa (tudo zerado sem aviso) é o pior
   resultado possível — já aconteceu de verdade com a TV (401 silencioso).
4. **Dado velho/parcial:** quando o dado depende de coleta/cron, mostre a
   hora da última atualização (nota pequena 11.5px em `--text-secondary`,
   como o `.updated-note` do Fluxo de Caixa: "Atualizado às HH:MM") e
   avise em `.alert.warning` se não for de hoje.

## Alertas e hierarquia

Um resumo que responde a pergunta principal da tela vem **acima** da
tabela/gráfico, não escondido dentro dele (padrão já usado no Fluxo de
Caixa: "Saldo projetado fica negativo em DD/MM"). Ordem de leitura:
cabeçalho (o quê + período + última atualização) → alertas → KPIs → gráfico
→ tabela de detalhe. No máximo um alerta vermelho por bloco; se tudo é
urgente, nada é.

## Cor nova (quando nenhum token serve)

Raro, mas acontece (ex.: as séries do Fechamento). Declare no `:root` da
própria página e **repita nos dois blocos de tema escuro**, igual ao
`tokens-admin.css` — sem isso a cor fica errada no modo escuro:
```css
:root { --s-fat: #0095B0; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --s-fat: #0E97B0; } }
:root[data-theme="dark"] { --s-fat: #0E97B0; }
```
Confira contraste ≥ 4.5:1 para texto (3:1 para elementos gráficos) nos dois
temas. Se a cor vai servir a mais de uma página, ela pertence ao
`tokens-admin.css`, não à página.

## Responsividade

- Sidebar vira faixa no topo abaixo de 900px (já resolvido no CSS
  compartilhado — não reescreva).
- `.kpi-row`: 6 colunas → 3 (≤1080px) → 2 (≤620px). Grades próprias seguem
  a mesma lógica com `repeat(auto-fit, minmax(...))`.
- Tabela larga: dentro de `.table-scroll` (rolagem horizontal no próprio
  bloco); a página inteira nunca rola para o lado.
- `estoque-atualizar.html` é a tela pensada para celular no galpão: alvos
  de toque ≥ 44px, um assunto por tela.

## Acessibilidade (mínimo que todo PR de tela deve cumprir)

- `<html lang="pt-BR">`, `<title>` que diga a tela.
- Botão de ícone sozinho precisa de `aria-label` ou `title`.
- Foco visível em tudo que é clicável (não remova `outline` sem pôr outro).
- Cor nunca é o único sinal: atraso tem cor **e** texto/ícone ("ATRASADO",
  "⚠"); variação positiva/negativa tem sinal (+/−).
- Aviso que aparece sozinho (erro, saldo negativo) usa `role="alert"` ou
  `aria-live="polite"`.
- Animação respeita `prefers-reduced-motion` (o skeleton já respeita).
- Contraste AA nos dois temas — os tokens já passam; o risco está em hex
  solto e em texto `--text-secondary` sobre `--bg-card-2`.

## Gráficos

Chart.js 4 via jsDelivr (versão fixa), cores lidas dos tokens com
`getComputedStyle` (`--chart-1` … `--chart-5`), `--chart-1` sempre a série
principal, Ricapet×Thapets e ML×Shopee usam `--chart-1`/`--chart-2`.
Detalhes, exemplo de código e quando NÃO usar gráfico:
`references/graficos.md`.

## Esqueleto de página nova

Cabeçalho obrigatório (script de tema inline antes do CSS, auth, fontes,
tokens antes do `<style>`), sidebar copiada de uma página existente, marca
d'água e `.conteudo-principal` com `z-index: 1`:
`references/esqueleto-pagina.md`.

⚠️ O link "Painel TV" da sidebar carrega o `?token=` do painel. Ao copiar
a sidebar, copie de uma página existente (para manter o token atual) e
nunca escreva esse valor em issue, comentário de PR ou mensagem.

## Revisão de tela (PR de outro agente ou pedido "revisa isso")

Responda nesta ordem, citando arquivo:linha:
1. **Quebra o padrão?** cor/fonte/componente inventado quando havia token
   ou classe pronta.
2. **Falta estado?** carregando/vazio/erro/dado velho.
3. **Tema escuro** — cor nova sem versão escura, texto ilegível.
4. **Acessibilidade** — itens da lista acima.
5. **Responsivo** — rolagem horizontal da página, alvo de toque pequeno.
Sugestão estética de gosto pessoal vai por último e marcada como opcional.
