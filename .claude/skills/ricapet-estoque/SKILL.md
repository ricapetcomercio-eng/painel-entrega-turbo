---
name: ricapet-estoque
description: Regras e padrões dos processos de estoque da Ricapet/Thapets neste repo — produtos, SKU, cores, tamanhos, catálogo, saldo (estoque_saldo), baixa automática por venda e estorno, contagem física (JSONBin / Google Sheets), Estoque Adesivo (consumo médio, m² por peça, rolos, lead time, quantidade a comprar, "comprar até"), balanço mensal, relatórios, importação/exportação Excel/CSV, validações e erros. Use SEMPRE que a tarefa tocar estoque, SKU, tabelaProdutos, catalog.json, estoque*.html, lib/estoqueSaldo.js, reposição, compra de material, consumo, previsão de vendas por produto, ou quando alguém perguntar "quanto tem", "quanto comprar", "por que o saldo está errado", "importa essa planilha" — mesmo que a palavra "estoque" não apareça. Esta skill proíbe inventar regra de negócio: o que não está documentado aqui vira pergunta ao dono, não suposição.
---

# Ricapet Estoque

## A regra mais importante: não invente regra de estoque

Estoque errado custa dinheiro de verdade: compra a mais parada no galpão,
compra a menos vira pedido sem produto e reputação perdida no marketplace.
Uma regra "razoável" inventada por um agente (estoque de segurança de 20%,
arredondar para rolo inteiro, ignorar devolução...) parece certa, passa na
revisão de código e só aparece semanas depois, no galpão. Por isso:

1. **Toda regra que você usar precisa estar em `references/regras.md`**
   (com o arquivo/função onde ela está implementada).
2. **Se a regra não está lá, ela não existe ainda.** Não preencha a lacuna
   com bom senso, prática de mercado ou "o que normalmente se faz". Pare
   e pergunte ao dono (Ricardo), usando o modelo de pergunta abaixo.
3. **Se a regra está lá marcada ❓ (a confirmar)**, você pode descrevê-la,
   mas não pode construir nada novo em cima dela nem "corrigi-la" sem
   confirmação — ela está na lista de pendências justamente porque pode
   estar errada.
4. **Comportamento atual ≠ regra de negócio.** Muita coisa está no código
   sem que ninguém tenha decidido (ex.: saldo pode ficar negativo; kit
   baixa 1 unidade). Descreva como "o sistema hoje faz X", nunca como "a
   regra é X".

### Status de cada regra

| Marca | Significa | O que você pode fazer |
|---|---|---|
| ✅ Confirmada | decisão do dono registrada (CLAUDE.md, comentário com decisão, conversa) | usar e construir em cima |
| ⚙️ Implementada | está no código e funciona, mas ninguém confirmou que é a regra certa | usar como está; não estender sem perguntar |
| ❓ A confirmar | lacuna, divergência ou suposição conhecida | só descrever; perguntar antes de qualquer mudança |

### Modelo de pergunta ao dono

Quando faltar regra, não trave o trabalho inteiro — entregue o que dá e
deixe a pergunta explícita, curta e com opções concretas, em português
simples (o dono não é programador):

```
❓ Preciso de uma decisão sua sobre estoque:
<a situação real, com exemplo concreto: produto, número>
Hoje o sistema faz: <comportamento atual, se houver>
Opções:
  A) <opção> — consequência prática
  B) <opção> — consequência prática
Enquanto você não decidir, vou <o que vou fazer de forma segura, ex.: manter como está / só mostrar o aviso>.
```

Depois que o dono responder, registre a decisão em `references/regras.md`
(mude a marca para ✅, com data e o que foi decidido) no mesmo PR.

## Mapa do sistema (onde cada coisa vive)

| Peça | Onde | Detalhe |
|---|---|---|
| Catálogo produto→cor→tamanhos | `public/catalog.json` + `CATALOG` em `public/estoque-atualizar.html` | `references/modelo-de-dados.md` |
| SKU → produto/cor/tamanho/custo | `lib/tabelaProdutos.json` (gerado de `TABELA_AUXILIAR.xlsx` por `scripts/gerar_tabela_produtos.py`) | idem |
| Saldo corrente | Turso `estoque_saldo` (`lib/estoqueSaldo.js`) | `references/regras.md` §1-3 |
| Baixa/estorno por venda | `reconciliarEstoque` / `reverterBaixasDoPedido` | §2 |
| Contagem física | JSONBin (via `/api/debug?tipo=estoque-contagem-*`), tela `estoque-atualizar.html` | §3 |
| Saldo na tela | `estoque-saldo.html` (só leitura) | — |
| Reposição / compra de adesivo | `public/estoque.html` (cálculo 100% no navegador) | §4-5 |
| Balanço mensal → Google Sheets | `enviarBalancoMensalSeNecessario` | §6 |
| Importação/exportação | `references/importacao-exportacao.md` | — |
| Lacunas e perguntas abertas | `references/pendencias.md` | leia antes de mexer |

