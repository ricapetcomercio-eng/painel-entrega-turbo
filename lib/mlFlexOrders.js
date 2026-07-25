// lib/mlFlexOrders.js
// Rastreia pedidos com entrega via MERCADO ENVIOS FLEX (logistic_type === 'self_service')
// e suas duas variantes mais rápidas, que tecnicamente são o mesmo logistic_type mas se
// distinguem por tags no shipment (confirmado na doc oficial do ML):
//   - Envios Turbo: tags contém "turbo" — até 3h entre venda e entrega.
//   - Envios Agora: logistic_type === "cross_docking" E tags contém "proximity" — até
//     25min entre venda e DESPACHO (não é self_service, mas precisa ser tratado aqui
//     porque senão fica invisível no painel e o vendedor perde o prazo sem perceber).
//
// Esse módulo identifica esses pedidos e informa se já foram "coletados" (o envio avançou
// para o status 'shipped'/'delivered') ou se ainda estão aguardando coleta.
//
// Validado com pedido real (23/07/2026): shipment.logistic_type === 'self_service' e
// shipment.status === 'delivered'/'shipped' se confirmaram exatamente como esperado.

const { getMLAccessToken } = require('./mlAuth');
const { SELLER_IDS } = require('./mlOrders');

// Prazo real do Flex "comum": entrega prometida até as 21h do MESMO DIA (horário de
// Brasília) — não um número fixo de horas desde a venda. Confirmado com um
// pedido real: criado 01:02, coletado só às 16:33 (quase 15h depois) e
// entregue às 18:41, tudo dentro do prazo — porque o que importa é chegar
// até as 21h daquele dia, não quando a coleta em si acontece.
// Pedidos feitos depois das 21h têm o prazo empurrado pro dia seguinte às 21h.
const TZ_BRASIL = 'America/Sao_Paulo';
// Brasil não observa horário de verão desde 2019 — offset fixo -03:00.
const TZ_BRASIL_OFFSET = '-03:00';
const HORA_LIMITE_ENTREGA = 21;

// Prazos das variantes rápidas (doc oficial developers.mercadolivre.com.br):
// Envios Turbo — até 3h entre a venda e a entrega.
const HORAS_TURBO = 3;
// Envios Agora — até 25min entre a venda e o DESPACHO (não a entrega). Perder esse
// prazo cancela o envio e gera penalidade de SLA, então tratamos com folga zero.
const MINUTOS_ENVIOS_AGORA = 25;

function calcularDeadlineFlex(dateCreatedIso) {
  const criado = new Date(dateCreatedIso);
  const dataBrasil = new Intl.DateTimeFormat('en-CA', { timeZone: TZ_BRASIL }).format(criado); // 'AAAA-MM-DD'
  let deadline = new Date(`${dataBrasil}T${String(HORA_LIMITE_ENTREGA).padStart(2, '0')}:00:00${TZ_BRASIL_OFFSET}`);
  if (deadline.getTime() <= criado.getTime()) {
    deadline = new Date(deadline.getTime() + 24 * 60 * 60 * 1000); // pedido feito após as 21h: empurra pro dia seguinte
  }
  return deadline.toISOString();
}

/**
 * Escolhe a regra de prazo certa conforme o tipo do envio ('agora' | 'turbo' | 'flex').
 */
