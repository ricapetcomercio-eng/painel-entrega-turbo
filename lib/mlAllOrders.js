// lib/mlAllOrders.js
// Busca TODOS os pedidos do Mercado Livre (sem filtrar por forma de
// entrega) — usado pela aba "Todos os pedidos" do painel, que tem seu
// próprio filtro de Forma de entrega na tela (em vez do critério de
// "expressa"/Flex já fixado em lib/mlOrders.js e lib/mlFlexOrders.js).

const { getMLAccessToken } = require('./mlAuth');
const { SELLER_IDS } = require('./mlOrders');

// Tradução do campo técnico logistic_type para o nome que aparece pra
// você no Mercado Livre (confirmado com o relatório de vendas real).
const LOGISTIC_LABELS = {
  self_service: 'Mercado Envios Flex',
  fulfillment: 'Mercado Envios Full',
  drop_off: 'Correios e pontos de envio',
  xd_drop_off: 'Correios e pontos de envio',
  cross_docking: 'Agência (cross docking)',
};

function traduzirLogisticType(logisticType) {
  return LOGISTIC_LABELS[logisticType] || logisticType || 'Não identificado';
}

async function mlFetch(path, accessToken) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro ML ${path} (${resp.status}): ${errText}`);
  }
  return resp.json();
}

/**
 * Busca uma PÁGINA de pedidos dentro de um período (desde/até), usando
 * offset/limit — para processar aos poucos sem estourar tempo de execução.
 */
async function buscarPedidosPeriodo(conta, desdeISO, ateISO, offset, limit) {
  const accessToken = await getMLAccessToken(conta);
  const sellerId = SELLER_IDS[conta];

  const data = await mlFetch(
    `/orders/search?seller=${sellerId}` +
      `&order.date_created.from=${encodeURIComponent(desdeISO)}` +
      `&order.date_created.to=${encodeURIComponent(ateISO)}` +
      `&offset=${offset}&limit=${limit}&sort=date_desc`,
    accessToken
  );
  return {
    results: data.results || [],
    total: (data.paging && data.paging.total) || 0,
  };
}

/**
 * Busca o shipment completo (logistic_type, status, endereço).
 */
async function buscarDetalhesShipment(conta, shipmentId) {
  if (!shipmentId) return { logisticType: null, status: null, estado: null, cidade: null };
  try {
    const accessToken = await getMLAccessToken(conta);
    const shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);
    const endereco = shipment.receiver_address || {};
    return {
      logisticType: shipment.logistic_type || null,
      status: shipment.status || null,
      estado: (endereco.state && (endereco.state.name || endereco.state.id)) || null,
      cidade: (endereco.city && endereco.city.name) || null,
    };
  } catch (err) {
    return { logisticType: null, status: null, estado: null, cidade: null };
  }
}

/**
 * Monta o objeto padrão de pedido, com a forma de entrega já traduzida
 * para o nome amigável (usado no filtro da tela).
 */
function montarPedidoGenerico(conta, pedido, shipmentId, detalhes) {
  return {
    marketplace: 'mercado_livre',
    conta,
    order_id: pedido.id,
    date_created: pedido.date_created,
    total_amount: pedido.total_amount,
    shipment_id: shipmentId,
    forma_entrega: traduzirLogisticType(detalhes.logisticType),
    logistic_type: detalhes.logisticType,
    status_envio: detalhes.status,
    estado: detalhes.estado,
    cidade: detalhes.cidade,
    itens: (pedido.order_items || []).map((oi) => ({
      titulo: oi.item.title,
      quantidade: oi.quantity,
      sku: oi.item.seller_sku,
    })),
  };
}

module.exports = { buscarPedidosPeriodo, buscarDetalhesShipment, montarPedidoGenerico, traduzirLogisticType };
