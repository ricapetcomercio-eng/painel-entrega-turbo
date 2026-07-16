// api/collect.js
// Rota de coleta: pode ser chamada pelo Vercel Cron OU por um scheduler
// externo gratuito (recomendado: cron-job.org, 1x/min no plano free) via
// GET /api/collect?secret=SEU_CRON_SECRET
//
// Faz o trabalho pesado (chama ML e Shopee, processa) e grava o resultado
// pronto no Redis. O painel (dashboard-data.js) só lê esse resultado.
//
// IMPORTANTE (histórico de bug): antes, o Flex era reprocessado do zero a
// cada execução (janela de 48h inteira, pedido por pedido) — com muitos
// pedidos na janela, o orçamento de tempo estourava antes de terminar,
// descartando pedidos silenciosamente (pareciam "sumir" do painel).
// Agora a estratégia é:
//   1) buscar só os pedidos NOVOS desde a última execução (rápido);
//   2) reverificar só os pedidos que AINDA estavam "aguardando" na última
//      leitura (grupo bem menor que a janela inteira);
//   3) montar o snapshot ao vivo lendo do próprio histórico já salvo no
//      Redis (barato), em vez de rebuscar tudo na API do ML de novo.

const { getRedis } = require('../lib/redis');
const { SELLER_IDS } = require('../lib/mlOrders');
const { coletarPedidosTurbo } = require('../lib/shopeeOrders');
const { buscarPedidosPeriodo, verificarFlex, montarPedidoFlex, reverificarStatusPedido } = require('../lib/mlFlexOrders');
const { registrarHistoricoFlex, listarRecentes } = require('../lib/historicoFlex');
const { buscarDetalhesShipment, montarPedidoGenerico } = require('../lib/mlAllOrders');
const { registrarHistoricoTodos } = require('../lib/historicoTodos');

const HORAS_RETROATIVAS = 6; // janela de busca padrão (Shopee Turbo)
const HORAS_JANELA_FLEX = 48; // "coleta só amanhã" — precisa de folga

// Intervalo mínimo entre execuções reais, mesmo que a rota seja chamada
// com mais frequência (ex: 2 schedulers disparando quase juntos, ou teste
// manual repetido). Protege o teto de CPU do Vercel independente de quem
// ou quantas vezes chamar a rota.
const INTERVALO_MINIMO_MS = 2 * 60 * 1000; // 2 minutos

// Histórico do Turbo (Shopee) — lista simples, congela no 1º status visto
// (aceitável: Shopee ainda não está com Turbo funcionando de verdade).
const LIMITE_HISTORICO = 5000;
const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
const HISTORICO_IDS_KEY = 'entrega_turbo:historico_ids_vistos';

async function registrarNoHistorico(redis, pedidos, historicoKey, idsKey, extrator) {
  for (const pedido of pedidos) {
    const idUnico = `${pedido.marketplace}:${pedido.order_id}`;
    const jaVisto = await redis.sismember(idsKey, idUnico);
    if (jaVisto) continue;

    await redis.sadd(idsKey, idUnico);
    await redis.lpush(historicoKey, extrator(pedido));
  }
  await redis.ltrim(historicoKey, 0, LIMITE_HISTORICO - 1);
  await redis.expire(idsKey, 60 * 60 * 24 * 30);
}

// -------- Histórico geral ("Todos os pedidos") — incremental --------
const TEMPO_MAXIMO_TODOS_MS = 3000;

async function coletarNovosParaHistoricoTodos(redis, conta, erros) {
  const chaveTs = `entrega_turbo:ultima_coleta_todos_ts:${conta}`;
  const desdeSalvo = await redis.get(chaveTs);
  const desde = desdeSalvo ? new Date(desdeSalvo) : new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000);
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
      await redis.set(chaveTs, ate.toISOString());
    }
  } catch (err) {
    erros.push({ fonte: `historico_todos:${conta}`, mensagem: err.message });
  }
}

// -------- Flex — incremental (novos) + reverificação (pendentes) --------
const TEMPO_MAXIMO_FLEX_NOVOS_MS = 3000;
const TEMPO_MAXIMO_FLEX_RECHECK_MS = 3000;

