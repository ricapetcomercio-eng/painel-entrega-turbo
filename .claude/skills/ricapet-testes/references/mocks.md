# Harness, sessão falsa e mocks

## `abrirPagina(opções)`

```js
import { abrirPagina } from './.claude/skills/ricapet-testes/scripts/harness.mjs';
const t = await abrirPagina({
  pagina: 'fechamento.html',          // arquivo de public/ (pode ter ?query)
  mocks: 'fixtures/fechamento.json',  // ou um array de rotas (abaixo)
  sessao: {},                         // {} = super_admin; { superAdmin:false, paginas:['bipagem'] }; false = sem login
  viewport: { width: 390, height: 844 },
  agora: '2026-10-07T14:00:00-03:00', // opcional: congela o relógio
  bloquearExternos: false,            // true = sem fontes/CDN (internet ruim)
});
// t.page (Playwright), t.relatorio (erros), await t.fechar() imprime o relatório
```

Salve o script do teste no scratchpad (não no repo), a menos que a tarefa
seja justamente criar um teste permanente.

- O navegador roda em pt-BR e no fuso **America/Sao_Paulo**.
- `t.relatorio`: `paginaErros` (exceção JS), `consoleErros`, `redeFalhas`,
  `apiSemMock` (rota que a página chamou e você não mockou — responde 599),
  `apiChamadas` (tudo que a página pediu, útil para conferir que um botão
  chamou a rota certa com os parâmetros certos).
- Sessão falsa = `sessionStorage.ricapet_sessao` no formato de
  `assets/auth.js` (token `base64url(JSON).assinatura`). A assinatura é
  falsa — só o navegador lê; nenhuma rota real é chamada.

## Formato dos mocks

```json
{ "rotas": [
  { "url": "tipo=fechamento-dados", "body": { "ok": true } },
  { "url": "/api/dashboard-data", "status": 500, "body": { "error": "falha" } },
  { "url": "tipo=acessos-definir", "metodo": "POST", "body": { "ok": true } },
  { "url": "/api/collect", "atrasoMs": 3000, "body": {} },
  { "url": "tipo=bipagem-resolver-pendentes", "abortar": true }
] }
```

- `url`: trecho que precisa aparecer na URL. A **primeira** rota que casa
  vence — ponha as mais específicas antes.
- `status` (padrão 200), `metodo` (opcional), `atrasoMs` (testa
  carregamento), `abortar: true` (testa queda de rede).
- **Datas relativas**: `"@agora"`, `"@agora-30m"`, `"@agora+2h"`,
  `"@agora-1d"` viram ISO; `"@ms(@agora+2h)"` vira número em ms. Com
  `agora` definido, ficam relativas ao relógio congelado.

## Criando o fixture de uma página nova

1. Veja que rotas a página chama:
   `grep -oE "/api/[a-z-]+(\?[a-z_]+=[a-z-]+)?" public/<pagina>.html | sort -u`
   ou rode `testar_pagina.mjs` sem mocks e leia "Chamadas /api SEM mock".
2. Descubra o formato da resposta **no código da rota** (`api/…js`,
   `res.status(200).json(...)`) e nos campos que a página lê — não invente
   campo.
3. Monte dados claramente falsos (`TESTE-…`, `SKU-TESTE-01`, "Produto
   Teste A", valores redondos) que exercitem os casos da tela: atrasado,
   vazio, um de cada tipo, número negativo, texto longo, caractere especial
   (`<b>`, `&`) para conferir o escape.
4. Salve em `fixtures/<pagina>.json` (o `testar_pagina.mjs` acha sozinho).

Rotas usadas hoje por página (out/2026):

| Página | Rotas |
|---|---|
| tv.html | `/api/dashboard-data` |
| index.html | `/api/dashboard-data`, `/api/analytics-todos-data` |
| fechamento.html | `debug?tipo=fechamento-dados` |
| bipagem.html / bipagem-v2.html | `analytics-todos-data?visao=bipagem`, `debug?tipo=bipagem-resolver-pendentes` |
| ponto.html | várias `debug?tipo=ponto-*` |
| projecao-financeira.html | `/api/dashboard-data`, `/api/collect`, `debug?tipo=fluxo-caixa-*` |
| acessos.html | `debug?tipo=acessos-listar/-definir/-historico` |
| estoque*.html | `debug?tipo=estoque-*` (+ JSONBin/Sheets externos — mock por URL completa) |
| login.html | `debug?tipo=ponto-login` |

## Backend local (`chamar_api.mjs`)

```bash
S=.claude/skills/ricapet-testes/scripts/chamar_api.mjs
node $S api/debug.js "tipo=criar-tabelas&secret=teste"
node $S api/debug.js "tipo=adicionar-coluna-tipo&secret=teste"
node $S api/marcar-coletado.js "" '{"secret":"teste","tipo":"ml","identificador":"999"}'
```

Para inserir dado de teste ou conferir o que ficou gravado, use o mesmo
banco (`/tmp/ricapet-teste.db`) com um script Node que faça `require` de
`lib/db.js` depois de definir `TURSO_DATABASE_URL=file:/tmp/ricapet-teste.db`
e `TURSO_AUTH_TOKEN=teste-local` (veja como `chamar_api.mjs` monta o
ambiente). Rotas que chamam marketplace falham localmente — teste a parte
de banco/lógica, e diga que a parte da API externa não foi verificada.
