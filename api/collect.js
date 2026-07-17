// api/collect.js
// Rota de coleta: pode ser chamada pelo Vercel Cron OU por um scheduler
// externo gratuito (recomendado: cron-job.org, 1x/min no plano free) via
// GET /api/collect?secret=SEU_CRON_SECRET
//
// Faz o trabalho pesado (chama ML e Shopee, processa) e grava o resultado
// pronto no Redis. O painel (dashboard-data.js) só lê esse resultado.
//
// HISTÓRICO DE BUGS JÁ CORRIGIDOS (pra não repetir):
//   1) Reprocessar a janela de 48h inteira a cada execução estourava o
//      tempo e descartava pedidos silenciosamente.
//   2) A correção incremental (só pedidos novos) não guardava o PROGRESSO
//      entre execuções — sempre recomeçava do zero e nunca avançava se a
//      janela inicial fosse maior que o orçamento de tempo de uma execução.
//   3) Processar um pedido de cada vez (com pausa) era seguro contra rate
//      limit, mas devagar demais pro volume real — pedidos novos chegavam
//      mais rápido do que conseguíamos processar. Agora processa em LOTES
//      PARALELOS (várias chamadas ao mesmo tempo, com pausa entre lotes).
//   4) O histórico geral ("Todos os pedidos") só cobria Mercado Livre —
//      Shopee ficava de fora porque lib/historicoTodos.js gravava tudo com
//      marketplace fixo em "mercado_livre". Generalizado, e agora a Shopee
//      também alimenta esse histórico com seu próprio coletor incremental
//      (usando cursor, já que a paginação da Shopee não é por offset).

const { getRedis } = require('../lib/redis');
const { SELLER_IDS } = require('../lib/mlOrders');
const { coletarPedidosTurbo } = require('../lib/shopeeOrders');
const { buscarPedidosPeriodo: buscarPedidosPeriodoShopee, buscarDetalhesCompletos: buscarDetalhesCompletosShopee, montarPedidoGenericoShopee } = require('../lib/shopeeOrders');
const { LOJAS: LOJAS_SHOPEE } = require('../lib/shopeeAuth');
const { buscarPedidosPeriodo, verificarFlex, montarPedidoFlex, reverificarStatusPedido } = require('../lib/mlFlexOrders');
const { registrarHistoricoFlex, listarRecentes } = require('../lib/historicoFlex');
const { buscarDetalhesShipment, montarPedidoGenerico } = require('../lib/mlAllOrders');
const { registrarHistoricoTodos } = require('../lib/historicoTodos');

const HORAS_RETROATIVAS = 6; // janela de busca padrão (Shopee Turbo)
const HORAS_JANELA_FLEX = 48; // "coleta só amanhã" — precisa de folga
const HORAS_JANELA_SHOPEE_TODOS = 48; // mesma folga usada no restante do backfill

const INTERVALO_MINIMO_MS = 2 * 60 * 1000; // 2 minutos

const LIMITE_HISTORICO = 5000;
const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
const HISTORICO_IDS_KEY = 'entrega_turbo:historico_ids_vistos';

// Processamento em lotes paralelos — bem mais rápido que um por um, ainda
// gentil com a API do ML (pausa entre lotes, poucas chamadas simultâneas).
const CONCORRENCIA = 4;
const PAUSA_ENTRE_LOTES_MS = 200;

async function processarEmLotes(itens, tempoOrcamentoMs, processarItem) {
  const inicio = Date.now();
  const resultados = [];
  let i = 0;
  while (i < itens.length && Date.now() - inicio < tempoOrcamentoMs) {
    const lote = itens.slice(i, i + CONCORRENCIA);
    const respostas = await Promise.allSettled(lote.map(processarItem));
    respostas.forEach((r) => {
      if (r.status === 'fulfilled' && r.value) resultados.push(r.value);
    });
    i += lote.length;
    if (i < itens.length && Date.now() - inicio < tempoOrcamentoMs) {
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_LOTES_MS));
    }
  }
  return { resultados, processados: i };
}

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

// -------- Histórico geral ("Todos os pedidos") — Mercado Livre, incremental, em lotes --------
const TEMPO_MAXIMO_TODOS_MS = 4000;

