// api/collect.js
// Rota de coleta: pode ser chamada pelo Vercel Cron OU por um scheduler
// externo gratuito (recomendado: cron-job.org, 1x/min no plano free) via
// GET /api/collect?secret=SEU_CRON_SECRET
//
// Faz o trabalho pesado (chama ML e Shopee, processa) e grava o resultado
// pronto no Redis. O painel (dashboard-data.js) só lê esse resultado.
//
// Também acumula um HISTÓRICO de pedidos expressos (ML + Shopee) no Redis,
// usado pelo painel de analytics (public/index.html) para gráficos de
// horários de pico, dias da semana, regiões, etc — algo que o snapshot
// "últimas 6h" sozinho não permite mostrar de forma útil ao longo do tempo.

const { getRedis } = require('../lib/redis');
const { coletarPedidosExpressos, SELLER_IDS } = require('../lib/mlOrders');
const { coletarPedidosTurbo } = require('../lib/shopeeOrders');
const { coletarPedidosFlex } = require('../lib/mlFlexOrders');
const { registrarHistoricoFlex } = require('../lib/historicoFlex');
const { buscarPedidosPeriodo, buscarDetalhesShipment, montarPedidoGenerico } = require('../lib/mlAllOrders');
const { registrarHistoricoTodos } = require('../lib/historicoTodos');

const HORAS_RETROATIVAS = 6; // janela de busca padrão (Shopee Turbo)

// O Flex às vezes só é coletado no dia seguinte à venda ("dar o pacote
// amanhã"). Com uma janela de só 6h, o pedido "sai" da busca antes de a
// coleta acontecer e nunca chega a ser marcado como coletado. Por isso
// usamos uma janela bem maior aqui — 48h cobre o "amanhã" com folga.
const HORAS_RETROATIVAS_FLEX = 48;

// Intervalo mínimo entre execuções reais, mesmo que a rota seja chamada
// com mais frequência (ex: 2 schedulers disparando quase juntos, ou teste
// manual repetido). Protege o teto de CPU do Vercel independente de quem
// ou quantas vezes chamar a rota.
const INTERVALO_MINIMO_MS = 2 * 60 * 1000; // 2 minutos

// Histórico: quantos registros manter no máximo (evita crescer para sempre).
// ~5000 registros cobre bastante tempo de operação normal.
const LIMITE_HISTORICO = 5000;
const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
const HISTORICO_IDS_KEY = 'entrega_turbo:historico_ids_vistos';
// Histórico do Flex agora vive em lib/historicoFlex.js (compartilhado com
// o backfill via API).

async function registrarNoHistorico(redis, pedidos, historicoKey, idsKey, extrator) {
  for (const pedido of pedidos) {
    const idUnico = `${pedido.marketplace}:${pedido.order_id}`;
    const jaVisto = await redis.sismember(idsKey, idUnico);
    if (jaVisto) continue;

    await redis.sadd(idsKey, idUnico);
    await redis.lpush(historicoKey, extrator(pedido));
  }
  // Mantém o histórico dentro do limite (remove os mais antigos do final da lista)
  await redis.ltrim(historicoKey, 0, LIMITE_HISTORICO - 1);
  // Renova o TTL do set de ids vistos (30 dias) para não crescer para sempre
  await redis.expire(idsKey, 60 * 60 * 24 * 30);
}

// Coleta contínua pro histórico geral ("Todos os pedidos" / Flex): busca só
// os pedidos NOVOS desde a última execução bem-sucedida, em vez de
// reprocessar tudo (que seria pesado demais a cada 1-2 minutos). Se não der
// tempo de processar a janela inteira dentro do orçamento, NÃO avança o
// marcador — a próxima execução tenta de novo essa mesma janela, sem
// arriscar perder pedido nenhum.
const TEMPO_MAXIMO_TODOS_MS = 4000;

