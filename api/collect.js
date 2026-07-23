// api/collect.js
// Rota de coleta: pode ser chamada pelo Vercel Cron OU por um scheduler
// externo gratuito (recomendado: cron-job.org, 1x/min no plano free) via
// GET /api/collect?secret=SEU_CRON_SECRET
//
// Faz o trabalho pesado (chama ML e Shopee, processa) e grava o resultado
// pronto no Turso. O painel (dashboard-data.js) só lê esse resultado.
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
//   5) Migrado de Redis (Upstash) para Turso (SQLite) — o Redis era
//      compartilhado com outros dois projetos (concorrentes-ml,
//      painelvendas-seven) e estourava a cota de 500k requisições/mês.

const { getDb } = require('../lib/db');
const { kvGet, kvSet, kvDel } = require('../lib/kv');
const { SELLER_IDS } = require('../lib/mlOrders');
const { coletarPedidosTurbo } = require('../lib/shopeeOrders');
const { buscarPedidosPeriodo: buscarPedidosPeriodoShopee, buscarDetalhesCompletos: buscarDetalhesCompletosShopee, montarPedidoGenericoShopee } = require('../lib/shopeeOrders');
const { LOJAS: LOJAS_SHOPEE } = require('../lib/shopeeAuth');
const { buscarPedidosPeriodo, verificarFlex, montarPedidoFlex, reverificarStatusPedido } = require('../lib/mlFlexOrders');
const { registrarHistoricoFlex, listarRecentes } = require('../lib/historicoFlex');
const { buscarDetalhesShipment, montarPedidoGenerico } = require('../lib/mlAllOrders');
const { buscarDevolucoesPeriodo } = require('../lib/mlClaims');
const { buscarDevolucoesPorPedido: buscarDevolucoesShopeePorPedido } = require('../lib/shopeeReturns');
const { registrarHistoricoTodos, marcarDevolucao } = require('../lib/historicoTodos');

const HORAS_RETROATIVAS = 6; // janela de busca padrão (Shopee Turbo)
const HORAS_JANELA_FLEX = 48; // "coleta só amanhã" — precisa de folga
const HORAS_JANELA_SHOPEE_TODOS = 48; // mesma folga usada no restante do backfill

const INTERVALO_MINIMO_MS = 2 * 60 * 1000; // 2 minutos
// A Shopee (produção) exige proxy com IP fixo (Fixie), que tem cota
// limitada de requisições/mês. Rodando no mesmo ritmo do ML (a cada
// ~2min) estourava a cota rapidamente. O Mercado Livre não usa esse
// proxy, então continua no ritmo normal — só a Shopee roda mais devagar,
// controlada por este intervalo próprio.
const INTERVALO_MINIMO_SHOPEE_MS = 15 * 60 * 1000; // 15 minutos
// Devoluções mudam devagar (não é "pedido novo chegando"), então não
// precisa rodar a cada execução — a cada 30min já é mais que suficiente
// e economiza chamadas à API do ML.
const INTERVALO_MINIMO_DEVOLUCOES_MS = 30 * 60 * 1000; // 30 minutos
const DIAS_JANELA_DEVOLUCOES = 60; // cobre pedidos com prazo de reclamação em aberto
// "Todos os pedidos" do ML é dado de BI/dashboard, não precisa do ritmo
// rápido do Flex (que alimenta a TV da expedição em tempo real). Rodando
// mais devagar, sobra mais orçamento de chamadas pro ML antes de bater
// em rate limit (429).
const INTERVALO_MINIMO_TODOS_ML_MS = 5 * 60 * 1000; // 5 minutos

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

