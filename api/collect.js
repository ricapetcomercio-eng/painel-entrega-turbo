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

const HORAS_RETROATIVAS = 6; // janela de busca de pedidos

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
const HISTORICO_FLEX_KEY = 'entrega_turbo:historico_pedidos_flex';
const HISTORICO_FLEX_IDS_KEY = 'entrega_turbo:historico_ids_vistos_flex';

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
      const pedidos = await coletarPedidosExpressos(conta, HORAS_RETROATIVAS);
      pedidosML = pedidosML.concat(pedidos);
    } catch (err) {
      erros.push({ fonte: `ml:${conta}`, mensagem: err.message });
    }
  }

  for (const conta of Object.keys(SELLER_IDS)) {
    try {
      const pedidos = await coletarPedidosFlex(conta, HORAS_RETROATIVAS);
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
    aguardando_coleta: pedidosFlex.filter((p) => !p.coletado).length,
    coletados: pedidosFlex.filter((p) => p.coletado).length,
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
    await registrarNoHistorico(redis, pedidosFlex, HISTORICO_FLEX_KEY, HISTORICO_FLEX_IDS_KEY, (pedido) => ({
      marketplace: pedido.marketplace,
      conta: pedido.conta || null,
      order_id: pedido.order_id,
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      coletado: pedido.coletado,
      itens: pedido.itens || [],
    }));
  } catch (err) {
    erros.push({ fonte: 'historico_flex', mensagem: err.message });
  }

  res.status(200).json({
    ok: true,
    total_coletado: resultado.total,
    total_coletado_flex: resultadoFlex.total,
    erros,
  });
};
