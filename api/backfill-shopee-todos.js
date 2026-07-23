// api/backfill-shopee-todos.js
// Preenche retroativamente o histórico geral ("Todos os pedidos") da
// Shopee, chamando a API diretamente — mesmo espírito do
// api/backfill-flex-api.js (Mercado Livre), mas adaptado à paginação da
// Shopee, que usa CURSOR (string opaca) em vez de offset numérico.
//
// Processa DIA A DIA (mesmo motivo do backfill do ML: manter cada consulta
// pequena e rápida, evitando timeout com volumes grandes).
//
// Uso (chamar repetidamente com os valores de next_dia/next_offset
// retornados — aqui "offset" é reaproveitado para carregar o cursor da
// Shopee, string ou vazio — até vir "done": true):
//   /api/backfill-shopee-todos?secret=SEU_SECRET&conta=thapets&dias=30&dia=0&offset=

const { buscarPedidosPeriodo, buscarDetalhesCompletos, montarPedidoGenericoShopee } = require('../lib/shopeeOrders');
const { registrarHistoricoTodos } = require('../lib/historicoTodos');

const LIMITE_TEMPO_MS = 8000;
const PAGINA_TAMANHO = 50;
const PAUSA_ENTRE_CHAMADAS_MS = 150;

module.exports = async (req, res) => {
  const inicio = Date.now();
  const cronSecret = process.env.CRON_SECRET;
  const hasValidSecret = cronSecret && req.query.secret === cronSecret;
  if (!hasValidSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const loja = req.query.conta;
  const dias = parseInt(req.query.dias, 10) || 30;
  let diaAtual = parseInt(req.query.dia, 10) || 0;
  // Reaproveita o parâmetro "offset" da tela de backfill para carregar o
  // cursor da Shopee (string). Vazio/ausente = começo do dia.
  let cursorNoDia = req.query.offset && req.query.offset !== '0' ? req.query.offset : '';

  if (!loja) {
    res.status(400).json({ error: 'Informe ?conta=ricapet ou ?conta=thapets' });
    return;
  }

  const hoje = new Date();
  const inicioJanela = new Date(hoje);
  inicioJanela.setDate(inicioJanela.getDate() - dias);
  inicioJanela.setHours(0, 0, 0, 0);

  function limitesDoDiaEpoch(indice) {
    const de = new Date(inicioJanela);
    de.setDate(de.getDate() + indice);
    const ate = new Date(de);
    ate.setDate(ate.getDate() + 1);
    const ateFinal = ate > hoje ? hoje : ate;
    return { desdeEpoch: Math.floor(de.getTime() / 1000), ateEpoch: Math.floor(ateFinal.getTime() / 1000) };
  }

  try {
    const pedidosParaGravar = [];
    let processadosNestaExecucao = 0;
    let diasProcessados = 0;

    while (Date.now() - inicio < LIMITE_TEMPO_MS) {
      if (diaAtual >= dias) break;

      const { desdeEpoch, ateEpoch } = limitesDoDiaEpoch(diaAtual);
      const pagina = await buscarPedidosPeriodo(loja, desdeEpoch, ateEpoch, cursorNoDia || undefined, PAGINA_TAMANHO);

      if (pagina.results.length === 0) {
        diaAtual++;
        cursorNoDia = '';
        diasProcessados++;
        continue;
      }

      const orderSnList = pagina.results.map((p) => p.order_sn);
      const detalhes = await buscarDetalhesCompletos(loja, orderSnList);
      for (const pedido of detalhes) {
        pedidosParaGravar.push(montarPedidoGenericoShopee(loja, pedido));
      }
      processadosNestaExecucao += pagina.results.length;

      if (!pagina.more || !pagina.nextCursor) {
        diaAtual++;
        cursorNoDia = '';
        diasProcessados++;
      } else {
        cursorNoDia = pagina.nextCursor;
      }

      // Pequena pausa entre chamadas à API da Shopee, para não estourar rate limit
      await new Promise((r) => setTimeout(r, PAUSA_ENTRE_CHAMADAS_MS));
    }

    const { gravados } = await registrarHistoricoTodos(pedidosParaGravar);
    const done = diaAtual >= dias;

    res.status(200).json({
      ok: true,
      done,
      dia_atual: diaAtual,
      offset_no_dia: cursorNoDia || 0,
      dias_totais: dias,
      next_dia: done ? null : diaAtual,
      next_offset: done ? null : cursorNoDia,
      dias_processados_nesta_execucao: diasProcessados,
      processados_nesta_execucao: processadosNestaExecucao,
      gravados_nesta_execucao: gravados,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
