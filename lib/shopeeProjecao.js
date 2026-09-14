// lib/shopeeProjecao.js
// Projeção Financeira (Shopee): diferente do Mercado Pago (que informa
// money_release_date de verdade), a Shopee NÃO expõe nenhuma data de
// repasse pra pedidos ainda em aberto — confirmado empiricamente (ver
// histórico da sessão que criou isso):
//   - get_escrow_list só retorna repasses JÁ liberados (histórico).
//   - get_escrow_detail calcula o valor (escrow_amount) mesmo pra pedidos
//     ainda em aberto, mas não tem NENHUM campo de data.
// Então aqui a data é uma ESTIMATIVA (marcada com `estimativa: true` no
// retorno): pega pedidos SHIPPED/TO_CONFIRM_RECEIVE (enviados, ainda não
// confirmados pelo comprador), usa o maior entre a previsão de entrega da
// própria Shopee (edt_to) e a última atualização de status (update_time)
// como "data de entrega", soma DIAS_CONFIRMACAO_PADRAO (prazo padrão pro
// comprador confirmar o recebimento antes de liberar automaticamente) e
// usa isso como data estimada de liberação.

const { shopeeGet } = require('./shopeeAuth');

const HORIZONTE_DIAS = 45;
// Pedidos SHIPPED/TO_CONFIRM_RECEIVE mais velhos que isso já devem ter sido
// concluídos (entregues+confirmados) ou vão cair no histórico do
// get_escrow_list — não vale a pena olhar mais pra trás que isso.
const DIAS_JANELA_BUSCA = 20;
// get_order_list exige diff estritamente menor que 15 dias entre
// time_from/time_to (confirmado na prática) — divide a janela de busca em
// pedaços de 10 dias por segurança.
const DIAS_POR_PAGINA_BUSCA = 10;
// Prazo padrão da Shopee BR pro comprador confirmar o recebimento antes da
// liberação automática. É uma ASSUNÇÃO (a API não informa isso) — se a
// realidade for diferente, ajustar aqui.
const DIAS_CONFIRMACAO_PADRAO = 7;
// Trava de segurança: no máximo essa quantidade de chamadas a
// get_escrow_detail por loja/dia (1 chamada por pedido em aberto) — cada
// pedido aberto custa 1 chamada extra à API da Shopee (cota do proxy
// Fixie é limitada, ver CLAUDE.md).
const MAX_CONSULTAS_ESCROW = 300;

function diaStr(epochSec) {
  return new Date(epochSec * 1000).toISOString().slice(0, 10);
}

async function buscarOrderSnsAbertos(loja) {
  const agora = Math.floor(Date.now() / 1000);
  const janelas = [];
  for (let inicio = DIAS_JANELA_BUSCA; inicio > 0; inicio -= DIAS_POR_PAGINA_BUSCA) {
    const fim = Math.max(inicio - DIAS_POR_PAGINA_BUSCA, 0);
    janelas.push([agora - inicio * 24 * 60 * 60, agora - fim * 24 * 60 * 60]);
  }

  const orderSns = new Set();
  for (const [timeFrom, timeTo] of janelas) {
    let cursor = '';
    for (let pagina = 0; pagina < 10; pagina++) { // trava de segurança
      const params = { time_range_field: 'create_time', time_from: timeFrom, time_to: timeTo, page_size: 50 };
      if (cursor) params.cursor = cursor;
      const data = await shopeeGet(loja, '/api/v2/order/get_order_list', params);
      const resposta = data.response || {};
      (resposta.order_list || []).forEach((p) => orderSns.add(p.order_sn));
      if (!resposta.more || !resposta.next_cursor) break;
      cursor = resposta.next_cursor;
    }
  }
  return Array.from(orderSns);
}

async function buscarPedidosAbertos(loja, orderSns) {
  const abertos = [];
  for (let i = 0; i < orderSns.length; i += 50) {
    const lote = orderSns.slice(i, i + 50);
    const data = await shopeeGet(loja, '/api/v2/order/get_order_detail', {
      order_sn_list: lote.join(','),
      response_optional_fields: 'order_status,edt,update_time',
    });
    const lista = (data.response && data.response.order_list) || [];
    lista.forEach((p) => {
      if (p.order_status === 'SHIPPED' || p.order_status === 'TO_CONFIRM_RECEIVE') abertos.push(p);
    });
  }
  return abertos;
}

/**
 * @param {'ricapet'|'thapets'} loja
 */
async function coletarProjecaoFinanceiraShopee(loja) {
  const orderSns = await buscarOrderSnsAbertos(loja);
  const pedidosAbertos = orderSns.length ? await buscarPedidosAbertos(loja, orderSns) : [];

  const porDiaMap = new Map();
  let totalAReceber = 0;
  let totalPagamentos = 0;
  const consultados = pedidosAbertos.slice(0, MAX_CONSULTAS_ESCROW);

  for (const pedido of consultados) {
    let escrowAmount;
    try {
      const resp = await shopeeGet(loja, '/api/v2/payment/get_escrow_detail', { order_sn: pedido.order_sn });
      escrowAmount = resp.response && resp.response.order_income && resp.response.order_income.escrow_amount;
    } catch (e) {
      continue; // pedido sem escrow calculável ainda — ignora, não é fatal
    }
    if (!escrowAmount) continue;

    const dataEntregaEstimada = Math.max(pedido.edt_to || 0, pedido.update_time || 0) || Math.floor(Date.now() / 1000);
    const dataLiberacaoEstimada = dataEntregaEstimada + DIAS_CONFIRMACAO_PADRAO * 24 * 60 * 60;
    const diaChave = diaStr(dataLiberacaoEstimada);

    const atual = porDiaMap.get(diaChave) || { total: 0, qtd: 0 };
    atual.total += escrowAmount;
    atual.qtd += 1;
    porDiaMap.set(diaChave, atual);
    totalAReceber += escrowAmount;
    totalPagamentos += 1;
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
    estimativa: true,
    dias_confirmacao_assumido: DIAS_CONFIRMACAO_PADRAO,
    truncado: pedidosAbertos.length > MAX_CONSULTAS_ESCROW,
    erro: null,
  };
}

module.exports = { coletarProjecaoFinanceiraShopee, HORIZONTE_DIAS, DIAS_CONFIRMACAO_PADRAO };
