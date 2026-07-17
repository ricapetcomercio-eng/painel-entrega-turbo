// api/debug.js
// Rota de diagnóstico consolidada — combina várias checagens pontuais num
// único arquivo, para não gastar mais "slots" de Serverless Function no
// plano Hobby da Vercel (limite de 12 por deployment). Sempre que precisar
// de mais uma checagem rápida, adicione um novo "tipo" aqui em vez de criar
// um arquivo novo.
//
// Uso:
//   /api/debug?tipo=ml-claims&conta=ricapet&dias=30&secret=SEU_CRON_SECRET
//   /api/debug?tipo=shopee-returns&loja=thapets&secret=SEU_CRON_SECRET

const { getMLAccessToken } = require('../lib/mlAuth');
const { shopeeGet } = require('../lib/shopeeAuth');

async function mlFetch(path, accessToken) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Erro ML ${path} (${resp.status}): ${JSON.stringify(data)}`);
  return data;
}

async function debugMlClaims(req, res) {
  const conta = req.query.conta;
  const dias = parseInt(req.query.dias, 10) || 30;
  if (!conta) { res.status(400).json({ error: 'Use ?conta=ricapet ou ?conta=thapets' }); return; }

  const accessToken = await getMLAccessToken(conta);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const ate = new Date().toISOString();
  // A API rejeita buscar só por "range" — exige pelo menos mais um filtro
  // junto (o exemplo oficial usa status=opened). Buscando por "opened"
  // pega reclamações/devoluções ainda em andamento nesse período.
  const dados = await mlFetch(
    `/post-purchase/v1/claims/search?status=opened&range=date_created:after:${encodeURIComponent(desde)},before:${encodeURIComponent(ate)}`,
    accessToken
  );
  res.status(200).json({ ok: true, tipo: 'ml-claims', conta, periodo: { desde, ate }, resposta_bruta: dados });
}

async function debugShopeeReturns(req, res) {
  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) { res.status(400).json({ error: 'Use ?loja=ricapet ou ?loja=thapets' }); return; }

  try {
    const dados = await shopeeGet(loja, '/api/v2/returns/get_return_list', { page_size: 20 });
    res.status(200).json({ ok: true, tipo: 'shopee-returns', loja, resposta_bruta: dados });
  } catch (err) {
    // "fetch failed" é um erro de rede genérico do Node — expõe err.cause
    // (se existir) para saber se é problema do proxy Fixie, DNS, etc.
    throw new Error(`${err.message}${err.cause ? ' | cause: ' + JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause)) : ''}`);
  }
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.query.secret !== cronSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  try {
    if (req.query.tipo === 'ml-claims') return await debugMlClaims(req, res);
    if (req.query.tipo === 'shopee-returns') return await debugShopeeReturns(req, res);
    res.status(400).json({ error: 'Use ?tipo=ml-claims ou ?tipo=shopee-returns' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
