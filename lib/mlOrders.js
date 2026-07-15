// lib/mlOrders.js
// Busca pedidos recentes do Mercado Livre e identifica quais são "entrega
// rápida" — hoje, isso significa Mercado Envios FLEX (logistic_type ===
// 'self_service'), que é a única modalidade real de entrega rápida que
// existe nas suas contas no momento. Confirmado com um relatório de vendas
// real exportado do ML: as únicas "Formas de entrega" existentes são
// "Mercado Envios Full", "Mercado Envios Flex" e "Correios e pontos de
// envio" — não existe nenhuma categoria "Turbo" no Mercado Livre.
//
// (O critério anterior, baseado no lead_time prometido (<=4h), foi
// abandonado: não corresponde a nenhuma categoria real de entrega e
// misturava pedidos Full/Correios que não deveriam contar como expressos.)
//
// Quando a Shopee "Entrega Turbo" estiver aprovada e funcionando, ela
// continua sendo tratada separadamente em lib/shopeeOrders.js — este
// arquivo cobre apenas o Mercado Livre.

const { getMLAccessToken } = require('./mlAuth');

const SELLER_IDS = {
  ricapet: '736787693',
  thapets: '1139210125',
};

// Prazo padrão assumido para a coleta/entrega Flex, usado apenas para
// calcular o "deadline" mostrado no painel (contagem regressiva).
// ⚠️ TODO: ajustar conforme a janela de coleta real observada na operação.
const HORAS_PADRAO_FLEX = 4;

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
 * Busca o shipment completo (logistic_type + endereço do destinatário).
 * Uma única chamada cobre os dois usos: identificar Flex e capturar
 * estado/cidade para os gráficos de região.
 */
async function buscarDetalhesShipment(conta, shipmentId) {
  if (!shipmentId) return { logisticType: null, estado: null, cidade: null };
  try {
    const accessToken = await getMLAccessToken(conta);
    const shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);
    const endereco = shipment.receiver_address || {};
    return {
      logisticType: shipment.logistic_type || null,
      estado: (endereco.state && (endereco.state.name || endereco.state.id)) || null,
      cidade: (endereco.city && endereco.city.name) || null,
    };
  } catch (err) {
    return { logisticType: null, estado: null, cidade: null };
  }
}

/**
 * Retorna a lista de pedidos recentes que são Mercado Envios Flex,
 * já enriquecidos com estado/cidade do destinatário.
 */
async function coletarPedidosExpressos(conta, horasRetroativas = 6) {
  const pedidos = await buscarPedidosRecentes(conta, horasRetroativas);
  const resultado = [];

  for (const pedido of pedidos) {
    const shipmentId = pedido.shipping && pedido.shipping.id;
    const detalhes = await buscarDetalhesShipment(conta, shipmentId);

    // Critério: só conta como "expressa" se for Mercado Envios Flex.
    if (detalhes.logisticType !== 'self_service') continue;

    resultado.push({
      marketplace: 'mercado_livre',
      conta,
      order_id: pedido.id,
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      shipment_id: shipmentId,
      horas_prometidas: HORAS_PADRAO_FLEX,
      logistic_type: detalhes.logisticType,
      estado: detalhes.estado,
      cidade: detalhes.cidade,
      itens: (pedido.order_items || []).map((oi) => ({
        titulo: oi.item.title,
        quantidade: oi.quantity,
        sku: oi.item.seller_sku,
      })),
    });
  }

  return resultado;
}

module.exports = { coletarPedidosExpressos, SELLER_IDS };
