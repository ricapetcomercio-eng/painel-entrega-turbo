// lib/mlOrders.js
// Busca pedidos recentes do Mercado Livre e identifica quais têm promessa
// de entrega em poucas horas (ex: "Entrega no mesmo dia" / Full expresso).
//
// Critério de identificação (ver conversa/documentação ML):
//   GET /shipments/{shipment_id}/lead_time retorna estimated_delivery_time
//   com "unit": "hour" e "shipping" = número de horas prometidas.
//   Consideramos "entrega expressa" quando unit === 'hour' e shipping <= LIMITE_HORAS.

const { getMLAccessToken } = require('./mlAuth');

const LIMITE_HORAS_EXPRESSA = 4; // ajustável; ML "poucas horas" costuma ser 3-4h

const SELLER_IDS = {
  ricapet: '736787693',
  thapets: '1139210125',
};

async function mlFetch(path, accessToken, opts = {}) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(opts.headers || {}),
    },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro ML ${path} (${resp.status}): ${errText}`);
  }
  return resp.json();
}

/**
 * Busca pedidos recentes (últimas N horas) de uma conta ML.
 */
async function buscarPedidosRecentes(conta, horasRetroativas = 6) {
  const accessToken = await getMLAccessToken(conta);
  const sellerId = SELLER_IDS[conta];

  const desde = new Date(Date.now() - horasRetroativas * 60 * 60 * 1000).toISOString();

  const data = await mlFetch(
    `/orders/search?seller=${sellerId}&order.date_created.from=${encodeURIComponent(desde)}`,
    accessToken
  );

  return data.results || [];
}

/**
 * Para um pedido, consulta o lead_time do shipment e retorna se é entrega expressa.
 */
async function verificarEntregaExpressa(conta, shipmentId) {
  if (!shipmentId) return { expressa: false };

  const accessToken = await getMLAccessToken(conta);

  let leadTime;
  try {
    leadTime = await mlFetch(`/shipments/${shipmentId}/lead_time`, accessToken);
  } catch (err) {
    // Nem todo shipment tem lead_time disponível (ex: ainda não processado)
    return { expressa: false, erro: err.message };
  }

  const est = leadTime.estimated_delivery_time;
  if (!est) return { expressa: false };

  const expressa = est.unit === 'hour' && typeof est.shipping === 'number' && est.shipping <= LIMITE_HORAS_EXPRESSA;

  return {
    expressa,
    horasPrometidas: est.unit === 'hour' ? est.shipping : null,
    unidadeOriginal: est.unit,
  };
}

/**
 * Retorna a lista de pedidos recentes já enriquecidos com a flag de entrega expressa.
 */
async function coletarPedidosExpressos(conta, horasRetroativas = 6) {
  const pedidos = await buscarPedidosRecentes(conta, horasRetroativas);
  const resultado = [];

  for (const pedido of pedidos) {
    const shipmentId = pedido.shipping && pedido.shipping.id;
    const info = await verificarEntregaExpressa(conta, shipmentId);

    if (info.expressa) {
      resultado.push({
        marketplace: 'mercado_livre',
        conta,
        order_id: pedido.id,
        date_created: pedido.date_created,
        total_amount: pedido.total_amount,
        shipment_id: shipmentId,
        horas_prometidas: info.horasPrometidas,
        itens: (pedido.order_items || []).map((oi) => ({
          titulo: oi.item.title,
          quantidade: oi.quantity,
          sku: oi.item.seller_sku,
        })),
      });
    }
  }

  return resultado;
}

module.exports = { coletarPedidosExpressos, verificarEntregaExpressa, SELLER_IDS };
