// lib/mpProjecao.js
// Projeção Financeira: soma, por dia, o dinheiro que o Mercado Pago vai
// liberar nos próximos dias (campo `money_release_date` de cada pagamento
// — confirmado por teste manual que pode vir com data futura, ver
// CLAUDE.md/histórico da sessão que criou isso).
//
// Chamado 1x/dia por api/collect.js (dado não muda rápido o suficiente
// pra precisar de mais que isso — decisão do dono do projeto).

const { getMPAccessToken } = require('./mpAuth');
const { dataFusoLoja } = require('./registrosPonto');

const HORIZONTE_DIAS = 45;
const TAMANHO_PAGINA = 100;
// Trava de segurança: no máximo 30.000 pagamentos por conta/execução.
// Medido em produção via /api/debug?tipo=mp-payments-test: a conta Ricapet
// tem ~11.500 pagamentos aprovados num período de 75 dias (~150/dia) — com
// o filtro status=approved (ver abaixo) já aplicado na própria consulta à
// API, 10.000 (limite anterior) ainda podia estourar em dias de pico de
// liberação concentrada. 30.000 cobre com folga confortável.
const MAX_PAGINAS = 300;

function formatarDataMP(d) {
  return d.toISOString().slice(0, 19) + '.000-00:00';
}

/**
 * Busca e agrega, por dia, os pagamentos com `money_release_date` entre
 * agora e HORIZONTE_DIAS à frente. Só conta pagamentos com status
 * "approved" (dinheiro de verdade a caminho — refunded/cancelled não).
 * @param {'ricapet'|'thapets'} conta
 */
async function coletarProjecaoFinanceira(conta) {
  const accessToken = await getMPAccessToken(conta);

  const agora = new Date();
  const futuro = new Date(agora.getTime() + HORIZONTE_DIAS * 24 * 60 * 60 * 1000);

  const porDiaMap = new Map(); // 'YYYY-MM-DD' -> { total, qtd }
  let totalAReceber = 0;
  let totalPagamentos = 0;
  let offset = 0;
  let truncado = false;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const params = new URLSearchParams({
      range: 'money_release_date',
      begin_date: formatarDataMP(agora),
      end_date: formatarDataMP(futuro),
      sort: 'money_release_date',
      criteria: 'asc',
      limit: String(TAMANHO_PAGINA),
      offset: String(offset),
      // Filtrar por status na própria consulta (em vez de só no loop abaixo)
      // reduz o total de páginas — confirmado por teste manual que sobra
      // volume relevante de pagamentos não-aprovados (refunded, etc.) no
      // mesmo período de money_release_date.
      status: 'approved',
    });
    const resp = await fetch(`https://api.mercadopago.com/v1/payments/search?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Erro Mercado Pago (${conta}): ${JSON.stringify(data)}`);
    }

    const resultados = data.results || [];
    for (const p of resultados) {
      if (p.status !== 'approved') continue;
      if (!p.money_release_date) continue;
      // O Mercado Pago devolve money_release_date no fuso deles (ex.:
      // -04:00), não no fuso da loja (Brasil, -03:00 fixo) — recortar a
      // string crua (.slice(0,10)) jogava pagamentos de fim de dia pro dia
      // errado. dataFusoLoja converte pro dia certo no fuso de São Paulo,
      // mesmo helper já usado pro Ponto/Bipagem (lib/registrosPonto.js).
      const diaStr = dataFusoLoja(p.money_release_date);
      // transaction_amount é o valor bruto (antes das taxas do Mercado
      // Pago) — confirmado por teste manual que o valor de fato depositado
      // é transaction_details.net_received_amount, bem menor em pagamentos
      // parcelados/financiados (fee_details.financing_fee). Usar o bruto
      // inflava a projeção bem acima do que o painel real do MP mostra.
      const valor = (p.transaction_details && typeof p.transaction_details.net_received_amount === 'number')
        ? p.transaction_details.net_received_amount
        : (p.transaction_amount || 0);
      const atual = porDiaMap.get(diaStr) || { total: 0, qtd: 0 };
      atual.total += valor;
      atual.qtd += 1;
      porDiaMap.set(diaStr, atual);
      totalAReceber += valor;
      totalPagamentos += 1;
    }

    offset += TAMANHO_PAGINA;
    const totalGeral = (data.paging && data.paging.total) || 0;
    if (offset >= totalGeral || resultados.length === 0) break;
    if (pagina === MAX_PAGINAS - 1) truncado = true;
  }

  const porDia = Array.from(porDiaMap.entries())
    .map(([data, v]) => ({ data, total: Math.round(v.total * 100) / 100, qtd: v.qtd }))
    .sort((a, b) => (a.data < b.data ? -1 : 1));

  return {
    atualizado_em: new Date().toISOString(),
    horizonte_dias: HORIZONTE_DIAS,
    total_a_receber: Math.round(totalAReceber * 100) / 100,
    total_pagamentos: totalPagamentos,
    por_dia: porDia,
    truncado,
    erro: null,
  };
}

module.exports = { coletarProjecaoFinanceira, HORIZONTE_DIAS };