function calcularDeadline(tipo, dateCreatedIso) {
  const criadoMs = new Date(dateCreatedIso).getTime();
  if (tipo === 'agora') return new Date(criadoMs + MINUTOS_ENVIOS_AGORA * 60 * 1000).toISOString();
  if (tipo === 'turbo') return new Date(criadoMs + HORAS_TURBO * 60 * 60 * 1000).toISOString();
  return calcularDeadlineFlex(dateCreatedIso);
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

  // Deixa o erro subir pra quem chamou (em vez de virar "null" silencioso),
  // pra distinguir "não é Flex" de "falhou por rate limit/erro de rede" —
  // essa confusão estava fazendo pedidos Flex reais desaparecerem do
  // painel sempre que a chamada à API falhava por qualquer motivo.
  const shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);

  const tags = shipment.tags || [];
  const isSelfService = shipment.logistic_type === 'self_service';
  // Envios Agora não é self_service — é cross_docking + tag "proximity" (doc oficial).
  const isEnviosAgora = shipment.logistic_type === 'cross_docking' && tags.includes('proximity');
  if (!isSelfService && !isEnviosAgora) return null;

  // Turbo não é um logistic_type próprio — continua self_service, só se diferencia
  // pela tag "turbo" no shipment (confirmado na doc oficial do ML).
  const tipo = isEnviosAgora ? 'agora' : tags.includes('turbo') ? 'turbo' : 'flex';

  let categoria = 'aguardando';
  if (shipment.status === 'delivered') categoria = 'entregue';
  else if (shipment.status === 'shipped') categoria = 'coletado';
  // not_delivered é estado final (a doc confirma: "irreversível") — sem isso, um
  // pedido que falhou a entrega ficaria preso em "aguardando" pra sempre, igual o
  // bug do shipment_id truncado que já corrigimos.
  else if (shipment.status === 'not_delivered') categoria = 'nao_entregue';

  let coletado_em = null;
  let entregue_em = null;
  if (categoria !== 'aguardando') {
    const historico = await buscarHistoricoShipment(conta, shipmentId);
    coletado_em = historico.coletado_em;
    entregue_em = historico.entregue_em;
  }

  return {
    coletado: categoria === 'coletado' || categoria === 'entregue',
    categoria, // 'aguardando' | 'coletado' (não entregue) | 'entregue' | 'nao_entregue'
    tipo, // 'flex' | 'turbo' | 'agora'
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
  const dataVenda = new Date(pedido.date_created).getTime();
  const deadline = calcularDeadline(info.tipo, pedido.date_created);
  const deadlineMs = new Date(deadline).getTime();
  const fracaoConsumida = (Date.now() - dataVenda) / (deadlineMs - dataVenda);

  let estado = 'ok';
  if (!info.coletado) {
    if (fracaoConsumida >= 0.8) estado = 'critico';
    else if (fracaoConsumida >= 0.55) estado = 'atencao';
  }

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
    tipo: info.tipo,
    status_envio: info.status,
    estado,
    deadline,
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
// Pausa entre chamadas à API do ML, pra não estourar rate limit — o mesmo
// problema que já vimos durante o backfill também acontece na coleta ao
// vivo se não houver essa pausa.
const PAUSA_ENTRE_CHAMADAS_MS = 70;
// Orçamento de tempo pra essa função não travar a execução do /api/collect
// (que roda a cada 1-2 minutos) caso a janela tenha muitos pedidos.
const TEMPO_MAXIMO_MS = 7000;

async function coletarPedidosFlex(conta, horasRetroativas = 6, erros) {
  const pedidos = await buscarPedidosRecentes(conta, horasRetroativas);
  const resultado = [];
  const inicio = Date.now();

  for (const pedido of pedidos) {
    if (Date.now() - inicio >= TEMPO_MAXIMO_MS) break; // fica pro próximo /api/collect

    const shipmentId = pedido.shipping && pedido.shipping.id;
    let info;
    try {
      info = await verificarFlex(conta, shipmentId);
    } catch (err) {
      if (erros) erros.push({ fonte: `mlFlexOrders:${conta}:${pedido.id}`, mensagem: err.message });
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_CHAMADAS_MS));
      continue;
    }
    if (!info) { // não é Flex mesmo (logistic_type diferente), ignora de verdade
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_CHAMADAS_MS));
      continue;
    }

    resultado.push(montarPedidoFlex(conta, pedido, shipmentId, info));
    await new Promise((r) => setTimeout(r, PAUSA_ENTRE_CHAMADAS_MS));
  }

  // Mais recentes e não coletados primeiro (o que precisa de atenção primeiro)
  resultado.sort((a, b) => {
    if (a.coletado !== b.coletado) return a.coletado ? 1 : -1;
    return new Date(a.date_created) - new Date(b.date_created);
  });

  return resultado;
}

/**
 * Reverifica o status de um pedido JÁ CONHECIDO (guardado no histórico),
 * usando só o shipment_id salvo — sem precisar rebuscar o pedido inteiro
 * na API de orders/search. Usado pra atualizar pedidos que ainda estavam
 * "aguardando" na última verificação, sem ter que reprocessar a janela
 * inteira de novo (isso é o que causava timeout/perda de pedidos antes).
 */
async function reverificarStatusPedido(pedidoArmazenado) {
  const info = await verificarFlex(pedidoArmazenado.conta, pedidoArmazenado.shipment_id);
  if (!info) return null; // deixou de ser Flex ou shipment sumiu — mantém como estava

  const dataVenda = new Date(pedidoArmazenado.date_created).getTime();
  const deadline = calcularDeadline(info.tipo, pedidoArmazenado.date_created);
  const deadlineMs = new Date(deadline).getTime();
  const fracaoConsumida = (Date.now() - dataVenda) / (deadlineMs - dataVenda);

  let estado = 'ok';
  if (!info.coletado) {
    if (fracaoConsumida >= 0.8) estado = 'critico';
    else if (fracaoConsumida >= 0.55) estado = 'atencao';
  }

  const horasAteColeta = info.coletado_em ? (new Date(info.coletado_em).getTime() - dataVenda) / (60 * 60 * 1000) : null;
  const horasAteEntrega = info.entregue_em ? (new Date(info.entregue_em).getTime() - dataVenda) / (60 * 60 * 1000) : null;

  return {
    ...pedidoArmazenado,
    coletado: info.coletado,
    categoria: info.categoria,
    tipo: info.tipo,
    status_envio: info.status,
    estado,
    deadline,
    fracao_prazo_coleta_consumida: Math.min(1.2, Math.max(0, fracaoConsumida)),
    coletado_em: info.coletado_em || pedidoArmazenado.coletado_em || null,
    entregue_em: info.entregue_em || pedidoArmazenado.entregue_em || null,
    horas_ate_coleta: horasAteColeta,
    horas_ate_entrega: horasAteEntrega,
  };
}

module.exports = { coletarPedidosFlex, buscarPedidosPeriodo, verificarFlex, montarPedidoFlex, reverificarStatusPedido, calcularDeadlineFlex, calcularDeadline };
