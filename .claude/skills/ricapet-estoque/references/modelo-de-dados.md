# Modelo de dados do estoque

Levantado do código em out/2026. Números de linha mudam — procure pelo
nome da função/constante.

## Identidade de um item: produto + cor + tamanho

Não existe "id de produto". Um item de estoque é a tripla de **texto**
`(produto, cor, tamanho)`, comparada de forma **exata** (maiúscula,
acento e espaço contam). Tamanho sem variação é `'-'`.
- Banco (`estoque_saldo`): chave primária `(produto, cor, tamanho)`.
- Planilha Google: `-` vira `única` na ida e volta (`enviarBalancoAgora` /
  `importarSaldoDaPlanilha`).
- Tela de reposição: tamanho `-` aparece como "Estoque geral"; cor vazia
  vira `Sem cor`.

⚠️ Como a comparação é exata, `200x50` e `200X50` são itens **diferentes**
— ver `pendencias.md` (divergência de nomes). Não normalize por conta
própria: normalizar muda saldos existentes.

## Catálogo — `public/catalog.json`

- Formato: `{ "<produto>": { "<cor>": ["<tamanho>", ...] } }`.
- Em out/2026: 67 produtos, 213 combinações.
- Origem: a constante `CATALOG` em `public/estoque-atualizar.html`
  (comentário diz que veio da planilha "Produtos_Estoque.xlsx"). Ao editar
  `CATALOG`, regenerar `catalog.json` (script `gerar_catalog_json.py` do
  antigo repo `painel-estoque-adesivo` (legado — ver "Fonte oficial" no SKILL.md) — lá ele existe; aqui ainda não há
  equivalente, então hoje a sincronia é manual ⚙️).
- Uso: `importarContagemFisica` percorre o catálogo inteiro (combinação
  sem contagem vira saldo 0); `completarCatalogoFaltante` insere as que
  faltam com 0.
- Tamanhos no catálogo vêm em MAIÚSCULO (`50X30`); na tela de reposição e
  na tabela de SKU aparecem minúsculo (`50x30`).

## Tabela de SKU — `lib/tabelaProdutos.json`

- Formato: `{ "<SKU>": { produto, cor, tamanho, custo } }` — 551 SKUs em
  out/2026.
- Gerada por `scripts/gerar_tabela_produtos.py` a partir de
  `C:\FECHAMENTO\03 AUXILIARES\TABELA_AUXILIAR.xlsx`, aba
  `TABELA_PRODUTOS`, lendo por **posição** de coluna (SKU=3, PRODUTO=5,
  COR=6, TAMANHO=7, CUSTO=9, base 0), dados a partir da linha 2,
  `data_only=True`.
  - Sem SKU → linha ignorada (contada no resumo).
  - Produto vazio → `"Não identificado"`; cor/tamanho vazios → `"-"`.
  - Custo numérico → float, senão `null`.
  - SKU repetido → **a última linha vence** (⚙️, ~7 casos conhecidos,
    "inconsistências de cadastro pré-existentes").
  - Depois de gerar: commit + push manual (CLAUDE.md, "Integrações").
- Busca (`buscarProdutoPorSku`): `trim` e comparação exata; não achou →
  `{ produto: 'Não mapeado', cor: '-', tamanho: '-', custo: null }`.
- O SKU **não é interpretado**: nenhuma regra extrai cor/tamanho do texto
  do SKU. Tudo vem da tabela.
- SKU do pedido: ML `item.seller_sku`; Shopee `model_sku || item_sku`.
  Quantidade: ML `quantity`; Shopee `model_quantity_purchased`.

## Tabelas no Turso

| Tabela | Chave | Para quê |
|---|---|---|
| `estoque_saldo` | produto, cor, tamanho | saldo corrente (`saldo REAL`, `atualizado_em`) |
| `estoque_baixas` | id_unico, item_index | log de cada baixa (`quantidade`, `sku`, `aplicado_em`, `revertido`, `revertido_em`) — garante que um pedido não baixa duas vezes |
| `estoque_vendas_nao_mapeadas` | id_unico, item_index | vendas cujo SKU não está na tabela (não baixam nada) |

KV: `entrega_turbo:balanco_mensal_ultimo_mes` = `'AAAA-MM'` do último
balanço enviado.

`id_unico` = `"<marketplace>:<order_id>"` (marketplace padrão
`mercado_livre`).

## Contagem física — JSONBin

Acesso só pelo servidor (`/api/debug?tipo=estoque-contagem-get|set`); a
chave do JSONBin fica nas variáveis de ambiente
`JSONBIN_ESTOQUE_API_KEY`/`JSONBIN_ESTOQUE_BIN_ID`.

```
record.estoque = {
  leadTimeDays,                       // lead time da tela de reposição
  stock: { produto: { cor: { tam: { proprio, full, atualizadoEm } } } },
  rolls: { cor: { tamRolo: { proprio, full } } },
  updatedAt                           // ISO — QUALQUER edição atualiza
}
record.vendas = { months, monthKeys, unitsMonthly, m2Monthly, revMonthly, nest, updatedAt }
```
- Contagem é sempre em **unidades** (peças ou rolos).
- `proprio` = estoque Ricapet; `full` = estoque no Full (importado de
  relatório, não digitado no celular).
- `atualizadoEm` por célula = dia da contagem (`AAAA-MM-DD`), usado no
  "✓ Contado hoje" da tela mobile.

## Estoque Adesivo (tela de reposição)

Constantes em `public/estoque.html`:
- `TARGET_PRODUCTS`: 19 produtos que usam adesivo (só eles entram no
  cálculo de compra).
- `FIXED_AREA_PER_UNIT`: m² de adesivo por peça vendida, por produto
  ("baseado na tabela informada" — fonte não registrada ❓). Arranhador
  Adesivo e Piso Carpete não estão na tabela: a área vem do próprio
  TAMANHO (`LxA` em cm → m²).
- `ROLL_COLORS` / `ROLL_TAMS`: cores de rolo e tamanhos `100x7000`
  (1 m × 70 m = 70 m²) e `50x7000` (0,5 m × 70 m = 35 m²).
- `COMBOS_EXCLUIDOS`: Degrau/Grafite/P (erro de classificação num
  relatório de venda).
- `NO_ADHESIVE_PRODUCTS`: vazio hoje.