// -------- Histórico Turbo/Shopee (tabela historico_turbo) --------
// A dedup que o Redis fazia com SET+LIST agora é automática: a PRIMARY KEY
// (id_unico) da tabela rejeita duplicatas via INSERT OR IGNORE.
async function registrarNoHistoricoTurbo(pedidos, extrator) {
  if (!pedidos || pedidos.length === 0) return;
  const db = getDb();
  for (const pedido of pedidos) {
    const dados = extrator(pedido);
    const idUnico = `${dados.marketplace}:${dados.order_id}`;
    const dateCreatedTs = new Date(dados.date_created).getTime();
    await db.execute({
      sql: `INSERT OR IGNORE INTO historico_turbo
              (id_unico, marketplace, conta, order_id, date_created, date_created_ts, total_amount, estado, cidade, itens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        idUnico, dados.marketplace, dados.conta || null, String(dados.order_id), dados.date_created,
        dateCreatedTs, dados.total_amount, dados.estado || null, dados.cidade || null,
        JSON.stringify(dados.itens || []),
      ],
    });
  }
}

// -------- Histórico geral ("Todos os pedidos") — Mercado Livre, incremental, em lotes --------
const TEMPO_MAXIMO_TODOS_MS = 4000;

async function coletarNovosParaHistoricoTodos(conta, erros) {
  const chaveUltimaCompleta = `entrega_turbo:todos_ultima_completa_ts:${conta}`;
  const chaveJanelaDesde = `entrega_turbo:todos_janela_desde:${conta}`;
  const chaveJanelaAte = `entrega_turbo:todos_janela_ate:${conta}`;
  const chaveJanelaOffset = `entrega_turbo:todos_janela_offset:${conta}`;

  try {
    let desde = await kvGet(chaveJanelaDesde);
    let ate = await kvGet(chaveJanelaAte);
    let offset = (await kvGet(chaveJanelaOffset)) || 0;

    if (!desde || !ate) {
      const ultimaCompleta = await kvGet(chaveUltimaCompleta);
      desde = ultimaCompleta || new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000).toISOString();
      ate = new Date().toISOString();
      offset = 0;
      await kvSet(chaveJanelaDesde, desde);
      await kvSet(chaveJanelaAte, ate);
      await kvSet(chaveJanelaOffset, 0);
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

    await registrarHistoricoTodos(pedidosParaGravar);

    if (total === null || offset >= total) {
      await kvSet(chaveUltimaCompleta, ate);
      await kvDel(chaveJanelaDesde);
      await kvDel(chaveJanelaAte);
      await kvDel(chaveJanelaOffset);
    } else {
      await kvSet(chaveJanelaOffset, offset);
    }
  } catch (err) {
    erros.push({ fonte: `historico_todos:${conta}`, mensagem: err.message });
  }
}

// -------- Histórico geral ("Todos os pedidos") — Shopee, incremental, em lotes --------
// Mesmo espírito do coletor acima (Mercado Livre), mas adaptado à paginação
// da Shopee, que usa CURSOR opaco em vez de offset numérico.
const TEMPO_MAXIMO_TODOS_SHOPEE_MS = 4000;

async function coletarNovosParaHistoricoTodosShopee(loja, erros) {
  const chaveUltimaCompleta = `entrega_turbo:todos_shopee_ultima_completa_ts:${loja}`;
  const chaveJanelaDesde = `entrega_turbo:todos_shopee_janela_desde:${loja}`;
  const chaveJanelaAte = `entrega_turbo:todos_shopee_janela_ate:${loja}`;
  const chaveJanelaCursor = `entrega_turbo:todos_shopee_janela_cursor:${loja}`;

  try {
    let desde = await kvGet(chaveJanelaDesde);
    let ate = await kvGet(chaveJanelaAte);
    let cursor = await kvGet(chaveJanelaCursor);

    if (!desde || !ate) {
      const ultimaCompleta = await kvGet(chaveUltimaCompleta);
      const desdeMs = ultimaCompleta
        ? new Date(ultimaCompleta).getTime()
        : Date.now() - HORAS_JANELA_SHOPEE_TODOS * 60 * 60 * 1000;
      desde = Math.floor(desdeMs / 1000); // Shopee usa epoch em segundos
      ate = Math.floor(Date.now() / 1000);
      cursor = null;
      await kvSet(chaveJanelaDesde, desde);
      await kvSet(chaveJanelaAte, ate);
      await kvDel(chaveJanelaCursor);
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
      await kvSet(chaveJanelaCursor, cursor);
    }

    await registrarHistoricoTodos(pedidosParaGravar);

    if (terminouJanela) {
      await kvSet(chaveUltimaCompleta, new Date(ate * 1000).toISOString());
      await kvDel(chaveJanelaDesde);
      await kvDel(chaveJanelaAte);
      await kvDel(chaveJanelaCursor);
    }
  } catch (err) {
    erros.push({ fonte: `historico_todos_shopee:${loja}`, mensagem: err.message });
  }
}

// -------- Flex — incremental (novos) + reverificação (pendentes), em lotes --------
const TEMPO_MAXIMO_FLEX_NOVOS_MS = 4000;
const TEMPO_MAXIMO_FLEX_RECHECK_MS = 4000;

async function coletarNovosFlex(conta, erros) {
  const chaveUltimaCompleta = `entrega_turbo:flex_ultima_completa_ts:${conta}`;
  const chaveJanelaDesde = `entrega_turbo:flex_janela_desde:${conta}`;
  const chaveJanelaAte = `entrega_turbo:flex_janela_ate:${conta}`;
  const chaveJanelaOffset = `entrega_turbo:flex_janela_offset:${conta}`;

  try {
    let desde = await kvGet(chaveJanelaDesde);
    let ate = await kvGet(chaveJanelaAte);
    let offset = (await kvGet(chaveJanelaOffset)) || 0;

    if (!desde || !ate) {
      const ultimaCompleta = await kvGet(chaveUltimaCompleta);
      desde = ultimaCompleta || new Date(Date.now() - HORAS_JANELA_FLEX * 60 * 60 * 1000).toISOString();
      ate = new Date().toISOString();
      offset = 0;
      await kvSet(chaveJanelaDesde, desde);
      await kvSet(chaveJanelaAte, ate);
      await kvSet(chaveJanelaOffset, 0);
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

    await registrarHistoricoFlex(pedidosParaGravar);

    if (total === null || offset >= total) {
      await kvSet(chaveUltimaCompleta, ate);
      await kvDel(chaveJanelaDesde);
      await kvDel(chaveJanelaAte);
      await kvDel(chaveJanelaOffset);
    } else {
      await kvSet(chaveJanelaOffset, offset);
    }
  } catch (err) {
    erros.push({ fonte: `flex_novos:${conta}`, mensagem: err.message });
  }
}

async function reverificarPendentesFlex(erros) {
  try {
    const recentes = await listarRecentes(HORAS_JANELA_FLEX);
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
      await registrarHistoricoFlex(resultados);
    }
  } catch (err) {
    erros.push({ fonte: 'flex_recheck_geral', mensagem: err.message });
  }
}

async function enriquecerDevolucoes(conta, erros) {
  try {
    const desde = new Date(Date.now() - DIAS_JANELA_DEVOLUCOES * 24 * 60 * 60 * 1000).toISOString();
    const ate = new Date().toISOString();
    const devolucoesPorPedido = await buscarDevolucoesPeriodo(conta, desde, ate);

    let atualizados = 0;
    for (const [orderId, info] of Object.entries(devolucoesPorPedido)) {
      const idUnico = `mercado_livre:${orderId}`;
      const marcou = await marcarDevolucao(idUnico, {
        claimId: info.claim_id,
        status: info.status,
        reasonId: info.reason_id,
      });
      if (marcou) atualizados++;
    }
    return atualizados;
  } catch (err) {
    erros.push({ fonte: `devolucoes:${conta}`, mensagem: err.message });
    return 0;
  }
}

async function enriquecerDevolucoesShopee(loja, erros) {
  try {
    const ateEpoch = Math.floor(Date.now() / 1000);
    const desdeEpoch = ateEpoch - DIAS_JANELA_DEVOLUCOES * 24 * 60 * 60;
    const devolucoesPorPedido = await buscarDevolucoesShopeePorPedido(loja, desdeEpoch, ateEpoch);

    let atualizados = 0;
    for (const [orderSn, info] of Object.entries(devolucoesPorPedido)) {
      const idUnico = `shopee:${orderSn}`;
      const marcou = await marcarDevolucao(idUnico, {
        claimId: info.return_sn,
        status: info.status,
        reasonId: info.reason,
      });
      if (marcou) atualizados++;
    }
    return atualizados;
  } catch (err) {
    erros.push({ fonte: `devolucoes_shopee:${loja}`, mensagem: err.message });
    return 0;
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

  const ultimaExecucao = await kvGet('entrega_turbo:ultima_execucao_ts');
  const agora = Date.now();
  if (ultimaExecucao && agora - ultimaExecucao < INTERVALO_MINIMO_MS) {
    res.status(200).json({
      ok: true,
      pulado: true,
      motivo: `Última execução há ${Math.round((agora - ultimaExecucao) / 1000)}s, mínimo é ${INTERVALO_MINIMO_MS / 1000}s.`,
    });
    return;
  }
  await kvSet('entrega_turbo:ultima_execucao_ts', agora);

  const erros = [];

  // -------- Shopee: throttle próprio, roda no máximo a cada 15 min --------
  const ultimaExecucaoShopee = await kvGet('entrega_turbo:ultima_execucao_shopee_ts');
  const deveRodarShopee = !ultimaExecucaoShopee || (agora - ultimaExecucaoShopee >= INTERVALO_MINIMO_SHOPEE_MS);

  let totalShopeeTurbo = null; // null = não rodou nesta execução

  if (deveRodarShopee) {
    await kvSet('entrega_turbo:ultima_execucao_shopee_ts', agora);

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
    await kvSet('entrega_turbo:ultima_coleta', resultado);
    totalShopeeTurbo = resultado.total;

    try {
      await registrarNoHistoricoTurbo(pedidosUnificados, (pedido) => ({
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

    for (const loja of LOJAS_SHOPEE) {
      await coletarNovosParaHistoricoTodosShopee(loja, erros);
    }
  }

  // -------- Mercado Livre: roda toda vez (não usa proxy, sem limite de cota) --------
  for (const conta of Object.keys(SELLER_IDS)) {
    await coletarNovosFlex(conta, erros);
  }
  await reverificarPendentesFlex(erros);

  const pedidosFlexAtuais = await listarRecentes(HORAS_JANELA_FLEX);
  const resultadoFlex = {
    atualizado_em: new Date().toISOString(),
    pedidos: pedidosFlexAtuais,
    total: pedidosFlexAtuais.length,
    entregues: pedidosFlexAtuais.filter((p) => p.categoria === 'entregue').length,
    coletados_nao_entregues: pedidosFlexAtuais.filter((p) => p.categoria === 'coletado').length,
    aguardando_coleta: pedidosFlexAtuais.filter((p) => (p.categoria || 'aguardando') === 'aguardando').length,
  };
  await kvSet('entrega_turbo:ultima_coleta_flex', resultadoFlex);

  // -------- Todos os pedidos (ML): throttle próprio, roda no máximo a cada 5 min --------
  const ultimaExecucaoTodosML = await kvGet('entrega_turbo:ultima_execucao_todos_ml_ts');
  const deveRodarTodosML = !ultimaExecucaoTodosML || (agora - ultimaExecucaoTodosML >= INTERVALO_MINIMO_TODOS_ML_MS);
  if (deveRodarTodosML) {
    await kvSet('entrega_turbo:ultima_execucao_todos_ml_ts', agora);
    for (const conta of Object.keys(SELLER_IDS)) {
      await coletarNovosParaHistoricoTodos(conta, erros);
    }
  }

  // -------- Devoluções: enriquece pedidos já coletados, throttle próprio --------
  const ultimaExecucaoDevolucoes = await kvGet('entrega_turbo:ultima_execucao_devolucoes_ts');
  const deveRodarDevolucoes = !ultimaExecucaoDevolucoes || (agora - ultimaExecucaoDevolucoes >= INTERVALO_MINIMO_DEVOLUCOES_MS);
  if (deveRodarDevolucoes) {
    await kvSet('entrega_turbo:ultima_execucao_devolucoes_ts', agora);
    for (const conta of Object.keys(SELLER_IDS)) {
      await enriquecerDevolucoes(conta, erros);
    }
    for (const loja of LOJAS_SHOPEE) {
      await enriquecerDevolucoesShopee(loja, erros);
    }
  }

  // Se a Shopee não rodou nesta execução, mantém o último total conhecido
  // (lido do banco) em vez de reportar 0 — evita a falsa impressão de que
  // a coleta zerou só porque essa execução pulou a Shopee de propósito.
  if (totalShopeeTurbo === null) {
    const ultimaColetaSalva = await kvGet('entrega_turbo:ultima_coleta');
    totalShopeeTurbo = (ultimaColetaSalva && ultimaColetaSalva.total) || 0;
  }

  res.status(200).json({
    ok: true,
    total_coletado: totalShopeeTurbo,
    total_coletado_flex: resultadoFlex.total,
    shopee_rodou_nesta_execucao: deveRodarShopee,
    erros,
  });
};