## Fonte oficial do painel de estoque (decisão do Ricardo, 10/10/2026)

**Fonte oficial do painel de estoque: `painel-entrega-turbo`** (este repo:
`public/estoque.html`, `public/estoque-atualizar.html`,
`public/estoque-saldo.html`, `public/catalog.json`, `lib/estoqueSaldo.js`,
`lib/tabelaProdutos.*`). O repositório `painel-estoque-adesivo` é
considerado **versão legada** e não deve ser alterado nem utilizado como
referência de implementação, salvo quando explicitamente solicitado.
**Antes de modificar funcionalidades relacionadas ao estoque, verificar se a
alteração está sendo feita na fonte oficial** (caminho de arquivo neste
repo — não numa cópia do repo antigo).

- As telas do repo legado foram portadas para cá em set/2026 (PR #23) e o
  projeto Vercel dele foi apagado; a lógica de negócio é igual linha a
  linha, mas o legado aponta para domínios mortos.
- A única peça útil que só existe lá é o gerador do `catalog.json`
  (`gerar_catalog_json.py`) — se for necessário, **traga para este repo**
  em vez de rodar lá (pendência 24).
- **Catálogo único ainda não foi decidido.** Hoje o catálogo vive em vários
  lugares (`catalog.json`, `CATALOG` das telas, `ROLL_COLORS`,
  `TARGET_PRODUCTS`, `tabelaProdutos.json`) e diverge entre eles. Existe a
  ideia de um "catálogo oficial" alimentando estoque e outros sistemas, mas
  a arquitetura **não foi escolhida** — não consolide, não crie fonte nova
  de catálogo e não "unifique" nomes por conta própria (pendências 2, 16,
  24 e 26).

## Fluxo de trabalho

**Pergunta ("quanto tem de X?", "por que o saldo de Y está errado?")**
1. Localize a regra envolvida em `references/regras.md`.
2. Responda dizendo de onde vem o número (contagem de quando, baixas
   desde então) e o status da regra. Para investigar um caso real, use as
   rotas de leitura (`?tipo=estoque-saldo`) — nunca as de escrita.
3. Se a explicação depende de uma pendência ❓, diga isso claramente.

**Mudança de código**
1. Leia `references/pendencias.md` — talvez o que você vai mexer seja uma
   pendência aberta.
2. Mudou fórmula, constante ou critério? Precisa de regra ✅ que mande
   mudar, ou de pergunta respondida pelo dono. Correção de bug óbvio
   (erro de digitação, crash) não precisa — mas mudança de *resultado*
   do cálculo precisa.
3. Rode `python3 .claude/skills/ricapet-estoque/scripts/conferir_catalogo.py`
   quando mexer em catálogo, tabela de SKU ou nomes de produto/cor/tamanho.
4. No PR, liste: regras usadas (com status), regras novas (com a decisão
   do dono citada) e perguntas que ficaram abertas.

**Importação de planilha**: siga `references/importacao-exportacao.md`
— colunas, abas e validações já esperadas. Planilha com formato
diferente do documentado é pergunta, não adaptação silenciosa.

## Limites de segurança (não negociáveis)

- **Nunca chame rotas que escrevem estoque em produção** por conta
  própria: `importar-contagem-fisica`, `importar-saldo-da-planilha`,
  `completar-catalogo-faltante`, `corrigir-cor-arranhador-adesivo-bege`,
  `estoque-contagem-set`, `estoque-sheets-log`, `balanco-mensal`. Elas
  **sobrescrevem** saldo ou contagem e não têm desfazer. Explique ao dono
  o que rodar e por quê; ele roda.
- `estoque-contagem-set` com corpo vazio **apaga a contagem inteira** no
  JSONBin (grava `{}`). Qualquer código novo que chame essa rota precisa
  mandar o `record` completo (ler → alterar → gravar), como as telas fazem.
- Não copie valores de segredo/token em código novo, PR, issue ou
  mensagem. (Já existe um segredo de estoque escrito nas páginas públicas
  — está em `pendencias.md`; não espalhe.)
- Planilha real (vendas, custos, contagem) não entra no repo — o repo é
  público. Para teste, invente dados.
- Restrição nº 1 do CLAUDE.md vale aqui: nada de baixa/recálculo de
  estoque em `api/dashboard-data.js`, e nada que aumente a frequência de
  chamadas de API na coleta.

## Vocabulário (use estes termos, o dono usa estes)

- **Ricapet / próprio**: estoque físico no galpão da empresa.
- **Full**: estoque dentro do armazém do marketplace (Mercado Livre Full /
  Shopee). Na contagem é um campo separado; **o saldo automático não
  rastreia Full** (vai 0 no balanço).
- **Rolo**: matéria-prima de adesivo (carpete), 1 m × 70 m ou 0,5 m × 70 m,
  contado por cor, compartilhado entre todos os produtos.
- **Tamanho `-`**: produto sem variação de tamanho ("única" na planilha,
  "Estoque geral" na tela).
- **Lead time**: dias entre pedir o material e ele chegar.
