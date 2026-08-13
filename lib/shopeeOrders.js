// lib/shopeeOrders.js
// Busca pedidos recentes da Shopee e identifica quais usam a modalidade
// "Entrega Turbo" (entrega em até 4h).
//
// Confirmado com dados reais: get_order_detail NÃO devolve logistics_channel_id
// (a tentativa antiga de bater esse campo contra logistics.get_channel_list
// sempre dava vazio — nunca funcionou de verdade). O campo que realmente
// identifica o canal é shipping_carrier, que devolve o nome direto (ex:
// "Turbo", "Shopee Xpress") — o mesmo campo que o histórico geral
// (montarPedidoGenericoShopee) já usava com sucesso.

const { shopeeGet } = require('./shopeeAuth');

const NOME_TURBO_ENVIO = 'turbo'; // comparado em minúsculas contra shipping_carrier

/**
 * Mapeia o order_status da Shopee pra categoria interna, no mesmo espírito
 * do que já fazemos pro Flex do ML (aguardando/coletado/entregue/cancelado).
 * Confirmado na doc oficial: UNPAID, INVOICE_PENDING, READY_TO_SHIP,
 * PROCESSED, SHIPPED, TO_CONFIRM_RECEIVE, COMPLETED, TO_RETURN, CANCELLED.
 */
function categoriaPedidoShopee(orderStatus) {
  if (orderStatus === 'COMPLETED') return 'entregue';
  if (orderStatus === 'SHIPPED' || orderStatus === 'TO_CONFIRM_RECEIVE') return 'coletado';
  if (orderStatus === 'CANCELLED') return 'cancelado';
  if (orderStatus === 'TO_RETURN') return 'nao_entregue';
  return 'aguardando'; // UNPAID, INVOICE_PENDING, READY_TO_SHIP, PROCESSED
}

/**
 * Monta o pedido Turbo no formato usado pelo rastreamento "ao vivo"
 * (lib/historicoTurboLive.js), com categoria/status persistíveis — ao
 * contrário da coleta antiga, que reconstruía tudo do zero a cada ciclo e
 * nunca sabia se um pedido Turbo já tinha sido resolvido.
 */
function montarPedidoTurboLive(loja, pedido) {
  const categoria = categoriaPedidoShopee(pedido.order_status);
  return {
    marketplace: 'shopee',
    conta: loja,
    order_id: pedido.order_sn,
    date_created: new Date(pedido.create_time * 1000).toISOString(),
    total_amount: pedido.total_amount,
    categoria,
    status_pedido: pedido.order_status || null,
    resolvido_em: categoria !== 'aguardando' && pedido.update_time
      ? new Date(pedido.update_time * 1000).toISOString()
      : null,
    // Entrega Turbo: até 4h após a aprovação do pagamento.
    deadline: new Date(pedido.create_time * 1000 + 4 * 60 * 60 * 1000).toISOString(),
    itens: (pedido.item_list || []).map((item) => ({
      titulo: item.item_name,
      quantidade: item.model_quantity_purchased,
      sku: item.model_sku || item.item_sku,
    })),
  };
}

async function buscarPedidosRecentes(loja, horasRetroativas = 6) {
  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - horasRetroativas * 60 * 60;

  const data = await shopeeGet(loja, '/api/v2/order/get_order_list', {
    time_range_field: 'create_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: 50,
  });

  return (data.response && data.response.order_list) || [];
}

async function buscarDetalhesPedidos(loja, orderSnList) {
  if (!orderSnList.length) return [];

  const data = await shopeeGet(loja, '/api/v2/order/get_order_detail', {
    order_sn_list: orderSnList.join(','),
    response_optional_fields: 'item_list,total_amount,shipping_carrier',
  });

  return (data.response && data.response.order_list) || [];
}

/**
 * Retorna a lista de pedidos recentes da loja que usam Entrega Turbo, já no
 * formato do rastreamento "ao vivo" (com categoria/status).
 */
