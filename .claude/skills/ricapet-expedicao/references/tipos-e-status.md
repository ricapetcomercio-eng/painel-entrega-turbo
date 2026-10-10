# Tipos de pedido, prazos e status

Valores conferidos no código em out/2026. Antes de confiar num número, rode
`scripts/conferir_constantes.py`.

## 1. Tipos de pedido

| Tipo (badge na TV) | Como o código reconhece | Tabela | Prazo usado |
|---|---|---|---|
| **FLEX** (ML) | `shipment.logistic_type === 'self_service'` sem tag `turbo` (`lib/mlFlexOrders.js`) | `historico_flex` | SLA do ML (`/shipments/{id}/sla`); sem SLA: 21h de Brasília do dia (ou do dia seguinte se criado depois das 21h) — `HORA_LIMITE_ENTREGA = 21` |
| **TURBO** (ML) | `self_service` + tag `turbo` | `historico_flex` (`tipo: 'turbo'`) | criação + `HORAS_TURBO = 3` h |
| **AGORA** (ML) | `logistic_type === 'cross_docking'` + tag `proximity` | `historico_flex` (`tipo: 'agora'`) | criação + `MINUTOS_ENVIOS_AGORA = 25` min |
| **TURBO** (Shopee "Entrega Turbo") | `shipping_carrier` em minúsculas `=== 'turbo'` (`NOME_TURBO_ENVIO`, `lib/shopeeOrders.js`) | `historico_turbo_live` (ao vivo) + `historico_turbo` (log permanente) | `create_time` + 4h |
| **🛍️ SHOPEE** (geral) | qualquer pedido Shopee que não seja Full nem Turbo | `historico_todos` | `ship_by_date` (ou `create_time + days_to_ship`); sem prazo: sintético na TV |
| **📦 ML** (geral) | qualquer pedido ML que não seja Full nem Flex | `historico_todos` | `estimated_delivery_limit`/`_final`; sem prazo: sintético na TV |
| **Full / fulfillment** | ML: `forma_entrega LIKE '%full%'`; Shopee: `forma_entrega = 'full'` | `historico_todos` | não aparece na TV nem conta em cobertura — o estoque está no CD do marketplace |

`forma_entrega` (ML) vem de `LOGISTIC_LABELS` (`lib/mlAllOrders.js`):
`self_service` → "Mercado Envios Flex", `fulfillment` → "Mercado Envios
Full", `drop_off`/`xd_drop_off` → "Correios e pontos de envio",
`cross_docking` → "Agência (cross docking)".

Contas: ML `ricapet` e `thapets` (`SELLER_IDS`, `lib/mlOrders.js`); Shopee
uma loja por conta. Sempre pense "qual conta?" ao comparar números.

## 2. Coleta (quem traz o pedido para o banco)

`/api/collect` é chamado a cada 1 min pelo cron-job.org (6h-18h, seg-sáb),
mas cada bloco só trabalha no seu intervalo:

| Bloco | Constante | Valor |
|---|---|---|
| Gate geral + Flex (descoberta e reverificação) | `INTERVALO_MINIMO_MS` | 5 min |
| "Todos os pedidos" ML (+ reverificação do ML geral) | `INTERVALO_MINIMO_TODOS_ML_MS` | 5 min |
| Shopee (Turbo + todos + reverificação) | `INTERVALO_MINIMO_SHOPEE_MS` | 15 min (cota do proxy Fixie) |
| Devoluções/reclamações | `INTERVALO_MINIMO_DEVOLUCOES_MS` | 30 min |
| Atraso dos últimos 7 dias | `INTERVALO_MINIMO_ATRASO_SEMANA_MS` | 30 min |

Descoberta é **incremental e só anda para frente** (checkpoint por conta
em `kv_simples`). Por isso todo bloco tem uma **reverificação** que
revisita pedidos ainda pendentes para atualizar status. Cada reverificação
tem orçamento de 3-4 s e roda em lotes (`CONCORRENCIA = 4`).

Mudar qualquer intervalo é decisão do dono (custo de CPU × atraso na TV).

## 3. Valores de `categoria`

`aguardando`, `coletado`, `entregue`, `nao_entregue`, `cancelado`.

**Flex / Turbo ML / Agora** — a partir de `shipment.status`:
`delivered` → entregue · `shipped` → coletado · `not_delivered` →
nao_entregue · `cancelled` → cancelado · qualquer outro → aguardando.

**Turbo Shopee** (`categoriaPedidoShopee`): `COMPLETED` → entregue ·
`SHIPPED`/`TO_CONFIRM_RECEIVE` → coletado · `CANCELLED` → cancelado ·
`TO_RETURN` → nao_entregue · `UNPAID`/`INVOICE_PENDING`/`READY_TO_SHIP`/
`PROCESSED` → aguardando.

**`historico_todos` (Shopee/ML geral):** `categoria` normalmente fica NULL;
só é preenchida pela bipagem (`coletado`) ou, no ML, para pedidos Flex.
Cancelamento é a coluna separada `cancelado` (0/1). Na Shopee, `IN_CANCEL`
**não** conta como cancelado.

**Quem muda o status:**
1. Reverificação pela API no cron (minutos depois).
2. Bipagem no galpão (`/api/marcar-coletado`) → `coletado` na hora.

**Nunca volta atrás:** `historico_flex` e `historico_turbo_live` não
regridem de resolvido para `aguardando`; `historico_todos` preserva
`categoria`/`coletado`/`shipment_id` quando o valor novo vem vazio. Mantenha
essas proteções em qualquer mudança de gravação.

O backend do Flex também calcula `estado` (`ok`/`atencao`/`critico` por
fração do prazo), mas a TV **não** usa — usa zonas (ver `paineis.md`).

## 4. O que conta como "aguardando despacho"

**Shopee geral** (`listarShopeeAguardando`, `lib/historicoTodos.js`):
- `status_pedido IN ('READY_TO_SHIP','PROCESSED')` — `PROCESSED` = etiqueta
  impressa, ainda no galpão (equivale à aba "Envios Processados" da Shopee);
- `cancelado = 0`; `categoria` NULL ou fora de coletado/entregue/cancelado;
- sem Full e sem `%turbo%` (Turbo já tem card próprio — evita duplicar).

**ML geral** (`listarMlAguardando`):
- `status_envio IN ('pending','handling','ready_to_ship')`;
- `status_substatus` NULL ou fora de `STATUS_SUBSTATUS_JA_DESPACHADO =
  ['in_packing_list','in_hub','authorized_by_carrier']` — o ML deixa o
  status em `ready_to_ship` mesmo depois de despachado; só o substatus
  revela. Substatus confirmados como "ainda no galpão": `printed`,
  `invoice_pending`, `buffered`. Lista de bloqueio **conservadora**: só
  entra valor confirmado com pedido real (ver `CLAUDE.md`, 4ª rodada);
- sem `%full%` e sem `%flex%`; mesmas regras de `categoria`/`cancelado`.

**Teto de idade** (as duas acima e a reverificação da Shopee):
`IDADE_MAXIMA_AGUARDANDO_MS` = 15 dias. Pedido mais velho que isso some da
TV **e** da reverificação (evita "zumbis" de centenas de dias). Dentro do
teto, pedido não resolvido aparece independentemente da idade.

**Flex / Turbo ao vivo:** `listarRecentes` (`lib/historicoFlex.js`) mostra
os criados nas últimas 48h **ou** qualquer `aguardando` com `shipment_id`,
sem teto de idade. `listarRecentesTurbo` é igual, sem exigir `shipment_id`.