async function coletarNovosParaHistoricoTodos(redis, conta, erros) {
  const chaveTs = `entrega_turbo:ultima_coleta_todos_ts:${conta}`;
  const desdeSalvo = await redis.get(chaveTs);
  const desde = desdeSalvo ? new Date(desdeSalvo) : new Date(Date.now() - HORAS_RETROATIVAS_FLEX * 60 * 60 * 1000);
  const ate = new Date();

  const inicioExecucao = Date.now();
  let offset = 0;
  let total = null;
  const pedidosParaGravar = [];

  try {
    while (Date.now() - inicioExecucao < TEMPO_MAXIMO_TODOS_MS) {
      const pagina = await buscarPedidosPeriodo(conta, desde.toISOString(), ate.toISOString(), offset, 50);
      if (total === null) total = pagina.total;
      if (pagina.results.length === 0) break;

      for (const pedido of pagina.results) {
        if (Date.now() - inicioExecucao >= TEMPO_MAXIMO_TODOS_MS) break;
        const shipmentId = pedido.shipping && pedido.shipping.id;
        const detalhes = await buscarDetalhesShipment(conta, shipmentId);
        pedidosParaGravar.push(montarPedidoGenerico(conta, pedido, shipmentId, detalhes));
        offset++;
      }
      if (total !== null && offset >= total) break;
    }

    await registrarHistoricoTodos(redis, pedidosParaGravar);

    if (total === null || offset >= total) {
      // processou a janela inteira dentro do orçamento — avança o marcador
      await redis.set(chaveTs, ate.toISOString());
    }
    // senão, não avança: a próxima execução (em 1-2 min) tenta de novo
  } catch (err) {
    erros.push({ fonte: `historico_todos:${conta}`, mensagem: err.message });
  }
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined;
  const hasValidSecret = cronSecret && req.query.secret === cronSecret;

  if (!isVercelCron && !hasValidSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const redis = getRedis();

  // Throttle: evita trabalho duplicado se chamado com muita frequência.
  const ultimaExecucao = await redis.get('entrega_turbo:ultima_execucao_ts');
  const agora = Date.now();
  if (ultimaExecucao && agora - ultimaExecucao < INTERVALO_MINIMO_MS) {
    res.status(200).json({
      ok: true,
      pulado: true,
      motivo: `Última execução há ${Math.round((agora - ultimaExecucao) / 1000)}s, mínimo é ${INTERVALO_MINIMO_MS / 1000}s.`,
    });
    return;
  }
  await redis.set('entrega_turbo:ultima_execucao_ts', agora);

  const erros = [];
  let pedidosML = [];
  let pedidosShopee = [];
  let pedidosFlex = [];

  for (const conta of Object.keys(SELLER_IDS)) {
    try {
      const pedidos = await coletarPedidosExpressos(conta, HORAS_RETROATIVAS_FLEX);
      pedidosML = pedidosML.concat(pedidos);
    } catch (err) {
      erros.push({ fonte: `ml:${conta}`, mensagem: err.message });
    }
  }

  for (const conta of Object.keys(SELLER_IDS)) {
    try {
      const pedidos = await coletarPedidosFlex(conta, HORAS_RETROATIVAS_FLEX);
      pedidosFlex = pedidosFlex.concat(pedidos);
    } catch (err) {
      erros.push({ fonte: `ml_flex:${conta}`, mensagem: err.message });
    }
  }

  for (const loja of ['ricapet', 'thapets']) {
    try {
      const pedidos = await coletarPedidosTurbo(loja, HORAS_RETROATIVAS);
      pedidosShopee = pedidosShopee.concat(pedidos);
    } catch (err) {
      erros.push({ fonte: `shopee:${loja}`, mensagem: err.message });
    }
  }

  const pedidosUnificados = [...pedidosML, ...pedidosShopee].map((pedido) => {
    const horas = pedido.horas_prometidas || 4;
    const deadline = new Date(
      new Date(pedido.date_created).getTime() + horas * 60 * 60 * 1000
    ).toISOString();
    return { ...pedido, deadline };
  });

  const resultado = {
    atualizado_em: new Date().toISOString(),
    pedidos: pedidosUnificados.sort(
      (a, b) => new Date(a.deadline) - new Date(b.deadline) // mais urgente primeiro
    ),
    total: pedidosML.length + pedidosShopee.length,
    erros,
  };

  const resultadoFlex = {
    atualizado_em: new Date().toISOString(),
    pedidos: pedidosFlex,
    total: pedidosFlex.length,
    entregues: pedidosFlex.filter((p) => p.categoria === 'entregue').length,
    coletados_nao_entregues: pedidosFlex.filter((p) => p.categoria === 'coletado').length,
    aguardando_coleta: pedidosFlex.filter((p) => p.categoria === 'aguardando' || !p.categoria).length,
  };

  await redis.set('entrega_turbo:ultima_coleta', resultado);
  await redis.set('entrega_turbo:ultima_coleta_flex', resultadoFlex);

  try {
    await registrarNoHistorico(redis, pedidosUnificados, HISTORICO_KEY, HISTORICO_IDS_KEY, (pedido) => ({
      marketplace: pedido.marketplace,
      conta: pedido.conta || pedido.loja || null,
      order_id: pedido.order_id,
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      estado: pedido.estado || null,
      cidade: pedido.cidade || null,
      itens: pedido.itens || [],
    }));
  } catch (err) {
    erros.push({ fonte: 'historico', mensagem: err.message });
  }

  try {
    await registrarHistoricoFlex(redis, pedidosFlex);
  } catch (err) {
    erros.push({ fonte: 'historico_flex', mensagem: err.message });
  }

  for (const conta of Object.keys(SELLER_IDS)) {
    await coletarNovosParaHistoricoTodos(redis, conta, erros);
  }

  res.status(200).json({
    ok: true,
    total_coletado: resultado.total,
    total_coletado_flex: resultadoFlex.total,
    erros,
  });
};
