# Regras de estoque (o que existe hoje)

Legenda: ✅ confirmada pelo dono · ⚙️ implementada, sem confirmação ·
❓ a confirmar (ver `pendencias.md`). Ao confirmar uma regra com o dono,
troque a marca e anote a data/decisão aqui.

## 1. Saldo

- ⚙️ **Saldo é um valor corrente, não um balanço contábil**:
  `saldo = última contagem importada − baixas posteriores + estornos`.
  Não existe saldo inicial + entradas − saídas por período, nem histórico
  de saldo por mês (só o valor atual + o log `estoque_baixas`).
- ⚙️ **Não existe entrada de mercadoria** (compra/produção) no sistema. O
  saldo só sobe por estorno ou por nova contagem.
- ⚙️ **Saldo pode ficar negativo** (a baixa não para em zero). ❓ se isso
  é desejado (sinal de contagem desatualizada) ou deveria travar/avisar.
- ⚙️ Baixa num item que não existe em `estoque_saldo` cria a linha com
  saldo negativo.
- ⚙️ Saldo e log de baixas não são gravados numa transação única.

## 2. Baixa automática por venda e estorno — `lib/estoqueSaldo.js`

- ⚙️ **Quando**: toda vez que pedidos são gravados em `historico_todos`
  (`registrarHistoricoTodos` → `reconciliarEstoque`) — coleta ML/Shopee,
  reconferências, backfills. Ou seja, segue o cron (6h-18h seg-sáb) e os
  intervalos da coleta.
- ⚙️ **Quanto baixa**: `item.quantidade` do pedido, no item mapeado pelo
  SKU. Sem multiplicador. ❓ **kit/par** (ex.: `..._Par`, `...-Kit2`,
  `..._KIT5`) baixa 1 unidade do produto unitário, não 2/5.
- ⚙️ **Idempotência**: se já existe qualquer linha em `estoque_baixas`
  para o `id_unico` do pedido (mesmo revertida), o pedido inteiro é
  pulado. Por item, `ON CONFLICT DO NOTHING`. Reprocessar pedidos é seguro
  (confirmado na 9ª rodada do CLAUDE.md).
- ⚙️ Consequências da idempotência:
  - pedido só com SKU não mapeado não deixa linha → se o SKU for mapeado
    depois, a baixa acontece no próximo reprocessamento;
  - pedido misto (mapeado + não mapeado) nunca baixa os não mapeados,
    mesmo mapeando depois ❓;
  - pedido já estornado nunca volta a baixar.
- ⚙️ **SKU não mapeado**: não mexe no saldo, vai para
  `estoque_vendas_nao_mapeadas` (contado em `?tipo=estoque-saldo`).
- ⚙️ **Estorno** (`reverterBaixasDoPedido`): devolve a quantidade de cada
  baixa não revertida e marca `revertido=1`. Disparado quando o pedido
  chega `cancelado` ou `devolvido`, ou por `marcarDevolucao`.
- ⚙️ **Cancelado** = ML `status === 'cancelled'` (❓ `invalid` não conta —
  TODO no código); Shopee só `CANCELLED` (❓ `IN_CANCEL` não conta;
  pedido `UNPAID` baixa normalmente).
- ⚙️ **Devolvido** = ML claim `type === 'returns'` ou ação
  `return_review_*` (heurística inferida de amostra, não documentada pelo
  ML); Shopee qualquer status de devolução ≠ `CANCELLED`. ❓ O estoque
  volta quando a devolução é **aberta**, não quando o produto chega de
  volta — e o vendedor pode ganhar a disputa.
- ✅ **Reclamação sem devolução não mexe no estoque** (CLAUDE.md,
  "Devoluções e reclamações").
- ⚙️ Erro na baixa/estorno é só logado (`console.error`); nunca impede a
  gravação do pedido.
- ❓ Backfill ML (`api/backfill-todos-api.js`) não preenche `cancelado` —
  pedido cancelado reprocessado por ele pode baixar estoque.

## 3. Contagem física

- ✅ **Contagem física sobrescreve o saldo** ("a contagem física é a
  verdade nova, não tenta reconciliar com baixas antigas" —
  `importarContagemFisica`).
