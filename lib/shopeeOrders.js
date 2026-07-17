// lib/shopeeOrders.js
// Busca pedidos recentes da Shopee e identifica quais usam a modalidade
// "Entrega Turbo" (entrega em até 4h).
//
// ATENÇÃO / TODO: o campo exato que identifica o canal "Entrega Turbo" no
// order.get_order_detail ainda não foi confirmado com dados reais da sua loja.
// A abordagem abaixo:
//   1. Chama logistics.get_channel_list uma vez (cacheada 24h no Redis) para
//      descobrir o logistics_channel_id cujo nome contenha "Turbo".
//   2. Compara esse channel_id com o campo retornado em cada pedido.
// Assim que você rodar isso a primeira vez, me mostre o resultado de
// get_channel_list (sem tokens) pra eu confirmar/ajustar o nome buscado
// e o nome exato do campo em get_order_detail.

const { shopeeGet } = require('./shopeeAuth');
const { getRedis } = require('./redis');

const NOME_CANAL_BUSCADO = /turbo/i;

async function descobrirChannelIdTurbo(loja) {
  const redis = getRedis();
  const cacheKey = `shopee_turbo_channel:${loja}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const data = await shopeeGet(loja, '/api/v2/logistics/get_channel_list');
  const canais = (data.response && data.response.logistics_channel_list) || [];

  const canalTurbo = canais.find(
    (c) => NOME_CANAL_BUSCADO.test(c.logistics_channel_name || '')
  );

  if (!canalTurbo) {
    console.warn(
      `[shopeeOrders] Nenhum canal com nome contendo "Turbo" encontrado para a loja ${loja}. ` +
      `Canais disponíveis: ${canais.map((c) => c.logistics_channel_name).join(', ')}`
    );
    return null;
  }

  // Cacheia por 24h — canais raramente mudam
  await redis.set(cacheKey, canalTurbo.logistics_channel_id, { ex: 60 * 60 * 24 });

  return canalTurbo.logistics_channel_id;
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
 * Retorna a lista de pedidos recentes da loja que usam Entrega Turbo.
 */
async function coletarPedidosTurbo(loja, horasRetroativas = 6) {
  const channelIdTurbo = await descobrirChannelIdTurbo(loja);
  if (!channelIdTurbo) return [];

  const pedidosResumo = await buscarPedidosRecentes(loja, horasRetroativas);
  const orderSnList = pedidosResumo.map((p) => p.order_sn);
  const detalhes = await buscarDetalhesPedidos(loja, orderSnList);

  // TODO: confirmar se o campo correto é `logistics_channel_id` direto no
  // pedido, ou se vem aninhado (ex: dentro de um objeto de shipping).
  // Ajustar a linha abaixo assim que confirmarmos com um pedido real.
  const pedidosTurbo = detalhes.filter(
    (pedido) => pedido.logistics_channel_id === channelIdTurbo
  );

  return pedidosTurbo.map((pedido) => ({
    marketplace: 'shopee',
    loja,
    order_id: pedido.order_sn,
    date_created: new Date(pedido.create_time * 1000).toISOString(),
    total_amount: pedido.total_amount,
    horas_prometidas: 4, // Entrega Turbo: até 4h após aprovação do pagamento
    itens: (pedido.item_list || []).map((item) => ({
      titulo: item.item_name,
      quantidade: item.model_quantity_purchased,
      sku: item.model_sku || item.item_sku,
    })),
  }));
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
    // ⚠️ TODO: validar contra um pedido cancelado real se o valor exato é
    // "CANCELLED" (documentado assim na API v2) ou se existe variação —
    // "IN_CANCEL" também aparece na doc como "cancelamento em andamento",
    // hoje NÃO contado como cancelado (só CANCELLED conta).
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
  descobrirChannelIdTurbo,
  buscarPedidosPeriodo,
  buscarDetalhesCompletos,
  montarPedidoGenericoShopee,
};
