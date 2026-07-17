// lib/mlClaims.js
// Busca reclamações (claims) do Mercado Livre e identifica quais são
// DEVOLUÇÕES DE VERDADE (produto físico voltando), não só mediação/disputa
// sem devolução.
//
// Como diferenciar (confirmado com dados reais de conta): claims que têm,
// entre as available_actions de algum player, alguma ação do tipo
// "return_review_*" são as que envolvem devolução física. Claims sem
// nenhuma dessas ações (só "open_dispute", "send_message_to_complainant",
// "refund" etc) são mediação/disputa SEM devolução de produto.
//
// ⚠️ Isso foi inferido a partir de uma amostra real, não documentado
// oficialmente pelo Mercado Livre — se aparecerem falsos positivos ou
// negativos com o tempo, ajustar a lista ACOES_DEVOLUCAO abaixo.

const { getMLAccessToken } = require('./mlAuth');

const ACOES_DEVOLUCAO = ['return_review_ok', 'return_review_fail', 'return_review_unified_ok', 'return_review_unified_fail'];

async function mlFetch(path, accessToken) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Erro ML ${path} (${resp.status}): ${JSON.stringify(data)}`);
  return data;
}

async function buscarClaimsPeriodo(conta, desdeISO, ateISO, status) {
  const accessToken = await getMLAccessToken(conta);
  const data = await mlFetch(
    `/post-purchase/v1/claims/search?status=${status}&range=date_created:after:${encodeURIComponent(desdeISO)},before:${encodeURIComponent(ateISO)}`,
    accessToken
  );
  return data.data || [];
}

function claimEhDevolucao(claim) {
  const players = claim.players || [];
  return players.some((p) => (p.available_actions || []).some((a) => ACOES_DEVOLUCAO.includes(a.action)));
}

/**
 * Busca todas as devoluções (claims com ação de devolução) num período,
 * cobrindo claims abertos E fechados (a API exige um filtro de status,
 * então faz as duas buscas e junta o resultado).
 * Retorna um mapa { order_id: infoDevolucao }.
 */
async function buscarDevolucoesPeriodo(conta, desdeISO, ateISO) {
  const [abertos, fechados] = await Promise.all([
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'opened'),
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'closed'),
  ]);

  const todos = [...abertos, ...fechados];
  const devolucoes = todos.filter(claimEhDevolucao);

  const porPedido = {};
  for (const c of devolucoes) {
    porPedido[c.resource_id] = {
      claim_id: c.id,
      status: c.status,
      stage: c.stage,
      reason_id: c.reason_id || null,
      date_created: c.date_created,
      last_updated: c.last_updated,
    };
  }
  return porPedido;
}

module.exports = { buscarDevolucoesPeriodo, claimEhDevolucao, ACOES_DEVOLUCAO };
