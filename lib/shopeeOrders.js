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

module.exports = { coletarPedidosTurbo, descobrirChannelIdTurbo };
