# Exceções e diagnóstico

## Exceções conhecidas e como o sistema trata

| Situação | Tratamento atual |
|---|---|
| Pedido cancelado **depois** de coletado (ex.: mediação do comprador no dia seguinte) | ML geral: reverificação busca o **pedido** primeiro; `status === 'cancelled'` → `cancelado = 1`. Flex: `cancelled` vira `cancelado` (pode sair de `coletado` para `cancelado` — é permitido; só a volta para `aguardando` é bloqueada). |
| ML diz `ready_to_ship` mas o pacote já saiu | decidido pelo `status_substatus` (`STATUS_SUBSTATUS_JA_DESPACHADO`). Substatus novo não mapeado continua aparecendo como aguardando (lado seguro). |
| Pedido sem `shipment_id` | não entra na reverificação (a API do ML exige o id do shipment). Remédio: `?tipo=ml-recuperar-sem-shipment-id` (grava; só o Ricardo roda). |
| `shipment_id` gravado como `"123.0"` | 404 na API; já corrigido na origem (`String(...)`). Limpeza: `?tipo=corrigir-shipment-id` (grava). |
| Falha de API durante a reverificação | mantém o status anterior (`detalhes.status || pedido.status_envio`); nunca apagar status bom. |
| Falha de API durante a **descoberta** | `processarEmLotes` devolve `falhas`, registradas em `erros` (`flex_novos:<conta>:<id>`, `historico_todos_novos:<conta>:<id>`). O checkpoint avança mesmo assim → o pedido pode ficar fora do banco até um backfill. |
| Pedido aguardando há mais de 15 dias | some da TV e da reverificação (`IDADE_MAXIMA_AGUARDANDO_MS`). Corrigir status de um específico = backfill manual. |
| Bipado mas ainda na TV | `marcar-coletado` atualiza na hora; se continua, conferir se o identificador bipado bate (`shipment_id` no ML, `order_sn` na Shopee) e qual tabela alimenta o card. |
| Devolução × reclamação (ML) | `claimEhDevolucao`: `type === 'returns'` **ou** ação `return_review_*`. Claim que vira devolução zera os campos de reclamação. Shopee só tem devolução. |
| Número da TV diferente do painel nativo do ML/Shopee | quase sempre critério: conta separada, aba "hoje" × "qualquer dia pendente", cancelados contados pelo ML. Ver 10ª rodada no `CLAUDE.md`. Diferença grande (não 1-3 pedidos) = suspeitar de bug. |

## Roteiro: "pedido X sumiu da TV" / "número não bate"

1. Qual **tipo** e **conta**? (Flex, Turbo, geral; Ricapet ou Thapets.)
2. O pedido **está no banco**? `?tipo=historico-todos-row` (geral),
   `?tipo=flex-status` (Flex), `?tipo=turbo-live-status` (Turbo).
   - Não está → problema de **descoberta** (falha de API, janela) →
     sugerir backfill da janela (o Ricardo roda).
   - Está → seguir.
3. O que o **marketplace diz agora**? `?tipo=ml-shipment`,
   `?tipo=ml-order-raw`, `?tipo=shopee-order-detail` (leitura ao vivo).
4. Comparar com o **filtro de exibição** (`tipos-e-status.md` §4): status,
   substatus, cancelado, categoria, Full/Flex/Turbo, teto de 15 dias.
5. Para visão geral: `?tipo=aguardando-resumo` (contagem por conta, faixa
   de idade, substatus) e `?tipo=ml-aguardando-substatus`.
6. Concluir: bug de código, critério diferente do painel nativo, ou dado a
   corrigir por rota de escrita. Relatar com evidência; regra nova → pergunta.

Esses diagnósticos chamam a API do marketplace — use com parcimônia
(cota do proxy Fixie na Shopee) e nunca em loop.

## Rotas de `api/debug.js` ligadas à expedição

Todas exigem `CRON_SECRET` (exceto quando indicado). O secret é do Ricardo:
nunca escreva o valor em código, PR, issue ou chat.

**Só leitura** (podem ser sugeridas para investigação):
`aguardando-resumo`, `ml-aguardando-substatus`, `historico-todos-row`,
`flex-status`, `turbo-live-status`, `ml-shipment`, `ml-order-raw`,
`ml-sla`, `ml-claims`, `ml-claims-resumo`, `bipagem-por-order-id`,
`bipagem-do-dia`, `bipagem-cruzamento-teste`, `atraso-semana`,
`shopee-returns`, `shopee-channels`, `shopee-orders-recentes`,
`shopee-order-detail`, `omie-pedido-teste`, `ml-id-teste`.

**Gravam dados** (agente nunca chama; só descreve o comando para o Ricardo):
`ml-recuperar-sem-shipment-id`, `reabrir-pedido`, `corrigir-shipment-id`,
`backfill-prazo-shopee-todos`, `registrar-bipagem-diaria`,
`apagar-bipagem-diaria-teste`, `adicionar-coluna-tipo`, `criar-tabelas`,
`migrar-redis-turso`, `shopee-todos-status&resetar=1`,
`bipagem-resolver-pendentes` (sessão de admin), e os backfills
`api/backfill-flex-api.js`, `api/backfill-todos-api.js`,
`api/backfill-shopee-todos.js` (`?conta&dias&dia&offset`).

⚠️ Antes de sugerir `backfill-todos-api.js`, leia
`inconsistencias.md` (item sobre cancelados).
