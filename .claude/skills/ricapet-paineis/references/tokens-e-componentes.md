# Tokens e componentes — catálogo

Tudo aqui vem de `public/assets/tokens-admin.css`. Antes de escrever CSS,
procure aqui; se existir, use a classe. Os exemplos são o markup que as
páginas já usam (principalmente `fechamento.html`).

## Sumário
1. Tokens de cor
2. Nomes antigos (aliases)
3. Botões
4. Card
5. KPI
6. Badge
7. Tabela
8. Filtros
9. Alertas e notas
10. Modal e drawer
11. Barra de progresso
12. Paginação
13. Vazio, carregando, skeleton
14. Tooltip
15. Segurança no HTML gerado por JS

## 1. Tokens de cor

| Token | Claro | Escuro | Uso |
|---|---|---|---|
| `--brand-primary` | #00A9C7 | #22C3E0 | interativo/ativo, 1ª série |
| `--brand-primary-dark` | #007F98 | #007F98 | hover, texto de marca sobre fundo claro |
| `--brand-primary-light` | #E6F8FB | #0B2E36 | fundo de chip/ícone selecionado |
| `--brand-primary-soft` | #F3FBFD | #081F24 | fundo muito suave (célula automática) |
| `--brand-gradient-cta` | 135° #00A9C7→#007F98 | igual | só sidebar e `.btn.primary` |
| `--bg-page` | #F7FAFC | #0F171A | fundo da página |
| `--bg-card` | #FFFFFF | #19232A | cartões |
| `--bg-card-2` | #F1F5F9 | #212E35 | cabeçalho de tabela, hover, chip |
| `--border` / `--border-soft` | #E2E8F0 / #EDF2F6 | #2A3B44 / #24343B | bordas |
| `--text-primary` | #0F1720 | #F1F6F8 | texto principal |
| `--text-soft` | #334155 | #C3D0D6 | texto de controle, intermediário |
| `--text-secondary` | #64748B | #93A4AD | rótulos, notas |
| `--success` (+`-bg`, `-text`) | #16A34A | #22C55E | ok, concluído, positivo |
| `--warning` (+`-bg`, `-text`) | #F59E0B | #FB923C | atenção, dado velho |
| `--danger` (+`-bg`, `-text`) | #DC2626 | #F87171 | erro, atraso, negativo |
| `--info` (+`-bg`) | #2563EB | #60A5FA | informação neutra |
| `--chart-1..5` | turquesa, deep, âmbar, rosa, violeta | versões claras | gráficos |
| `--radius` / `--radius-sm` / `--radius-pill` | 16 / 10 / 999px | | formas |
| `--shadow` | rgba(15,23,32,.08) | rgba(0,0,0,.45) | sombras |

## 2. Nomes antigos (aliases)

Páginas antigas usam `--page-bg`, `--ink`, `--ink-muted`, `--accent`,
`--ok`, `--bad`, `--warn`, `--card`… Todos apontam para os tokens novos —
funcionam. Em código novo prefira os nomes novos; ao editar página antiga,
siga o estilo que ela já usa (não misture os dois no mesmo bloco).

Armadilhas:
- `--ink`/`--text-primary` são cor de TEXTO: usados como fundo, viram
  quase branco no tema escuro (texto branco some). Mesmo cuidado com
  `--accent-ink`, que no escuro vira ciano claro.
- `--teal` **não é turquesa** — é alias de `--warning` (sobra da
identidade antiga). Para a cor da marca use `--brand-primary`.

## 3. Botões

```html
<button type="button" class="btn">Limpar filtros</button>
<button type="button" class="btn primary">Atualizar agora</button>
<button type="button" class="btn icon" aria-label="Fechar">✕</button>
```
- Um único `.btn.primary` por área — é a ação principal da tela.
- Altura 32px, texto 12.5px/700. Verbo no infinitivo ou imperativo curto
  ("Salvar saldo", "Resolver pendentes", "Exportar CSV").
- Enquanto a ação roda: `disabled` + texto "Atualizando…"; ao terminar,
  sempre volte o botão e mostre o resultado (sucesso ou erro). Botão que
  fica "Atualizando…" para sempre já aconteceu em produção.
- Ação destrutiva/irreversível: confirmação explícita antes, nunca no
  primeiro clique.

## 4. Card

```html
<div class="card">
  <div class="card-head"><h3>Evolução — últimos 12 meses</h3><span class="hint">clique num mês</span></div>
  …conteúdo…
  <div class="card-note">Fonte: planilha de fechamento.</div>
</div>
```

## 5. KPI

```html
<div class="kpi-row">
  <div class="kpi tone-bad">
    <div class="kpi-top"><span class="kpi-label">Atrasados</span><span class="kpi-icon" aria-hidden="true">⚠</span></div>
    <div class="kpi-value">12<small>pedidos</small></div>
    <div class="kpi-sub">3 desde ontem</div>
  </div>
</div>
```
- Tons: `tone-good` / `tone-warn` / `tone-bad` / `tone-info` / `tone-muted`;
  sem tom = turquesa. O tom vai pelo significado do número.
