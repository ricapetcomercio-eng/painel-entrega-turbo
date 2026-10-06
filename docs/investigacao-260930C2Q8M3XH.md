# Investigação: pedido Shopee #260930C2Q8M3XH aparecendo como ATRASADO no "Shopee geral"

Data: 06/out/2026
Sintoma: por volta das 13h54 (Brasília), a TV mostrava esse pedido no topo, selo
SHOPEE (geral), conta ricapet, "1x Pegaareia_Amarelo", contador `-13:54:19`.
O CLAUDE.md (6ª rodada) dizia que ele já estava `categoria = "coletado"` desde 30/set.

## Conclusão

**Não é bug do código.** O pedido voltou para a fila da TV porque foi
**reaberto de propósito**, a pedido do próprio dono do projeto, em 05/out/2026.
O atraso mostrado é real: é o prazo de despacho (`ship_by_date`) que a própria
Shopee deu ao pedido, e esse prazo venceu à 00:00 de 06/out.

Não alterei nenhum código.

### O que aconteceu, em ordem

1. **30/set**: o pedido foi marcado `coletado` em `historico_todos` (bipagem →
   `api/marcar-coletado.js:79-84`). É o estado que a 6ª rodada do CLAUDE.md registra.
2. **Depois disso**: a Shopee continuava mostrando o pedido como "A Enviar", com
   prazo novo, dias depois. Ou seja, a transportadora não retirou o pacote de
   verdade. A busca de quem bipou (PRs #199–#201, rotas `bipagem-por-order-id` /
   `bipagem-do-dia`) não achou a linha em `bipagem_diaria`.
3. **05/out, PR #202 (`f9cd1d6`)**: foi criada a rota
   `POST /api/debug?tipo=reabrir-pedido` (`api/debug.js:1393-1443`), feita
   **especificamente para este pedido**. Ela zera `categoria`, `coletado` e
   `coletado_em` em `historico_todos` (`api/debug.js:1424-1428`). O motivo,
   registrado no commit, foi "colocar de volta na fila da TV até o pacote ser
   retirado/investigado fisicamente no galpão".
4. Com `categoria = NULL` e `status_pedido` ainda `READY_TO_SHIP`/`PROCESSED`, o
   pedido volta a passar no filtro de `listarShopeeAguardando`
   (`lib/historicoTodos.js:317-336`). Também entra outra vez no pool de
   `reverificarPendentesShopeeTodos` (`api/collect.js:521-548`), que atualiza
   `status_pedido` e `prazo_entrega` a cada ciclo da Shopee (15 min).
5. **05/out, PR #205 (`20dd681`)**: a mensagem do commit já cita este pedido.
   O pedido foi criado em 29/set, e a reconferência reestimou `prazo_entrega`
   para 06/out, porque a Shopee recalcula o `ship_by_date` de pedido parado.
6. **06/out, 13h54**: `prazo_entrega` ≈ `2026-10-06T03:00:00Z` (00:00 em
   Brasília). O card usa esse valor direto como deadline (`public/tv.html:677-679`),
   então a TV mostra -13:54:19 e zona `preto` (atrasado), com o destaque máximo
   pedido pelo dono do projeto.

### As 3 hipóteses da tarefa

| # | Hipótese | Resultado |
|---|---|---|
| 1 | Re-sincronização sobrescreve `coletado` | **Descartada.** O upsert de `registrarHistoricoTodos` preserva a categoria quando o pedido novo vem sem ela: `CASE WHEN excluded.categoria IS NULL THEN historico_todos.categoria ...` (`lib/historicoTodos.js:124-126`). `montarPedidoGenericoShopee` (`lib/shopeeOrders.js:191+`) nunca define `categoria`, então nem a coleta incremental, nem a reverificação, nem o `api/backfill-shopee-todos.js` conseguem apagar um `coletado`. Só a rota `reabrir-pedido` faz isso, e de propósito. |
| 2 | Cálculo de prazo faz pedido antigo parecer vencido "hoje" | **Descartada como bug.** `prazo_entrega` é o `ship_by_date` oficial da Shopee (`lib/shopeeOrders.js:218-222`). O fallback `days_to_ship` só vale quando ele vem nulo, o que não acontece com pedido pago. A TV não reinterpreta esse valor. Que o prazo seja 06/out vem da Shopee ter reestimado o prazo, e o PR #205 já documenta isso. |
| 3 | `tv.html` junta o pedido de outra fonte | **Descartada.** O card "Shopee geral" vem só de `entrega_turbo:ultima_coleta_shopee_todos` (`api/collect.js:821`), que é a saída de `listarShopeeAguardando`. O pedido não é Turbo: o selo é SHOPEE e a consulta exclui `forma_entrega LIKE '%turbo%'`. |

### Detalhe que pode confundir

A 6ª rodada do CLAUDE.md diz que, neste pedido, era "o orosconnect mostrando dado
desatualizado/errado". Os fatos posteriores (Shopee mostrando "A Enviar" e a
reabertura do PR #202) indicam o contrário: o orosconnect estava certo e o nosso
`coletado` vinha de uma bipagem sem retirada real. Sugiro corrigir essa frase no
CLAUDE.md quando o caso físico for resolvido. Não alterei o arquivo porque não
houve mudança de código.

## URLs de diagnóstico para confirmar (Ricardo)

Troque `CRON_SECRET` pelo valor real.

1. **Linha crua no banco** (deve mostrar `categoria: null`, `coletado: 0`,
   `coletado_em: null`, `status_pedido: READY_TO_SHIP` ou `PROCESSED`, e
   `prazo_entrega` ≈ `2026-10-06T03:00:00.000Z`):
   ```
   https://ricapetadministrativo.vercel.app/api/debug?tipo=historico-todos-row&order_id=260930C2Q8M3XH&secret=CRON_SECRET
   ```
2. **Status atual na própria Shopee** (`order_status`; se ainda vier
   `READY_TO_SHIP`/`PROCESSED`, o pedido de fato não saiu. Esta rota não pede
   `ship_by_date`, então confira só o status):
   ```
   https://ricapetadministrativo.vercel.app/api/debug?tipo=shopee-order-detail&loja=ricapet&order_sn=260930C2Q8M3XH&secret=CRON_SECRET
   ```
3. **Alguma bipagem registrada para esse pedido** (até agora nenhuma tinha sido encontrada):
   ```
   https://ricapetadministrativo.vercel.app/api/debug?tipo=bipagem-por-order-id&order_id=260930C2Q8M3XH&secret=CRON_SECRET
   ```

Se a URL 1 mostrar `categoria: "coletado"` e mesmo assim o pedido estiver na TV,
a conclusão acima está errada e a investigação precisa ser reaberta. Pelo
código, isso não deveria acontecer, porque `listarShopeeAguardando` exclui
`coletado`.

## O que fazer com o pedido

O card some da TV sozinho quando acontecer uma destas coisas:

- **O pacote é retirado de verdade**: a Shopee muda para `SHIPPED`, e a
  reverificação (até 15 min) grava esse status, que sai do filtro
  `status_pedido IN ('READY_TO_SHIP','PROCESSED')`.
- **O pacote é bipado de novo no galpão**: `marcar-coletado.js` marca `coletado`
  (a condição `categoria IS NULL` vale outra vez, porque ele foi reaberto).
- **O pedido é cancelado na Shopee.**

Se o pacote já saiu fisicamente e só a Shopee está atrasada, basta bipar de novo
ou aguardar a Shopee atualizar. Nenhuma correção de código é necessária.
