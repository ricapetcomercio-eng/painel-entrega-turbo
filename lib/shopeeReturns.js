// lib/shopeeReturns.js
// Busca devoluções da Shopee e identifica quais são devoluções DE VERDADE
// (não só um pedido de devolução que foi cancelado/retirado).
//
// Confirmado com dados reais: status "CANCELLED" significa que o PEDIDO
// DE DEVOLUÇÃO foi cancelado/retirado — ou seja, não houve devolução de
// fato. Qualquer outro status (ex: "PROCESSING", "JUDGING", e
// provavelmente "REFUNDED"/"CLOSED" que ainda não vimos numa amostra
// real) é tratado como devolução em andamento ou concluída.
//
// ⚠️ A API limita create_time_from/create_time_to a no máximo 15 dias
// por chamada (confirmado pelo próprio erro da API) — por isso, pra
// cobrir um período maior, quebramos em pedaços de 15 dias.

const { shopeeGet } = require('./shopeeAuth');

const JANELA_MAXIMA_DIAS = 15;

function retornoEhDevolucaoValida(retorno) {
  return retorno.status !== 'CANCELLED';
}

async function buscarDevolucoesPagina(loja, createTimeFrom, createTimeTo, pageNo) {
  const data = await shopeeGet(loja, '/api/v2/returns/get_return_list', {
    page_no: pageNo,
    page_size: 100,
    create_time_from: createTimeFrom,
    create_time_to: createTimeTo,
  });
  const resposta = data.response || {};
  return {
    resultados: resposta.return || [],
    more: !!resposta.more,
  };
}

async function buscarDevolucoesJanela(loja, createTimeFrom, createTimeTo) {
  let pagina = 1;
  let mais = true;
  const todos = [];
  while (mais) {
    const { resultados, more } = await buscarDevolucoesPagina(loja, createTimeFrom, createTimeTo, pagina);
    todos.push(...resultados);
    mais = more;
    pagina++;
    if (pagina > 20) break; // segurança contra loop infinito
  }
  return todos;
}

/**
 * Busca devoluções num período (qualquer duração), quebrando em pedaços
 * de no máximo 15 dias por causa do limite da API. Retorna um mapa
 * { order_sn: infoDevolucao }.
 */
async function buscarDevolucoesPorPedido(loja, desdeEpoch, ateEpoch) {
  const porPedido = {};
  let inicioJanela = desdeEpoch;

  while (inicioJanela < ateEpoch) {
    const fimJanela = Math.min(inicioJanela + JANELA_MAXIMA_DIAS * 24 * 60 * 60, ateEpoch);
    const resultados = await buscarDevolucoesJanela(loja, inicioJanela, fimJanela);

    for (const r of resultados) {
      if (!retornoEhDevolucaoValida(r)) continue;
      porPedido[r.order_sn] = {
        return_sn: r.return_sn,
        status: r.status,
        reason: r.reason || null,
        refund_amount: r.refund_amount,
        create_time: r.create_time,
      };
    }

    inicioJanela = fimJanela;
  }

  return porPedido;
}

module.exports = { buscarDevolucoesPorPedido, retornoEhDevolucaoValida };
