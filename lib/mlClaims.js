// lib/mlClaims.js
// Busca reclamações (claims) do Mercado Livre e identifica quais são
// DEVOLUÇÕES DE VERDADE (produto físico voltando), não só mediação/disputa
// sem devolução.
//
// Como diferenciar (confirmado com dados reais de conta, ver debug
// ?tipo=ml-claims-resumo): duas condições, qualquer uma basta —
//   1. `claim.type === 'returns'` — o próprio Mercado Livre já categoriza o
//      claim como devolução formal desde a criação. Esse campo SOBREVIVE ao
//      fechamento do claim, ao contrário do critério 2 abaixo.
//   2. Alguma `available_actions` de algum player tem ação "return_review_*"
//      — sinal de que o claim está na etapa de revisão da devolução.
// ⚠️ Confirmado empiricamente que o critério 2 sozinho tem um furo real: uma
// vez que o Mercado Livre FECHA o claim (status "closed"), `available_actions`
// fica vazio pra todo mundo — não sobra nenhuma ação porque o processo já
// acabou. Sem o critério 1, todo claim já resolvido virava "reclamação" na
// marra, mesmo tendo sido uma devolução física de verdade (caso real: conta
// Thapets tinha 5 claims, todos fechados, os 5 caíam como reclamação sem
// critério 1). type "returns" não garante que o produto voltou de fato
// (o vendedor pode ter vencido a disputa, "return_review_fail") — é "o
// cliente abriu uma devolução formal", não "confirmado que voltou"; ver
// `devolucao_status`/`devolucao_motivo` na tela pra conferir o desfecho.
//
// ⚠️ Isso foi inferido a partir de uma amostra real, não documentado
// oficialmente pelo Mercado Livre — se aparecerem falsos positivos ou
// negativos com o tempo, ajustar aqui.

const { getMLAccessToken } = require('./mlAuth');

const ACOES_DEVOLUCAO = ['return_review_ok', 'return_review_fail', 'return_review_unified_ok', 'return_review_unified_fail'];
const TIPOS_DEVOLUCAO = ['returns'];

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
  if (TIPOS_DEVOLUCAO.includes(claim.type)) return true;
  const players = claim.players || [];
  return players.some((p) => (p.available_actions || []).some((a) => ACOES_DEVOLUCAO.includes(a.action)));
}

/**
 * Busca TODOS os claims do período (abertos E fechados — a API exige um
 * filtro de status, então faz as duas buscas e junta o resultado) e separa
 * em dois grupos usando a mesma heurística `claimEhDevolucao`:
 *   - devolucoes: claims com ação de devolução física (produto voltando).
 *   - reclamacoes: claims de mediação/disputa que NUNCA viraram devolução
 *     física (aberto pelo cliente, mas sem produto retornando) — antes
 *     desses eram simplesmente descartados; ver `enriquecerDevolucoes` em
 *     api/collect.js e `marcarReclamacao` em lib/historicoTodos.js.
 * Faz uma única rodada de chamadas (2 por conta: opened+closed) pra cobrir
 * os dois grupos — não dobra o custo de API/CPU em relação à busca antiga
 * de só devolução.
 * Retorna { devolucoes: {order_id: info}, reclamacoes: {order_id: info} }.
 */
async function buscarClaimsClassificadosPeriodo(conta, desdeISO, ateISO) {
  const [abertos, fechados] = await Promise.all([
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'opened'),
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'closed'),
  ]);

  const devolucoes = {};
  const reclamacoes = {};
  for (const c of [...abertos, ...fechados]) {
    const info = {
      claim_id: c.id,
      status: c.status,
      stage: c.stage,
      reason_id: c.reason_id || null,
      tipo: c.type || null,
      date_created: c.date_created,
      last_updated: c.last_updated,
    };
    if (claimEhDevolucao(c)) devolucoes[c.resource_id] = info;
    else reclamacoes[c.resource_id] = info;
  }
  return { devolucoes, reclamacoes };
}

/**
 * Diagnóstico — NÃO usado pelo cron, só pelo endpoint de debug
 * (`?tipo=ml-claims-resumo`). Resolve a dúvida "por que devolução nunca
 * aparece?" sem precisar despejar a resposta bruta inteira (que pode ter
 * centenas de claims aninhados): conta quantos claims existem no período,
 * quantos a heurística `claimEhDevolucao` classifica como devolução vs.
 * reclamação, e a frequência de CADA nome de `action` que aparece em
 * `available_actions` de algum player — pra confirmar se as ações
 * `ACOES_DEVOLUCAO` (`return_review_*`) realmente aparecem nos dados reais
 * da conta, ou se a lista está desatualizada/nunca bateu — e também expõe
 * `TIPOS_DEVOLUCAO` (`claim.type === 'returns'`), o critério que sobrevive
 * ao fechamento do claim (ver comentário no topo do arquivo).
 */
async function resumirClaimsPeriodo(conta, desdeISO, ateISO) {
  const [abertos, fechados] = await Promise.all([
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'opened'),
    buscarClaimsPeriodo(conta, desdeISO, ateISO, 'closed'),
  ]);
  const todos = [...abertos, ...fechados];

  const acoesVistas = {};
  let totalDevolucoes = 0;
  let totalReclamacoes = 0;
  const exemplosDevolucao = [];
  const exemplosReclamacao = [];

  for (const c of todos) {
    const ehDevolucao = claimEhDevolucao(c);
    if (ehDevolucao) { totalDevolucoes++; if (exemplosDevolucao.length < 3) exemplosDevolucao.push(c); }
    else { totalReclamacoes++; if (exemplosReclamacao.length < 3) exemplosReclamacao.push(c); }

    for (const p of c.players || []) {
      for (const a of p.available_actions || []) {
        acoesVistas[a.action] = (acoesVistas[a.action] || 0) + 1;
      }
    }
  }

  return {
    total_claims: todos.length,
    total_abertos: abertos.length,
    total_fechados: fechados.length,
    total_devolucoes: totalDevolucoes,
    total_reclamacoes: totalReclamacoes,
    tipos_esperados_devolucao: TIPOS_DEVOLUCAO,
    acoes_esperadas_devolucao: ACOES_DEVOLUCAO,
    acoes_vistas_na_conta: acoesVistas,
    exemplo_devolucao: exemplosDevolucao,
    exemplo_reclamacao: exemplosReclamacao,
  };
}

module.exports = { buscarClaimsClassificadosPeriodo, resumirClaimsPeriodo, claimEhDevolucao, ACOES_DEVOLUCAO, TIPOS_DEVOLUCAO };