async function coletarNovosFlex(redis, conta, erros) {
  const chaveTs = `entrega_turbo:ultima_coleta_flex_ts:${conta}`;
  const desdeSalvo = await redis.get(chaveTs);
  const desde = desdeSalvo ? new Date(desdeSalvo) : new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000);
  const ate = new Date();

  const inicioExecucao = Date.now();
  let offset = 0;
  let total = null;
  const pedidosParaGravar = [];

  try {
    while (Date.now() - inicioExecucao < TEMPO_MAXIMO_FLEX_NOVOS_MS) {
      const pagina = await buscarPedidosPeriodo(conta, desde.toISOString(), ate.toISOString(), offset, 50);
      if (total === null) total = pagina.total;
      if (pagina.results.length === 0) break;

      for (const pedido of pagina.results) {
        if (Date.now() - inicioExecucao >= TEMPO_MAXIMO_FLEX_NOVOS_MS) break;
        const shipmentId = pedido.shipping && pedido.shipping.id;
        const info = await verificarFlex(conta, shipmentId);
        offset++;
        if (info) pedidosParaGravar.push(montarPedidoFlex(conta, pedido, shipmentId, info));
      }
      if (total !== null && offset >= total) break;
    }

    await registrarHistoricoFlex(redis, pedidosParaGravar);

    if (total === null || offset >= total) {
      await redis.set(chaveTs, ate.toISOString());
    }
  } catch (err) {
    erros.push({ fonte: `flex_novos:${conta}`, mensagem: err.message });
  }
}

async function reverificarPendentesFlex(redis, erros) {
  const inicioExecucao = Date.now();
  try {
    const recentes = await listarRecentes(redis, HORAS_JANELA_FLEX);
    const pendentes = recentes.filter((p) => (p.categoria || 'aguardando') === 'aguardando' && p.shipment_id);

    const atualizados = [];
    for (const pedido of pendentes) {
      if (Date.now() - inicioExecucao >= TEMPO_MAXIMO_FLEX_RECHECK_MS) break;
      try {
        const atualizado = await reverificarStatusPedido(pedido);
        if (atualizado) atualizados.push(atualizado);
      } catch (err) {
        erros.push({ fonte: `flex_recheck:${pedido.order_id}`, mensagem: err.message });
      }
    }

    if (atualizados.length > 0) {
      await registrarHistoricoFlex(redis, atualizados);
    }
  } catch (err) {
    erros.push({ fonte: 'flex_recheck_geral', mensagem: err.message });
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
  let pedidosShopee = [];

  // Turbo real = Shopee Entrega Turbo (ainda pendente de aprovação/uso)
  for (const loja of ['ricapet', 'thapets']) {
    try {
      const pedidos = await coletarPedidosTurbo(loja, HORAS_RETROATIVAS);
      pedidosShopee = pedidosShopee.concat(pedidos);
    } catch (err) {
      erros.push({ fonte: `shopee:${loja}`, mensagem: err.message });
    }
  }

  const pedidosUnificados = pedidosShopee.map((pedido) => {
    const horas = pedido.horas_prometidas || 4;
    const deadline = new Date(
      new Date(pedido.date_created).getTime() + horas * 60 * 60 * 1000
    ).toISOString();
    return { ...pedido, deadline };
  });

  const resultado = {
    atualizado_em: new Date().toISOString(),
    pedidos: pedidosUnificados.sort((a, b) => new Date(a.deadline) - new Date(b.deadline)),
    total: pedidosShopee.length,
    erros,
  };

  // Flex: 1) busca novos, 2) reverifica pendentes, 3) monta snapshot do histórico
  for (const conta of Object.keys(SELLER_IDS)) {
    await coletarNovosFlex(redis, conta, erros);
  }
  await reverificarPendentesFlex(redis, erros);

  const pedidosFlexAtuais = await listarRecentes(redis, HORAS_JANELA_FLEX);
  const resultadoFlex = {
    atualizado_em: new Date().toISOString(),
    pedidos: pedidosFlexAtuais,
    total: pedidosFlexAtuais.length,
    entregues: pedidosFlexAtuais.filter((p) => p.categoria === 'entregue').length,
    coletados_nao_entregues: pedidosFlexAtuais.filter((p) => p.categoria === 'coletado').length,
    aguardando_coleta: pedidosFlexAtuais.filter((p) => (p.categoria || 'aguardando') === 'aguardando').length,
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
