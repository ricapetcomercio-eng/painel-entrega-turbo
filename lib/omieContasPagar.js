// lib/omieContasPagar.js
// Projeção Financeira (Saídas): soma, por dia de vencimento, os títulos em
// aberto (status_titulo diferente de "PAGO") na API de Contas a Pagar do
// Omie — confirmado por teste manual (endpoint de debug
// api/debug.js?tipo=omie-contas-pagar-test) que:
//   - filtrar_por_data_de/ate filtra por data_vencimento (não emissão).
//   - status_titulo vem como "PAGO", "A VENCER" (visto) e provavelmente
//     "VENCIDO" (não visto na amostra, mas documentado pela Omie) — os dois
//     últimos ainda representam dinheiro que vai sair da conta, então ambos
//     contam; só "PAGO" é excluído.
//   - Omie trata Ricapet e Thapets como contas/apps separados (OMIE_<CONTA>_
//     APP_KEY/_APP_SECRET), mesmo padrão do Mercado Pago/Shopee neste repo.
//
// Chamado sob demanda (botão "Atualizar agora" em projecao-financeira.html),
// nunca no cron automático — mesmo motivo do Mercado Pago/Shopee (ver
// CLAUDE.md): dado não precisa estar sempre fresco.

const CONTAS = ['ricapet', 'thapets'];
const HORIZONTE_DIAS = 45;
const REGISTROS_POR_PAGINA = 100;
// Trava de segurança: no máximo 2.000 títulos por conta/execução. Medido em
// produção: ~100-150 títulos totais por conta num período de 4 meses, a
// maioria já PAGO — o volume realmente em aberto dentro de HORIZONTE_DIAS é
// bem menor que isso. Generoso o suficiente sem risco de rodar sem fim.
const MAX_PAGINAS = 20;

function getOmieConfig(conta) {
  if (!CONTAS.includes(conta)) {
    throw new Error(`Conta Omie inválida: ${conta}. Use 'ricapet' ou 'thapets'.`);
  }
  const prefix = `OMIE_${conta.toUpperCase()}`;
  const appKey = process.env[`${prefix}_APP_KEY`];
  const appSecret = process.env[`${prefix}_APP_SECRET`];
  if (!appKey || !appSecret) {
    throw new Error(`Faltam variáveis de ambiente ${prefix}_APP_KEY / ${prefix}_APP_SECRET.`);
  }
  return { appKey, appSecret };
}

function fmtDataOmie(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Omie devolve datas como "DD/MM/AAAA" — converte pra "AAAA-MM-DD", mesmo
// formato de chave usado em por_dia no Mercado Pago/Shopee. Diferente do
// money_release_date do Mercado Pago, aqui não tem fuso horário envolvido
// (é uma data de calendário, sem hora), então não precisa de dataFusoLoja.
function dataOmieParaChave(dataOmie) {
  const [dd, mm, aaaa] = dataOmie.split('/');
  return `${aaaa}-${mm}-${dd}`;
}

/**
 * Busca e agrega, por dia de vencimento, os títulos em aberto (não pagos)
 * entre agora e HORIZONTE_DIAS à frente.
 * @param {'ricapet'|'thapets'} conta
 */
async function coletarContasPagar(conta) {
  const { appKey, appSecret } = getOmieConfig(conta);

  const agora = new Date();
  const futuro = new Date(agora.getTime() + HORIZONTE_DIAS * 24 * 60 * 60 * 1000);

  const porDiaMap = new Map(); // 'AAAA-MM-DD' -> { total, qtd }
  let totalAPagar = 0;
  let totalTitulos = 0;
  let truncado = false;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const resp = await fetch('https://app.omie.com/api/v1/financas/contapagar/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call: 'ListarContasPagar',
        app_key: appKey,
        app_secret: appSecret,
        param: [{
          pagina,
          registros_por_pagina: REGISTROS_POR_PAGINA,
          apenas_importado_api: 'N',
          filtrar_por_data_de: fmtDataOmie(agora),
          filtrar_por_data_ate: fmtDataOmie(futuro),
        }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Erro Omie (${conta}): ${JSON.stringify(data)}`);
    }

    const titulos = data.conta_pagar_cadastro || [];
    for (const t of titulos) {
      if (t.status_titulo === 'PAGO') continue;
      if (!t.data_vencimento) continue;
      const diaStr = dataOmieParaChave(t.data_vencimento);
      const atual = porDiaMap.get(diaStr) || { total: 0, qtd: 0 };
      atual.total += t.valor_documento || 0;
      atual.qtd += 1;
      porDiaMap.set(diaStr, atual);
      totalAPagar += t.valor_documento || 0;
      totalTitulos += 1;
    }

    const totalPaginas = data.total_de_paginas || 0;
    if (pagina >= totalPaginas || titulos.length === 0) break;
    if (pagina === MAX_PAGINAS) truncado = true;
  }

  const porDia = Array.from(porDiaMap.entries())
    .map(([data, v]) => ({ data, total: Math.round(v.total * 100) / 100, qtd: v.qtd }))
    .sort((a, b) => (a.data < b.data ? -1 : 1));

  return {
    atualizado_em: new Date().toISOString(),
    horizonte_dias: HORIZONTE_DIAS,
    total_a_pagar: Math.round(totalAPagar * 100) / 100,
    total_titulos: totalTitulos,
    por_dia: porDia,
    truncado,
    erro: null,
  };
}

module.exports = { coletarContasPagar, CONTAS, HORIZONTE_DIAS };