- Rótulo curto em caixa alta; unidade em `<small>`; contexto em `.kpi-sub`.
- Valor negativo com sinal "−" (menos tipográfico) e tom `tone-bad`.
- Grade: 6 colunas por padrão; para 4-5 KPIs, crie uma variante da grade
  na página (ex.: `.kpi-row.cinco`), não KPIs de largura solta.

## 6. Badge

```html
<span class="badge badge-success">✓ Dentro</span>
<span class="badge badge-danger"><span class="badge-dot"></span>Atrasado</span>
<span class="badge badge-neutral">—</span>
```
Variantes: `badge-success`, `badge-warning`, `badge-danger`, `badge-info`,
`badge-neutral`. Texto curto (1-2 palavras), sempre com palavra além da cor.

## 7. Tabela

```html
<div class="table-card">
  <div class="table-card-head">
    <h3>Ranking de categorias</h3>
    <p>Uma frase dizendo de onde vem o dado ou como ler.</p>
  </div>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Categoria</th><th class="num">Faturamento</th></tr></thead>
      <tbody><tr><td class="name">Coleiras</td><td class="num">R$ 12.340,00</td></tr></tbody>
    </table>
  </div>
</div>
```
- Número alinhado à direita (`th.num`, `td.num`), texto à esquerda.
- Cabeçalho sticky já vem pronto; `.table-scroll` limita a 420px de altura.
- Linha clicável: `cursor: pointer` + `title` explicando o que abre.
- Destaque de 1º lugar: `.rank-row-1`.
- Zero/sem valor: `—` com `.muted`, não "0" nem célula vazia, quando "não
  existe dado" é diferente de "deu zero".

## 8. Filtros

```html
<div class="filter-bar">
  <input type="search" placeholder="Buscar SKU ou pedido">
  <select>…</select>
  <span class="result-count">32 resultados</span>
</div>
<div class="filter-chips">
  <span class="rotulo">Origem</span>
  <label><input type="checkbox" checked> Devolução</label>
</div>
```
Filtro sempre mostra quantos resultados sobraram e tem como limpar.
Escolha de filtro que vale guardar (aba, toggle) vai em `localStorage`
dentro de `try/catch` — padrão já usado na TV.

## 9. Alertas e notas

```html
<div class="alert warning" role="alert">
  <svg …></svg>
  <div><b>Dados antigos</b><p>A coleta é de ontem, 18:02 — clique em "Atualizar agora".</p></div>
</div>
<div class="inline-note">Valores da Shopee são estimativa (a API não informa a data do repasse).</div>
```
Variantes: `.alert` (info, padrão), `.alert.success`, `.alert.warning`,
`.alert.danger`. Algumas páginas têm alerta próprio (`.resumo-saldo` no
Fluxo de Caixa, `.alerta` no Fechamento) — ao mexer nelas, mantenha o da
página; em página nova, use `.alert`.
Texto do alerta: o que aconteceu + consequência + o que fazer. Sem
jargão técnico ("401", "null", "fetch failed") na frase principal.

## 10. Modal e drawer

```html
<div class="modal-backdrop" id="bd"></div>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mt">
  <h3 id="mt">Contas a pagar — 08/10</h3> …
  <div class="modal-acoes"><button class="btn" type="button">Fechar</button></div>
</div>
```
Abre com a classe `.aberto` (no backdrop e no modal). Fecha com Esc,
clique no fundo e botão. Drawer (`.drawer`) para detalhe de um item sem
sair da lista (padrão do painel de funcionário).

## 11. Barra de progresso

`<div class="progress-bar warning"><i style="width:72%"></i></div>` —
variantes `warning`/`danger`. Sempre acompanhada do número (72%).

## 12. Paginação

`.pagination` com botões e `.info` ("1-50 de 230"). Prefira paginar no
servidor só se a lista for grande de verdade — a maioria das telas aqui
cabe numa tabela com `.table-scroll`.

## 13. Vazio, carregando, skeleton

```html
<div class="loading-note">Carregando…</div>
<div class="skeleton" style="height:120px"></div>
<div class="empty-state">Nenhuma devolução no período.</div>
```

## 14. Tooltip

`<span data-tooltip="Soma de Ricapet + Thapets">Total</span>` — só para
complemento; informação essencial não pode depender de passar o mouse
(não existe hover no celular nem na TV).

## 15. Segurança no HTML gerado por JS

As páginas montam HTML com template string. Todo dado que vem do banco ou
de marketplace (nome de produto, cliente, fornecedor, motivo de
devolução) passa por uma função de escape (`esc()` — já existe nas
páginas) antes de entrar no `innerHTML`. Faltar isso já foi bug real na
TV (#215).
