// lib/mlFlexOrders.js
// Rastreia pedidos com entrega via MERCADO ENVIOS FLEX (logistic_type === 'self_service'):
// nesse modo, o próprio vendedor (ou entregador dele) precisa coletar o pedido dentro de
// uma janela agendada e confirmar a coleta no app do Mercado Livre.
//
// Esse módulo identifica esses pedidos e informa se já foram "coletados" (o envio avançou
// para o status 'shipped'/'delivered') ou se ainda estão aguardando coleta.
//
// ⚠️ TODO: validar contra pedidos Flex reais os nomes exatos de campo abaixo, em especial:
//   - shipment.logistic_type (esperado: 'self_service' para Flex)
//   - shipment.status (esperado: 'pending'/'handling' antes da coleta, 'shipped' após)
// Rodar uma vez com pedidos reais e ajustar aqui se necessário (mesma prática já usada
// para validar o campo do canal "Turbo" na Shopee — ver README).

const { getMLAccessToken } = require('./mlAuth');
const { SELLER_IDS } = require('./mlOrders');

// Tempo (minutos) desde a venda a partir do qual, se ainda não coletado, consideramos
// "atenção"/"crítico". Ajustável conforme observação real da operação Flex.
const MINUTOS_ATENCAO = 60;
const MINUTOS_CRITICO = 120;

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

async function buscarPedidosRecentes(conta, horasRetroativas) {
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
 * Consulta o shipment e retorna info de Flex, ou null se o pedido não for Flex.
 */
async function verificarFlex(conta, shipmentId) {
  if (!shipmentId) return null;
  const accessToken = await getMLAccessToken(conta);

  let shipment;
  try {
    shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);
  } catch (err) {
    return null;
  }

  const isFlex = shipment.logistic_type === 'self_service';
  if (!isFlex) return null;

  const coletado = ['shipped', 'delivered'].includes(shipment.status);

  return {
    coletado,
    status: shipment.status,
    substatus: shipment.substatus || null,
  };
}

/**
 * Retorna pedidos Flex recentes, já com o estado de urgência calculado
 * (com base no tempo desde a venda, já que a coleta é enquanto não confirmada).
 */
async function coletarPedidosFlex(conta, horasRetroativas = 6) {
  const pedidos = await buscarPedidosRecentes(conta, horasRetroativas);
  const resultado = [];

  for (const pedido of pedidos) {
    const shipmentId = pedido.shipping && pedido.shipping.id;
    const info = await verificarFlex(conta, shipmentId);
    if (!info) continue; // não é Flex, ignora

    const minutosDesdeVenda = (Date.now() - new Date(pedido.date_created).getTime()) / 60000;

    let estado = 'ok';
    if (!info.coletado) {
      if (minutosDesdeVenda >= MINUTOS_CRITICO) estado = 'critico';
      else if (minutosDesdeVenda >= MINUTOS_ATENCAO) estado = 'atencao';
    }

    resultado.push({
      marketplace: 'mercado_livre',
      conta,
      order_id: pedido.id,
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      shipment_id: shipmentId,
      coletado: info.coletado,
      status_envio: info.status,
      estado, // 'ok' | 'atencao' | 'critico' (só relevante se ainda não coletado)
      itens: (pedido.order_items || []).map((oi) => ({
        titulo: oi.item.title,
        quantidade: oi.quantity,
        sku: oi.item.seller_sku,
      })),
    });
  }

  // Mais recentes e não coletados primeiro (o que precisa de atenção primeiro)
  resultado.sort((a, b) => {
    if (a.coletado !== b.coletado) return a.coletado ? 1 : -1;
    return new Date(a.date_created) - new Date(b.date_created);
  });

  return resultado;
}

module.exports = { coletarPedidosFlex };