async function coletarNovosParaHistoricoTodos(redis, conta, erros) {
  const chaveUltimaCompleta = `entrega_turbo:todos_ultima_completa_ts:${conta}`;
  const chaveJanelaDesde = `entrega_turbo:todos_janela_desde:${conta}`;
  const chaveJanelaAte = `entrega_turbo:todos_janela_ate:${conta}`;
  const chaveJanelaOffset = `entrega_turbo:todos_janela_offset:${conta}`;

  try {
    let desde = await redis.get(chaveJanelaDesde);
    let ate = await redis.get(chaveJanelaAte);
    let offset = (await redis.get(chaveJanelaOffset)) || 0;

    if (!desde || !ate) {
      const ultimaCompleta = await redis.get(chaveUltimaCompleta);
      desde = ultimaCompleta || new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000).toISOString();
      ate = new Date().toISOString();
      offset = 0;
      await redis.set(chaveJanelaDesde, desde);
      await redis.set(chaveJanelaAte, ate);
      await redis.set(chaveJanelaOffset, 0);
    }

    const inicioExecucao = Date.now();
    let total = null;
    const pedidosParaGravar = [];

    while (Date.now() - inicioExecucao < TEMPO_MAXIMO_TODOS_MS) {
      const pagina = await buscarPedidosPeriodo(conta, desde, ate, offset, 50);
      if (total === null) total = pagina.total;
      if (pagina.results.length === 0) break;

      const tempoRestante = TEMPO_MAXIMO_TODOS_MS - (Date.now() - inicioExecucao);
      const { resultados, processados } = await processarEmLotes(pagina.results, tempoRestante, async (pedido) => {
        const shipmentId = pedido.shipping && pedido.shipping.id;
        const detalhes = await buscarDetalhesShipment(conta, shipmentId);
        const pedidoMontado = montarPedidoGenerico(conta, pedido, shipmentId, detalhes);
        // ⚠️ TODO: validar contra um pedido cancelado real do ML se o valor
        // exato é "cancelled" (documentado assim na API de Orders) — a API
        // do ML também tem "invalid" para pedidos com erro de pagamento,
        // que hoje NÃO conta como cancelado (só "cancelled" conta).
        return {
          ...pedidoMontado,
          status_pedido: pedido.status || null,
          cancelado: pedido.status === 'cancelled',
        };
      });
      pedidosParaGravar.push(...resultados);
      offset += processados;

      if (processados < pagina.results.length) break; // orçamento acabou no meio da página
      if (total !== null && offset >= total) break;
    }

    await registrarHistoricoTodos(redis, pedidosParaGravar);

    if (total === null || offset >= total) {
      await redis.set(chaveUltimaCompleta, ate);
      await redis.del(chaveJanelaDesde);
      await redis.del(chaveJanelaAte);
      await redis.del(chaveJanelaOffset);
    } else {
      await redis.set(chaveJanelaOffset, offset);
    }
  } catch (err) {
    erros.push({ fonte: `historico_todos:${conta}`, mensagem: err.message });
  }
}

// -------- Histórico geral ("Todos os pedidos") — Shopee, incremental, em lotes --------
// Mesmo espírito do coletor acima (Mercado Livre), mas adaptado à paginação
// da Shopee, que usa CURSOR opaco em vez de offset numérico.
const TEMPO_MAXIMO_TODOS_SHOPEE_MS = 4000;

async function coletarNovosParaHistoricoTodosShopee(redis, loja, erros) {
  const chaveUltimaCompleta = `entrega_turbo:todos_shopee_ultima_completa_ts:${loja}`;
  const chaveJanelaDesde = `entrega_turbo:todos_shopee_janela_desde:${loja}`;
  const chaveJanelaAte = `entrega_turbo:todos_shopee_janela_ate:${loja}`;
  const chaveJanelaCursor = `entrega_turbo:todos_shopee_janela_cursor:${loja}`;

  try {
    let desde = await redis.get(chaveJanelaDesde);
    let ate = await redis.get(chaveJanelaAte);
    let cursor = await redis.get(chaveJanelaCursor);

    if (!desde || !ate) {
      const ultimaCompleta = await redis.get(chaveUltimaCompleta);
      const desdeMs = ultimaCompleta
        ? new Date(ultimaCompleta).getTime()
        : Date.now() - HORAS_JANELA_SHOPEE_TODOS * 60 * 60 * 1000;
      desde = Math.floor(desdeMs / 1000); // Shopee usa epoch em segundos
      ate = Math.floor(Date.now() / 1000);
      cursor = null;
      await redis.set(chaveJanelaDesde, desde);
      await redis.set(chaveJanelaAte, ate);
      await redis.del(chaveJanelaCursor);
    } else {
      desde = Number(desde);
      ate = Number(ate);
    }

    const inicioExecucao = Date.now();
    const pedidosParaGravar = [];
    let terminouJanela = false;

    while (Date.now() - inicioExecucao < TEMPO_MAXIMO_TODOS_SHOPEE_MS) {
      const pagina = await buscarPedidosPeriodoShopee(loja, desde, ate, cursor, 50);
      if (pagina.results.length === 0) { terminouJanela = true; break; }

      const orderSnList = pagina.results.map((p) => p.order_sn);
      const detalhes = await buscarDetalhesCompletosShopee(loja, orderSnList);
      for (const pedido of detalhes) {
        pedidosParaGravar.push(montarPedidoGenericoShopee(loja, pedido));
      }

      cursor = pagina.nextCursor;
      if (!pagina.more || !cursor) { terminouJanela = true; break; }
      await redis.set(chaveJanelaCursor, cursor);
    }

    await registrarHistoricoTodos(redis, pedidosParaGravar);

    if (terminouJanela) {
      await redis.set(chaveUltimaCompleta, new Date(ate * 1000).toISOString());
      await redis.del(chaveJanelaDesde);
      await redis.del(chaveJanelaAte);
      await redis.del(chaveJanelaCursor);
    }
  } catch (err) {
    erros.push({ fonte: `historico_todos_shopee:${loja}`, mensagem: err.message });
  }
}

