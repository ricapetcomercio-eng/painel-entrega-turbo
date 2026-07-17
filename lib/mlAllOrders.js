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

// ⚠️ TODO: validar contra um shipment real se estimated_delivery_limit /
// estimated_delivery_final vêm como string de data direta ou como objeto
// com sub-campo .date (o endpoint irmão /lead_time usa esse segundo
// formato: { date, shipping, handling, ... }). Aceita os dois por segurança.
function extrairDataPrazo(campo) {
  if (!campo) return null;
  if (typeof campo === 'string') return campo;
  if (typeof campo === 'object' && campo.date) return campo.date;
  return null;
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
 * Busca o histórico de status do shipment (com timestamps reais de cada
 * mudança), usado para calcular quanto tempo levou até a coleta e até a
 * entrega. Só chamado quando o pedido já saiu de "pending"/"handling".
 *
 * ⚠️ TODO: validar contra um pedido real o formato exato da resposta desse
 * endpoint (nomes dos campos de status/data podem variar).
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
 * Busca o shipment completo (logistic_type, status, endereço), e — quando
 * o pedido já saiu de "pending"/"handling" — também o histórico com os
 * timestamps reais de coleta/entrega.
 */
async function buscarDetalhesShipment(conta, shipmentId) {
  if (!shipmentId) return { logisticType: null, status: null, estado: null, cidade: null, coletado_em: null, entregue_em: null, prazo_entrega: null };
  try {
    const accessToken = await getMLAccessToken(conta);
    const shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);
    const endereco = shipment.receiver_address || {};

    let coletado_em = null;
    let entregue_em = null;
    if (shipment.status === 'shipped' || shipment.status === 'delivered') {
      const historico = await buscarHistoricoShipment(conta, shipmentId);
      coletado_em = historico.coletado_em;
      entregue_em = historico.entregue_em;
    }

    // Prioriza estimated_delivery_limit (prazo pro comprador poder
    // cancelar/reclamar) e cai para estimated_delivery_final se o primeiro
    // não vier preenchido.
    const prazo_entrega = extrairDataPrazo(shipment.estimated_delivery_limit) || extrairDataPrazo(shipment.estimated_delivery_final);

    return {
      logisticType: shipment.logistic_type || null,
      status: shipment.status || null,
      estado: (endereco.state && (endereco.state.name || endereco.state.id)) || null,
      cidade: (endereco.city && endereco.city.name) || null,
      coletado_em,
      entregue_em,
      prazo_entrega,
    };
  } catch (err) {
    return { logisticType: null, status: null, estado: null, cidade: null, coletado_em: null, entregue_em: null, prazo_entrega: null };
  }
}

/**
 * Monta o objeto padrão de pedido, com a forma de entrega já traduzida
 * para o nome amigável (usado no filtro da tela), categoria de status
 * (só relevante pra Flex, onde existe a etapa de "coleta") e os tempos
 * até coleta/entrega quando disponíveis.
 */
function montarPedidoGenerico(conta, pedido, shipmentId, detalhes) {
  const ehFlex = detalhes.logisticType === 'self_service';

  let categoria = null;
  if (ehFlex) {
    categoria = 'aguardando';
    if (detalhes.status === 'delivered') categoria = 'entregue';
    else if (detalhes.status === 'shipped') categoria = 'coletado';
  }

  const dataVenda = new Date(pedido.date_created).getTime();
  const horasAteColeta = ehFlex && detalhes.coletado_em
    ? (new Date(detalhes.coletado_em).getTime() - dataVenda) / (60 * 60 * 1000)
    : null;
  const horasAteEntrega = detalhes.entregue_em
    ? (new Date(detalhes.entregue_em).getTime() - dataVenda) / (60 * 60 * 1000)
    : null;

  // Atrasado: se já foi entregue, compara a data real de entrega com o
  // prazo. Se ainda não foi entregue, compara "agora" com o prazo — ou
  // seja, já passou do prazo e continua sem entregar.
  let atrasado = null;
  if (detalhes.prazo_entrega) {
    const prazoMs = new Date(detalhes.prazo_entrega).getTime();
    if (detalhes.entregue_em) {
      atrasado = new Date(detalhes.entregue_em).getTime() > prazoMs;
    } else if (detalhes.status !== 'cancelled') {
      atrasado = Date.now() > prazoMs;
    }
  }

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
    categoria, // só preenchido para Flex: 'aguardando' | 'coletado' | 'entregue'
    coletado: categoria !== null ? categoria !== 'aguardando' : null,
    coletado_em: detalhes.coletado_em || null,
    entregue_em: detalhes.entregue_em || null,
    horas_ate_coleta: horasAteColeta,
    horas_ate_entrega: horasAteEntrega,
    prazo_entrega: detalhes.prazo_entrega || null,
    atrasado,
    itens: (pedido.order_items || []).map((oi) => ({
      titulo: oi.item.title,
      quantidade: oi.quantity,
      sku: oi.item.seller_sku,
    })),
  };
}

module.exports = { buscarPedidosPeriodo, buscarDetalhesShipment, montarPedidoGenerico, traduzirLogisticType };
