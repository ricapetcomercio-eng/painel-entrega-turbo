---
name: ricapet-testes
description: Como testar os sistemas da Ricapet/Thapets (painel-entrega-turbo) antes de dizer que uma tarefa está pronta — teste de verdade no navegador com Playwright (páginas de public/*.html abertas num Chromium com sessão e dados FALSOS, sem tocar na produção), rotas de api/*.js chamadas localmente contra um SQLite de arquivo, e o que conta como evidência. Cobre navegação, botões, formulários, filtros, tabelas, modais, responsividade, estados de erro e carregamento, dados, fluxos completos e regressões. Use SEMPRE que for terminar, revisar ou mergear qualquer mudança neste repo (tela, TV, rota, lib, script), quando alguém perguntar "funciona?", "testou?", "pode mergear?", ou antes de escrever "pronto", "corrigido" ou "concluído" — mesmo que a palavra "teste" não apareça.
---

# Ricapet Testes

**Regra central: não declare nada pronto sem evidência de que foi
verificado rodando.** Ler o código e achar que está certo não é evidência.
Evidência é a saída de um comando que você rodou agora: teste passando,
print da tela, resposta da rota. Isso é a mesma ideia da skill
`superpowers:verification-before-completion`, aplicada a este projeto.

O Ricardo não é programador: ele confia no "pronto" que você escreve. Um
"pronto" sem teste que quebra a TV do galpão custa pedido atrasado de
verdade.

## Segurança: o que os testes NUNCA fazem

- Nunca chamam a produção (`ricapetadministrativo.vercel.app`), o Turso
  real, Mercado Livre, Shopee, Omie ou JSONBin. O harness responde todo
  `/api/*` com dados falsos; o `chamar_api.mjs` usa um SQLite local.
- Nunca usam o `CRON_SECRET` real (o de teste é `teste`).
- Nunca usam dado real: nada de nome de cliente, de funcionário, CPF ou
  valor de verdade em fixture, print ou PR (o repo é público). Use os
  fixtures inventados desta skill ou a planilha de exemplo do Fechamento.
- Não criam `node_modules/` dentro do repo (ele não está no `.gitignore`):
  `chamar_api.mjs` instala as dependências numa pasta temporária.

## As ferramentas desta skill

Tudo em `.claude/skills/ricapet-testes/scripts/`, rodando da raiz do repo:

| Ferramenta | Para quê |
|---|---|
| `testar_pagina.mjs <pagina.html>` | **Fumaça**: abre a página em 390/1366/1920px com sessão e dados falsos, salva prints, lista erro de JavaScript, erro de console, rede, `/api` sem mock e rolagem horizontal. Sai com código 1 se algo deu errado. |
| `harness.mjs` (`abrirPagina`) | Biblioteca para **teste de comportamento**: devolve um `page` do Playwright pronto para clicar, digitar e conferir. |
| `exemplo_tv.mjs` | Modelo de teste de comportamento completo (dados, ordem, KPI, filtro, busca, estado de erro). Copie e adapte. |
| `chamar_api.mjs <api/x.js> [query] [json]` | Chama uma rota do backend localmente, contra SQLite de arquivo. |
| `gerar_fixture_fechamento.mjs` | Regera `fixtures/fechamento.json` a partir da planilha inventada. |
| `fixtures/*.json` | Dados falsos por página (`tv.json`, `fechamento.json`). Página sem fixture: crie um (ver `references/mocks.md`). |

Como o harness funciona, em uma linha: abre `public/` direto do disco,
coloca uma sessão falsa de admin no `sessionStorage` (mesmo formato que
`assets/auth.js` lê), responde `/api/*` com os mocks e baixa fontes/Chart.js
pelo proxy do ambiente. Detalhes e opções: `references/mocks.md`.

## O ciclo de verificação (siga na ordem)

1. **Sintaxe** — o mínimo, nunca é suficiente sozinho.
   - `.js` editado: `node --check arquivo.js`.
   - `.html` editado: extraia cada `<script>` e rode `node --check` (o
     verificador visual `ricapet-paineis/scripts/checar_pagina.py` também
     ajuda).
   - `.py`: `python3 -m py_compile arquivo.py`.
2. **Fumaça da página** que você mexeu:
   `node .claude/skills/ricapet-testes/scripts/testar_pagina.mjs <pagina>.html --saida <scratchpad>`
   e **olhe os prints** (abra o PNG). Zero erro de JavaScript, zero `/api`
   sem mock, sem rolagem horizontal no celular.
3. **Comportamento**: escreva um teste curto com `abrirPagina` que faz o
   que a tarefa pediu e confere o resultado na tela (receitas por tipo em
   `references/receitas.md`). Teste o caminho feliz **e** pelo menos um
   caminho de erro (API falhando, lista vazia, campo inválido).
4. **Backend** (se mexeu em `api/` ou `lib/`): `chamar_api.mjs` contra o
   SQLite local — rode `tipo=criar-tabelas` e `tipo=adicionar-coluna-tipo`
   antes, insira o dado de teste, chame a rota, confira a resposta **e** o
   que ficou gravado.
5. **Regressão**: rode de novo a fumaça das páginas que usam o mesmo dado
   ou o mesmo arquivo (`references/receitas.md` § Regressões tem o mapa) e,
   se mexeu na TV, o `exemplo_tv.mjs`.
6. **Relate a evidência** (formato abaixo). Se algo não pôde ser testado
   localmente, diga exatamente o quê e como o Ricardo confere depois do
   deploy.

Não pule do passo 1 para "pronto". Se o teste falhou, corrija e rode de
novo; não declare sucesso parcial como sucesso.

## O que não dá para testar aqui (diga isso explicitamente)

- **Dado real e integrações**: resposta verdadeira do Mercado Livre/Shopee/
  Omie, o cron das 6h-18h, a bipagem do galpão (`checkout_bipagem.py`), o
  envio do Fechamento do PC do Ricardo.
- **Login de verdade** (PIN, sessão assinada no servidor): o harness usa
  sessão falsa; o bloqueio real é do backend.
- **Preview da Vercel**: o domínio `*.vercel.app` não abre deste ambiente
  e pede login. "A Vercel publicou sem erro" só prova que o deploy subiu,
  não que a tela funciona.
- **Consumo de CPU** na Vercel: confira no código (intervalos, chamadas
  por pedido) — veja a Restrição nº 1 do `CLAUDE.md`.

Para esses, escreva no relatório "**Não verificado localmente:** … —
para conferir depois do deploy: …" com um passo simples que o Ricardo
consiga seguir (qual tela abrir, o que deve aparecer).

## Formato da evidência no relatório / PR

```
## Como testei
- Sintaxe: node --check em api/x.js e nos 2 <script> de public/y.html — ok
- Fumaça: testar_pagina.mjs y.html (390/1366/1920) — sem erro de JS, sem /api sem mock, sem rolagem horizontal
- Comportamento (Playwright, dados inventados): 6/6 casos ok — filtro X, ordenação, modal abre/fecha com Esc, erro 500 mostra aviso, …
- Backend: chamar_api.mjs api/x.js — 200 e linha gravada com categoria='coletado'; secret errado → 401
- Regressão: fumaça de tv.html e index.html — ok
- Não verificado localmente: <o quê> — conferir depois do deploy: <passo>
```

Números concretos ("6/6 casos", "0 erros") e o nome do comando. Nada de
"deve funcionar" ou "parece certo".

## Quando o teste encontra um problema que não é da sua tarefa

Não corrija de passagem. Anote no relatório ("achei, não mexi") com o
print ou a saída do comando — se for regra de negócio, siga a skill do
domínio (`ricapet-expedicao`, `ricapet-paineis`) e pergunte.
