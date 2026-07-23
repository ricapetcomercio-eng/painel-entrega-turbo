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
const { getDb } = require('../lib/db');

const TABELAS_SQL = [
  `CREATE TABLE IF NOT EXISTS kv_simples (
    chave TEXT PRIMARY KEY,
    valor TEXT,
    atualizado_em INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS shopee_tokens (
    loja TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    shop_id TEXT,
    expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS ml_tokens (
    conta TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    user_id TEXT,
    expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS historico_flex (
    id_unico TEXT PRIMARY KEY,
    marketplace TEXT,
    conta TEXT,
    order_id TEXT,
    date_created TEXT,
    date_created_ts INTEGER,
    total_amount REAL,
    shipment_id TEXT,
    coletado INTEGER,
    categoria TEXT,
    status_envio TEXT,
    coletado_em TEXT,
    entregue_em TEXT,
    horas_ate_coleta REAL,
    horas_ate_entrega REAL,
    itens TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_historico_flex_data ON historico_flex(date_created_ts)`,
  `CREATE TABLE IF NOT EXISTS historico_todos (
    id_unico TEXT PRIMARY KEY,
    marketplace TEXT,
    conta TEXT,
    order_id TEXT,
    date_created TEXT,
    date_created_ts INTEGER,
    total_amount REAL,
    forma_entrega TEXT,
    status_envio TEXT,
    status_pedido TEXT,
    cancelado INTEGER,
    estado TEXT,
    cidade TEXT,
    categoria TEXT,
    coletado INTEGER,
    coletado_em TEXT,
    entregue_em TEXT,
    horas_ate_coleta REAL,
    horas_ate_entrega REAL,
    prazo_entrega TEXT,
    atrasado INTEGER,
    devolvido INTEGER,
    devolucao_claim_id TEXT,
    devolucao_status TEXT,
    devolucao_reason_id TEXT,
    itens TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_historico_todos_data ON historico_todos(date_created_ts)`,
  `CREATE TABLE IF NOT EXISTS historico_turbo (
    id_unico TEXT PRIMARY KEY,
    marketplace TEXT,
    conta TEXT,
    order_id TEXT,
    date_created TEXT,
    date_created_ts INTEGER,
    total_amount REAL,
    estado TEXT,
    cidade TEXT,
    itens TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_historico_turbo_data ON historico_turbo(date_created_ts)`,
];

async function debugCriarTabelas(req, res) {
  const db = getDb();
  const criadas = [];
  for (const sql of TABELAS_SQL) {
    await db.execute(sql);
    criadas.push(sql.split('\n')[0].trim());
  }
  res.status(200).json({ ok: true, tipo: 'criar-tabelas', comandos_executados: criadas.length, detalhe: criadas });
}

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

  // ⚠️ Tentativa — a doc pública não confirma os parâmetros obrigatórios
  // desse endpoint. "page_size" sozinho deu "parse data failed", então
  // aqui testamos acrescentando intervalo de data + página, que é o
  // padrão mais comum em APIs de listagem da Shopee (ex: get_order_list).
  // ⚠️ Confirmado pela própria API: no máximo 15 dias entre
  // create_time_from e create_time_to.
  const dias = Math.min(parseInt(req.query.dias, 10) || 15, 15);
  const createTimeFrom = Math.floor((Date.now() - dias * 24 * 60 * 60 * 1000) / 1000);
  const createTimeTo = Math.floor(Date.now() / 1000);

  try {
    const dados = await shopeeGet(loja, '/api/v2/returns/get_return_list', {
      page_no: 1,
      page_size: 20,
      create_time_from: createTimeFrom,
      create_time_to: createTimeTo,
    });
    res.status(200).json({ ok: true, tipo: 'shopee-returns', loja, resposta_bruta: dados });
  } catch (err) {
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
    if (req.query.tipo === 'criar-tabelas') return await debugCriarTabelas(req, res);
    res.status(400).json({ error: 'Use ?tipo=ml-claims, ?tipo=shopee-returns ou ?tipo=criar-tabelas' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