async function coletarPedidosTurbo(loja, horasRetroativas = 6) {
  const pedidosResumo = await buscarPedidosRecentes(loja, horasRetroativas);
  const orderSnList = pedidosResumo.map((p) => p.order_sn);
  const detalhes = await buscarDetalhesPedidos(loja, orderSnList);

  const pedidosTurbo = detalhes.filter(
    (pedido) => (pedido.shipping_carrier || '').trim().toLowerCase() === NOME_TURBO_ENVIO
  );

  return pedidosTurbo.map((pedido) => montarPedidoTurboLive(loja, pedido));
}

/**
 * Reverifica um único pedido Turbo já conhecido (guardado no histórico "ao
 * vivo"), buscando o status atual — mesmo espírito do
 * reverificarStatusPedido do Flex do ML. Retorna null se o pedido não for
 * encontrado (ex: muito antigo, saiu do alcance da API).
 */
async function reverificarPedidoTurbo(loja, orderSn) {
  const detalhes = await buscarDetalhesPedidos(loja, [orderSn]);
  const pedido = detalhes[0];
  if (!pedido) return null;
  return montarPedidoTurboLive(loja, pedido);
}

/**
 * Busca uma PÁGINA de pedidos dentro de um período (desde/até), usando
 * cursor (a Shopee pagina por cursor opaco, não por offset numérico como o
 * Mercado Livre) — usado pelo backfill incremental do histórico geral
 * ("Todos os pedidos"), que processa aos poucos entre execuções do cron.
 */
async function buscarPedidosPeriodo(loja, timeFromEpoch, timeToEpoch, cursor, pageSize = 50) {
  const params = {
    time_range_field: 'create_time',
    time_from: timeFromEpoch,
    time_to: timeToEpoch,
    page_size: pageSize,
  };
  if (cursor) params.cursor = cursor;

  const data = await shopeeGet(loja, '/api/v2/order/get_order_list', params);
  const resposta = data.response || {};
  return {
    results: resposta.order_list || [],
    more: !!resposta.more,
    nextCursor: resposta.next_cursor || null,
  };
}

/**
 * Busca detalhes completos dos pedidos, incluindo endereço do destinatário
 * (para os gráficos de estado/cidade) e a transportadora/canal de entrega
 * (para o gráfico "Por forma de entrega") — usado no histórico geral, que
 * cobre QUALQUER forma de entrega, não só Turbo.
 */
async function buscarDetalhesCompletos(loja, orderSnList) {
  if (!orderSnList.length) return [];

  const data = await shopeeGet(loja, '/api/v2/order/get_order_detail', {
    order_sn_list: orderSnList.join(','),
    response_optional_fields: 'item_list,total_amount,shipping_carrier,recipient_address',
  });

  return (data.response && data.response.order_list) || [];
}

/**
 * Monta o pedido no mesmo formato genérico usado pelo Mercado Livre em
 * lib/mlAllOrders.js, para os dois marketplaces poderem conviver no mesmo
 * histórico unificado (lib/historicoTodos.js).
 */
function montarPedidoGenericoShopee(loja, pedido) {
  const endereco = pedido.recipient_address || {};
  return {
    marketplace: 'shopee',
    conta: loja,
    order_id: pedido.order_sn,
    date_created: new Date(pedido.create_time * 1000).toISOString(),
    total_amount: pedido.total_amount,
    // Shopee já devolve o nome da transportadora/canal diretamente — não
    // precisa do lookup de channel_id que a coleta específica de Turbo usa.
    forma_entrega: pedido.shipping_carrier || 'Não identificado',
    estado: endereco.state || null,
    cidade: endereco.city || null,
    // Confirmado na doc oficial da Shopee: só "CANCELLED" é cancelamento de
    // fato — "IN_CANCEL" é cancelamento em andamento (ainda não efetivado),
    // por isso não conta aqui.
    status_pedido: pedido.order_status || null,
    cancelado: pedido.order_status === 'CANCELLED',
    itens: (pedido.item_list || []).map((item) => ({
      titulo: item.item_name,
      quantidade: item.model_quantity_purchased,
      sku: item.model_sku || item.item_sku,
    })),
  };
}

module.exports = {
  coletarPedidosTurbo,
  reverificarPedidoTurbo,
  buscarPedidosPeriodo,
  buscarDetalhesCompletos,
  montarPedidoGenericoShopee,
};
