# Receitas de teste por tipo

Todas usam `t = await abrirPagina({...})` e `p = t.page`. Prefira
localizar por papel e texto visível (`getByRole`, `getByText`,
`getByPlaceholder`) — é o que o usuário vê; seletor de classe só quando não
houver outro jeito (ex.: `.card-pedido` na TV).

## Sumário
Navegação · Botões · Formulários · Filtros · Tabelas · Modais ·
Responsividade · Erro · Carregamento · Dados · Fluxos completos ·
Regressões

## Navegação
- Cada link da barra lateral abre a página certa:
  `await p.getByRole('link', { name: 'Fechamento Mensal' }).click(); await p.waitForURL(/fechamento/)`.
- Página nova ou link novo: confira que aparece **em todas** as páginas
  com sidebar (`grep -l 'data-menu-key="x"' public/*.html`).
- Controle de acesso (só o frontend): `sessao: { superAdmin:false, paginas:['bipagem'] }`
  → links sem permissão escondidos; `sessao: false` → vai para
  `login.html` (`t.page.url()`).
- Aba/estado salvo em URL ou `localStorage`: recarregue (`p.reload()`) e
  confira que voltou na mesma aba.

## Botões
- Clique e confira o **efeito**, não só que não deu erro: o que mudou na
  tela e qual rota foi chamada (`t.relatorio.apiChamadas`).
- Botão de ação: fica desabilitado/"Atualizando…" enquanto roda
  (`atrasoMs` no mock) e **volta** ao normal no sucesso e no erro (bug
  real do "Atualizando…" eterno).
- Ação destrutiva: pede confirmação (`p.on('dialog', d => d.dismiss())`
  e confira que nada foi enviado).

## Formulários
- Preencha (`fill`), envie e confira o corpo enviado: capture com
  `p.waitForRequest(r => r.url().includes('tipo=x'))` e leia
  `req.postDataJSON()`.
- Campo vazio, inválido (texto em número, data errada), valor no limite:
  mensagem clara, nada enviado.
- Resposta de erro do servidor (`status: 400` com `error`): mensagem
  aparece e o que foi digitado não se perde.

## Filtros
- Cada opção: a lista mostra só o que deve, e o contador ("N resultados")
  bate com o número de linhas/cards.
- Combinação de dois filtros + busca; "Limpar" volta ao total.
- Filtro sem resultado: aparece o estado vazio (não tela em branco).

## Tabelas
- Linhas = itens do mock (conte).
- Números formatados em pt-BR (`R$ 1.234,56`, `12,5%`), alinhados à
  direita; "—" para sem dado.
- Ordenação (se houver): clique no cabeçalho e confira a ordem.
- Texto com `<b>` ou `&` no mock aparece literal (escape OK, sem HTML
  injetado).

## Modais
- Abre pelo gatilho; fecha por botão, `Esc` (`p.keyboard.press('Escape')`)
  e clique no fundo; o foco volta para a página.
- Conteúdo do modal corresponde ao item clicado (ex.: dia/título certo).

## Responsividade
- `testar_pagina.mjs` já cobre 390/1366/1920 e detecta rolagem
  horizontal. **Olhe os prints**: texto cortado, botão fora da tela,
  tabela ilegível, sidebar ocupando a tela no celular (`menu-mobile.js`).
- TV: teste 1920×1080 e 1366×768 (as duas TVs reais); legível de longe é
  responsabilidade da `ricapet-paineis`.

## Estados de erro
- `/api` com `status: 500`, `401` e `abortar: true`: a página não quebra
  (`paginaErros` vazio), mostra aviso compreensível, e (TV/painéis com
  atualização automática) mantém o último dado bom quando faz sentido.
- 401 em página com sessão: deve ir para o login / acesso negado, não
  ficar em loop.

## Carregamento
- Mock com `atrasoMs: 3000` + print logo após abrir: aparece "Carregando…"
  ou skeleton, não a tela vazia como se não houvesse dado.
- Depois de carregar, o indicador some.

## Dados
- Os números da tela batem com o mock (some na mão: total, %, contagem
  por tipo). Erro de soma/agrupamento é o bug mais comum — confira pelo
  menos um total.
- Datas e "hoje" no fuso de Brasília: use `agora` perto da virada do dia
  (ex.: `2026-10-07T23:30:00-03:00`) quando a lógica depende de "hoje".
- Lista vazia, um só item, muitos itens (50+), valor zero e negativo.

## Fluxos completos
Encadeie o que o usuário faz de verdade, num teste só. Ex.:
- Fechamento: abre → troca o mês → clica numa linha de meta → modal →
  fecha → filtra produtos por canal.
- Acessos: abre → marca página para um funcionário → "Admin" marca
  sozinho → salvar envia `admin: true` → mensagem de sucesso.
- Backend + tela: grave no SQLite local com `chamar_api.mjs`, gere o mock
  a partir da resposta da rota real e abra a tela com ele.

## Regressões
Antes de dizer pronto, rode a fumaça do que pode ter sido afetado:

| Mexeu em | Rode também |
|---|---|
| `assets/tokens-admin.css`, `auth.js`, `tema.js`, `menu-mobile.js` | fumaça de **todas** as páginas com sidebar |
| `public/tv.html` | `exemplo_tv.mjs` + fumaça 1920 e 1366 |
| `api/dashboard-data.js` ou o formato de `ultima_coleta*` | tv.html, index.html, projecao-financeira.html |
| `api/analytics-todos-data.js` | index.html, bipagem-v2.html, bipagem.html |
| `lib/fechamento.js` | `gerar_fixture_fechamento.mjs` + fumaça de fechamento.html |
| `lib/historico*.js`, `api/collect.js`, `api/marcar-coletado.js` | `chamar_api.mjs` da rota + tv.html |

Bug corrigido = um caso de teste que reproduzia o bug **antes** da
correção (falhando) e passa depois. Mostre os dois resultados.
