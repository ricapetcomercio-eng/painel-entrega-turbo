// api/backfill-todos-api.js
// Preenche o histórico com TODOS os pedidos (qualquer forma de entrega)
// chamando a API do Mercado Livre diretamente. Mesma lógica de "processar
// aos poucos" do backfill-flex-api.js — chame repetidamente com o
// next_offset retornado, até vir "done": true.
//
// Uso:
//   /api/backfill-todos-api?secret=SEU_SECRET&conta=ricapet&dias=30&offset=0

const { getRedis } = require('../lib/redis');
const { buscarPedidosPeriodo, buscarDetalhesShipment, montarPedidoGenerico } = require('../lib/mlAllOrders');
const { registrarHistoricoTodos } = require('../lib/historicoTodos');

const LIMITE_TEMPO_MS = 8000;
const PAGINA_TAMANHO = 50;

module.exports = async (req, res) => {
  const inicio = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  const hasValidSecret = cronSecret && req.query.secret === cronSecret;
  if (!hasValidSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const conta = req.query.conta;
  const dias = parseInt(req.query.dias, 10) || 30;
  const offset = parseInt(req.query.offset, 10) || 0;

  if (!conta) {
    res.status(400).json({ error: 'Informe ?conta=ricapet ou ?conta=thapets' });
    return;
  }

  const redis = getRedis();
  const ate = new Date();
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);

  try {
    let offsetAtual = offset;
    let totalGeral = null;
    const pedidosParaGravar = [];
    let processadosNestaExecucao = 0;

    while (Date.now() - inicio < LIMITE_TEMPO_MS) {
      const pagina = await buscarPedidosPeriodo(
        conta,
        desde.toISOString(),
        ate.toISOString(),
        offsetAtual,
        PAGINA_TAMANHO
      );
      if (totalGeral === null) totalGeral = pagina.total;

      if (pagina.results.length === 0) {
        offsetAtual = totalGeral;
        break;
      }

      for (const pedido of pagina.results) {
        if (Date.now() - inicio >= LIMITE_TEMPO_MS) break;

        const shipmentId = pedido.shipping && pedido.shipping.id;
        const detalhes = await buscarDetalhesShipment(conta, shipmentId);
        offsetAtual++;
        processadosNestaExecucao++;

        pedidosParaGravar.push(montarPedidoGenerico(conta, pedido, shipmentId, detalhes));
      }
    }

    const { gravados } = await registrarHistoricoTodos(redis, pedidosParaGravar);
    const done = totalGeral !== null && offsetAtual >= totalGeral;

    res.status(200).json({
      ok: true,
      done,
      total_estimado: totalGeral,
      offset_processado_ate: offsetAtual,
      next_offset: done ? null : offsetAtual,
      processados_nesta_execucao: processadosNestaExecucao,
      gravados_nesta_execucao: gravados,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