- ⚙️ Importar a contagem percorre o **catálogo inteiro**: combinação sem
  contagem vira **0**. Itens fora do catálogo (criados só por baixa) não
  são tocados.
- ⚙️ Usa só `proprio` (estoque Ricapet). Full não entra no saldo.
- ⚙️ Contagem no celular (`estoque-atualizar.html`): o operador digita só
  o próprio; salva sozinho (sem confirmação), por célula alterada,
  preservando o resto do registro remoto.
- ⚙️ Há duas fontes de "saldo inicial": JSONBin (`importar-contagem-fisica`)
  e a aba "Estoque Ricapet" do Google Sheets (`importar-saldo-da-planilha`).
  ❓ qual é a oficial quando divergem.

## 4. Consumo (tela de reposição, `public/estoque.html`)

- ⚙️ Fonte: relatórios de venda ML e Shopee importados (Excel), agregados
  por mês (unidades; m² = unidades × área por peça).
- ⚙️ Período: escolhido pelo usuário (mês início/fim; padrão = todos).
- ⚙️ **Média mensal** = soma dos meses do período ÷ nº de meses (média
  simples).
- ⚙️ **Consumo diário** = média mensal ÷ **30** (todo mês = 30 dias ❓).
- ⚙️ Consumo em m² quando o produto tem área; senão em unidades.
- ❌ **Não existe previsão** (tendência, sazonalidade, crescimento). A
  "previsão" é a média do período projetada em linha reta. Não crie
  modelo de previsão sem pedido explícito do dono.

## 5. Necessidade de compra (tela de reposição)

- ⚙️ **Lead time** padrão **15 dias** (editável na tela, salvo no JSONBin).
- ⚙️ **Dias desde a contagem** = agora − `estoque.updatedAt` (data da
  última edição de QUALQUER célula, não da célula em questão ❓).
- ⚙️ **Estoque efetivo** = máx(0, estoque contado − dias desde a contagem ×
  consumo diário). É estimativa, não contagem.
- ⚙️ **Quantidade a comprar** = máx(0, consumo diário × lead time −
  estoque efetivo). Cobertura = exatamente o lead time.
  - ❌ Não há estoque de segurança, estoque mínimo, cobertura extra nem
    arredondamento para rolo inteiro/múltiplo. Não adicione sem decisão.
- ⚙️ **Dias restantes** = estoque efetivo ÷ consumo diário; a cor usa o
  menor entre os tamanhos.
- ⚙️ **Status da cor**: sem consumo → "Sem histórico"; ≤ 0 dias →
  "Comprar agora"; ≤ lead time → "Providenciar em breve"; senão
  "Estoque OK".
- ⚙️ **Comprar até** = hoje + dias restantes − lead time. Vermelho se já
  passou; amarelo se faltam ≤ **7** dias ❓ (sem justificativa registrada).
- ⚙️ **Rolo**: estoque de rolo da cor = Σ rolos × área (70 m² ou 35 m²);
  só Ricapet (rolo não tem Full). Na visão "Total geral", necessidade
  líquida da cor = máx(0, Σ necessidade em m² − estoque de rolo da cor).
  Na visão por produto o rolo **não** é descontado (a própria tela avisa).
- ❓ A ordenação da visão geral soma m² com unidades.

## 6. Balanço mensal → Google Sheets

- ⚙️ A cada coleta, se o mês atual ainda não foi enviado, envia todas as
  linhas de `estoque_saldo` para a aba "Estoque Ricapet" (`full: 0`
  sempre) e grava o mês no KV. Falhou → tenta na próxima coleta.
- ❓ "Mês atual" é calculado em **UTC**, não no fuso de São Paulo (outras
  partes do sistema já tiveram bug por isso — CLAUDE.md, Fluxo de Caixa).
- ⚙️ Envio manual: `?tipo=balanco-mensal` (só CRON_SECRET).

## 7. Vendas por produto (aba Desempenho)

- ⚙️ Soma quantidade e valor por produto/mês/variação, cruzando SKU com a
  tabela; meses no fuso de São Paulo. ❓ Não desconta cancelados nem
  devolvidos nessa soma — não use esse número como "consumo" sem decidir
  isso com o dono.