// -------- Flex — incremental (novos) + reverificação (pendentes), em lotes --------
const TEMPO_MAXIMO_FLEX_NOVOS_MS = 4000;
const TEMPO_MAXIMO_FLEX_RECHECK_MS = 4000;

async function coletarNovosFlex(redis, conta, erros) {
  const chaveUltimaCompleta = `entrega_turbo:flex_ultima_completa_ts:${conta}`;
  const chaveJanelaDesde = `entrega_turbo:flex_janela_desde:${conta}`;
  const chaveJanelaAte = `entrega_turbo:flex_janela_ate:${conta}`;
  const chaveJanelaOffset = `entrega_turbo:flex_janela_offset:${conta}`;

  try {
    let desde = await redis.get(chaveJanelaDesde);
    let ate = await redis.get(chaveJanelaAte);
    let offset = (await redis.get(chaveJanelaOffset)) || 0;

    if (!desde || !ate) {
      const ultimaCompleta = await redis.get(chaveUltimaCompleta);
      desde = ultimaCompleta || new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000).toISOString();
      ate = new Date().toISOString();
      offset = 0;
      await redis.set(chaveJanelaDesde, desde);
      await redis.set(chaveJanelaAte, ate);
      await redis.set(chaveJanelaOffset, 0);
    }

    const inicioExecucao = Date.now();
    let total = null;
    const pedidosParaGravar = [];

    while (Date.now() - inicioExecucao < TEMPO_MAXIMO_FLEX_NOVOS_MS) {
      const pagina = await buscarPedidosPeriodo(conta, desde, ate, offset, 50);
      if (total === null) total = pagina.total;
      if (pagina.results.length === 0) break;

      const tempoRestante = TEMPO_MAXIMO_FLEX_NOVOS_MS - (Date.now() - inicioExecucao);
      const { resultados, processados } = await processarEmLotes(pagina.results, tempoRestante, async (pedido) => {
        const shipmentId = pedido.shipping && pedido.shipping.id;
        const info = await verificarFlex(conta, shipmentId);
        return info ? montarPedidoFlex(conta, pedido, shipmentId, info) : null;
      });
      pedidosParaGravar.push(...resultados);
      offset += processados;

      if (processados < pagina.results.length) break;
      if (total !== null && offset >= total) break;
    }

    await registrarHistoricoFlex(redis, pedidosParaGravar);

    if (total === null || offset >= total) {
      await redis.set(chaveUltimaCompleta, ate);
      await redis.del(chaveJanelaDesde);
      await redis.del(chaveJanelaAte);
      await redis.del(chaveJanelaOffset);
    } else {
      await redis.set(chaveJanelaOffset, offset);
    }
  } catch (err) {
    erros.push({ fonte: `flex_novos:${conta}`, mensagem: err.message });
  }
}

async function reverificarPendentesFlex(redis, erros) {
  try {
    const recentes = await listarRecentes(redis, HORAS_JANELA_FLEX);
    const pendentes = recentes.filter((p) => (p.categoria || 'aguardando') === 'aguardando' && p.shipment_id);

    const { resultados } = await processarEmLotes(pendentes, TEMPO_MAXIMO_FLEX_RECHECK_MS, async (pedido) => {
      try {
        return await reverificarStatusPedido(pedido);
      } catch (err) {
        erros.push({ fonte: `flex_recheck:${pedido.order_id}`, mensagem: err.message });
        return null;
      }
    });

    if (resultados.length > 0) {
      await registrarHistoricoFlex(redis, resultados);
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

  for (const loja of LOJAS_SHOPEE) {
    await coletarNovosParaHistoricoTodosShopee(redis, loja, erros);
  }

  res.status(200).json({
    ok: true,
    total_coletado: resultado.total,
    total_coletado_flex: resultadoFlex.total,
    erros,
  });
};
