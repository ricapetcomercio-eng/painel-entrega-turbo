// api/backfill-flex-api.js
// Preenche retroativamente o histórico do Flex chamando a API do Mercado
// Livre diretamente — sem depender de upload de relatório.
//
// IMPORTANTE: a busca é feita DIA A DIA (não numa janela única de N dias),
// porque a API de busca do Mercado Livre não permite paginar (offset) além
// de ~1000 resultados numa única consulta. Processando um dia de cada vez,
// o offset dentro de cada dia fica bem menor que esse limite.
//
// Uso (chamar repetidamente com os valores de next_dia/next_offset
// retornados, até vir "done": true):
//   /api/backfill-flex-api?secret=SEU_SECRET&conta=ricapet&dias=30&dia=0&offset=0

const { getRedis } = require('../lib/redis');
const { buscarPedidosPeriodo, verificarFlex, montarPedidoFlex } = require('../lib/mlFlexOrders');
const { registrarHistoricoFlex } = require('../lib/historicoFlex');

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
  let diaAtual = parseInt(req.query.dia, 10) || 0;
  let offsetNoDia = parseInt(req.query.offset, 10) || 0;

  if (!conta) {
    res.status(400).json({ error: 'Informe ?conta=ricapet ou ?conta=thapets' });
    return;
  }

  const redis = getRedis();
  const hoje = new Date();
  const inicioJanela = new Date(hoje);
  inicioJanela.setDate(inicioJanela.getDate() - dias);
  inicioJanela.setHours(0, 0, 0, 0);

  function limitesDoDia(indice) {
    const de = new Date(inicioJanela);
    de.setDate(de.getDate() + indice);
    const ate = new Date(de);
    ate.setDate(ate.getDate() + 1);
    return { de, ate: ate > hoje ? hoje : ate };
  }

  try {
    const pedidosParaGravar = [];
    let processadosNestaExecucao = 0;
    let diasProcessados = 0;

    while (Date.now() - inicio < LIMITE_TEMPO_MS) {
      if (diaAtual >= dias) break;

      const { de, ate } = limitesDoDia(diaAtual);
      const pagina = await buscarPedidosPeriodo(conta, de.toISOString(), ate.toISOString(), offsetNoDia, PAGINA_TAMANHO);

      if (pagina.results.length === 0 || offsetNoDia >= pagina.total) {
        diaAtual++;
        offsetNoDia = 0;
        diasProcessados++;
        continue;
      }

      for (const pedido of pagina.results) {
        if (Date.now() - inicio >= LIMITE_TEMPO_MS) break;

        const shipmentId = pedido.shipping && pedido.shipping.id;
        const info = await verificarFlex(conta, shipmentId);
        offsetNoDia++;
        processadosNestaExecucao++;

        if (info) {
          pedidosParaGravar.push(montarPedidoFlex(conta, pedido, shipmentId, info));
        }

        // Pequena pausa entre chamadas à API do ML, para não estourar rate limit
        await new Promise((r) => setTimeout(r, 80));
      }
    }

    const { gravados } = await registrarHistoricoFlex(redis, pedidosParaGravar);
    const done = diaAtual >= dias;

    res.status(200).json({
      ok: true,
      done,
      dia_atual: diaAtual,
      offset_no_dia: offsetNoDia,
      dias_totais: dias,
      next_dia: done ? null : diaAtual,
      next_offset: done ? null : offsetNoDia,
      dias_processados_nesta_execucao: diasProcessados,
      processados_nesta_execucao: processadosNestaExecucao,
      gravados_nesta_execucao: gravados,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
