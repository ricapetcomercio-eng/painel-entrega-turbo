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

// Prazo assumido para a coleta acontecer (venda -> entregador buscar o
// pacote). Baseado no padrão observado ("você deve dar o pacote ao seu
// transportador amanhã"), ou seja, ~24h é uma referência razoável.
// ⚠️ TODO: ajustar conforme o prazo real observado na operação.
const PRAZO_COLETA_HORAS = 24;

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
 * Busca uma PÁGINA de pedidos dentro de um período (desde/até), usando
 * offset/limit — usado pelo backfill via API, que processa aos poucos
 * (para não estourar o tempo de execução da function na Vercel).
 * Retorna também o `paging.total` para o chamador saber quando parar.
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
 * Busca o histórico de status do shipment (com timestamps reais de cada
 * mudança), usado para calcular quanto tempo levou até a coleta e até a
 * entrega. Só chamado para pedidos que já saíram de "aguardando", pra não
 * gastar chamada de API à toa em pedidos ainda parados.
 *
 * ⚠️ TODO: validar contra um pedido real o formato exato da resposta desse
 * endpoint (nomes dos campos de status/data podem variar). Ajustar os
 * nomes abaixo (`status`, `date`) conforme o que a API realmente devolver.
 */
async function buscarHistoricoShipment(conta, shipmentId) {
  if (!shipmentId) return { coletado_em: null, entregue_em: null };
  try {
    const accessToken = await getMLAccessToken(conta);
    const historico = await mlFetch(`/shipments/${shipmentId}/history`, accessToken);
    const eventos = Array.isArray(historico) ? historico : (historico.history || []);

    const eventoColeta = eventos.find((e) => e.status === 'shipped');
    const eventoEntrega = eventos.find((e) => e.status === 'delivered');

    return {
      coletado_em: (eventoColeta && (eventoColeta.date || eventoColeta.date_shipped)) || null,
      entregue_em: (eventoEntrega && (eventoEntrega.date || eventoEntrega.date_delivered)) || null,
    };
  } catch (err) {
    return { coletado_em: null, entregue_em: null };
  }
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

  let categoria = 'aguardando';
  if (shipment.status === 'delivered') categoria = 'entregue';
  else if (shipment.status === 'shipped') categoria = 'coletado';

  let coletado_em = null;
  let entregue_em = null;
  if (categoria !== 'aguardando') {
    const historico = await buscarHistoricoShipment(conta, shipmentId);
    coletado_em = historico.coletado_em;
    entregue_em = historico.entregue_em;
  }

  return {
    coletado: categoria !== 'aguardando',
    categoria, // 'aguardando' | 'coletado' (não entregue) | 'entregue'
    status: shipment.status,
    substatus: shipment.substatus || null,
    coletado_em,
    entregue_em,
  };
}

/**
 * Monta o objeto padrão de pedido Flex a partir do pedido bruto do ML
 * e da info já verificada (categoria/status). Reutilizado tanto na coleta
 * "ao vivo" (últimas horas) quanto no backfill via API (período longo).
 */
function montarPedidoFlex(conta, pedido, shipmentId, info) {
  const horasDesdeVenda = (Date.now() - new Date(pedido.date_created).getTime()) / (60 * 60 * 1000);
  const fracaoConsumida = horasDesdeVenda / PRAZO_COLETA_HORAS;

  let estado = 'ok';
  if (!info.coletado) {
    if (fracaoConsumida >= 0.8) estado = 'critico';
    else if (fracaoConsumida >= 0.55) estado = 'atencao';
  }

  const dataVenda = new Date(pedido.date_created).getTime();
  const horasAteColeta = info.coletado_em
    ? (new Date(info.coletado_em).getTime() - dataVenda) / (60 * 60 * 1000)
    : null;
  const horasAteEntrega = info.entregue_em
    ? (new Date(info.entregue_em).getTime() - dataVenda) / (60 * 60 * 1000)
    : null;

  return {
    marketplace: 'mercado_livre',
    conta,
    order_id: pedido.id,
    date_created: pedido.date_created,
    total_amount: pedido.total_amount,
    shipment_id: shipmentId,
    coletado: info.coletado,
    categoria: info.categoria,
    status_envio: info.status,
    estado,
    fracao_prazo_coleta_consumida: Math.min(1.2, Math.max(0, fracaoConsumida)),
    coletado_em: info.coletado_em || null,
    entregue_em: info.entregue_em || null,
    horas_ate_coleta: horasAteColeta,
    horas_ate_entrega: horasAteEntrega,
    itens: (pedido.order_items || []).map((oi) => ({
      titulo: oi.item.title,
      quantidade: oi.quantity,
      sku: oi.item.seller_sku,
    })),
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

    resultado.push(montarPedidoFlex(conta, pedido, shipmentId, info));
  }

  // Mais recentes e não coletados primeiro (o que precisa de atenção primeiro)
  resultado.sort((a, b) => {
    if (a.coletado !== b.coletado) return a.coletado ? 1 : -1;
    return new Date(a.date_created) - new Date(b.date_created);
  });

  return resultado;
}

module.exports = { coletarPedidosFlex, buscarPedidosPeriodo, verificarFlex, montarPedidoFlex };
