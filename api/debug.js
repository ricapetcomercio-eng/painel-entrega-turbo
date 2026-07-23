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
const { getRedis } = require('../lib/redis');

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

// -------- Migração única: Redis antigo (compartilhado) -> Turso --------
// Resumível: se demorar demais numa chamada só, chame de novo passando os
// cursores/offsets retornados em "proximo" — continua de onde parou.
//
// IMPORTANTE: usamos HSCAN (não HGETALL) para os hashes, e LRANGE com
// limites (não a lista inteira) — os hashes de histórico são grandes o
// bastante (dezenas de MB) para estourar o limite de 10MB por comando do
// Upstash se buscados de uma vez só.
const LIMITE_TEMPO_MIGRACAO_MS = 8000;
const TAMANHO_LOTE_MIGRACAO = 100;

function paraInteiroBooleanoMigracao(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function cursorConcluido(cursor) {
  return cursor === '0' || cursor === 0 || cursor === null || cursor === undefined;
}

async function migrarHistoricoFlex(redis, db, cursorInicial) {
  const HISTORICO_FLEX_HASH_KEY = 'entrega_turbo:historico_flex_hash';
  const [proximoCursor, elementos] = await redis.hscan(HISTORICO_FLEX_HASH_KEY, cursorInicial, { count: TAMANHO_LOTE_MIGRACAO });

  const statements = [];
  for (let i = 0; i < elementos.length; i += 2) {
    const pedido = elementos[i + 1];
    if (!pedido || typeof pedido !== 'object') continue;
    const idUnico = `mercado_livre:${pedido.order_id}`;
    const dateCreatedTs = new Date(pedido.date_created).getTime();
    const coletadoInt = paraInteiroBooleanoMigracao(pedido.coletado);
    statements.push({
      sql: `INSERT OR IGNORE INTO historico_flex (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, shipment_id, coletado, categoria, coletado_em, entregue_em,
              horas_ate_coleta, horas_ate_entrega, itens
            ) VALUES (?, 'mercado_livre', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        idUnico, pedido.conta || null, String(pedido.order_id), pedido.date_created, dateCreatedTs,
        pedido.total_amount, pedido.shipment_id || null, coletadoInt, pedido.categoria || null,
        pedido.coletado_em || null, pedido.entregue_em || null,
        typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
        typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  if (statements.length > 0) await db.batch(statements, 'write');
  return { processados: elementos.length / 2, proximo_cursor: proximoCursor, concluido: cursorConcluido(proximoCursor) };
}

async function migrarHistoricoTodos(redis, db, cursorInicial) {
  const HISTORICO_TODOS_HASH_KEY = 'entrega_turbo:historico_todos_hash';
  const [proximoCursor, elementos] = await redis.hscan(HISTORICO_TODOS_HASH_KEY, cursorInicial, { count: TAMANHO_LOTE_MIGRACAO });

  const statements = [];
  for (let i = 0; i < elementos.length; i += 2) {
    const pedido = elementos[i + 1];
    if (!pedido || typeof pedido !== 'object') continue;
    const marketplace = pedido.marketplace || 'mercado_livre';
    const idUnico = `${marketplace}:${pedido.order_id}`;
    const dateCreatedTs = new Date(pedido.date_created).getTime();
    statements.push({
      sql: `INSERT OR IGNORE INTO historico_todos (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, forma_entrega, status_envio, status_pedido, cancelado,
              estado, cidade, categoria, coletado, coletado_em, entregue_em,
              horas_ate_coleta, horas_ate_entrega, prazo_entrega, atrasado,
              devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id, itens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        idUnico, marketplace, pedido.conta || null, String(pedido.order_id), pedido.date_created, dateCreatedTs,
        pedido.total_amount, pedido.forma_entrega || 'Não identificado', pedido.status_envio || null,
        pedido.status_pedido || null, paraInteiroBooleanoMigracao(pedido.cancelado) || 0,
        pedido.estado || null, pedido.cidade || null, pedido.categoria || null,
        paraInteiroBooleanoMigracao(pedido.coletado),
        pedido.coletado_em || null, pedido.entregue_em || null,
        typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
        typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
        pedido.prazo_entrega || null,
        paraInteiroBooleanoMigracao(pedido.atrasado),
        paraInteiroBooleanoMigracao(pedido.devolvido) || 0,
        pedido.devolucao_claim_id || null, pedido.devolucao_status || null, pedido.devolucao_reason_id || null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  if (statements.length > 0) await db.batch(statements, 'write');
  return { processados: elementos.length / 2, proximo_cursor: proximoCursor, concluido: cursorConcluido(proximoCursor) };
}

async function migrarHistoricoTurbo(redis, db, offsetInicial) {
  const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
  // LRANGE com limites — nunca busca a lista inteira de uma vez, evitando
  // o mesmo estouro de tamanho que os hashes tiveram.
  const lote = await redis.lrange(HISTORICO_KEY, offsetInicial, offsetInicial + TAMANHO_LOTE_MIGRACAO - 1);
  const total = await redis.llen(HISTORICO_KEY);

  const statements = (lote || []).map((pedido) => {
    const idUnico = `${pedido.marketplace}:${pedido.order_id}`;
    const dateCreatedTs = new Date(pedido.date_created).getTime();
    return {
      sql: `INSERT OR IGNORE INTO historico_turbo
              (id_unico, marketplace, conta, order_id, date_created, date_created_ts, total_amount, estado, cidade, itens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        idUnico, pedido.marketplace, pedido.conta || null, String(pedido.order_id), pedido.date_created,
        dateCreatedTs, pedido.total_amount, pedido.estado || null, pedido.cidade || null,
        JSON.stringify(pedido.itens || []),
      ],
    };
  });

  if (statements.length > 0) await db.batch(statements, 'write');
  return { processados: (lote || []).length, total_disponivel: total };
}

async function debugMigrarRedisTurso(req, res) {
  const redis = getRedis();
  const db = getDb();

  const cursorFlex = req.query.cursor_flex || '0';
  const cursorTodos = req.query.cursor_todos || '0';
  const offsetTurbo = parseInt(req.query.offset_turbo, 10) || 0;

  const inicio = Date.now();
  const resultado = {};

  if (Date.now() - inicio < LIMITE_TEMPO_MIGRACAO_MS) {
    resultado.flex = await migrarHistoricoFlex(redis, db, cursorFlex);
  }
  if (Date.now() - inicio < LIMITE_TEMPO_MIGRACAO_MS) {
    resultado.todos = await migrarHistoricoTodos(redis, db, cursorTodos);
  }
  if (Date.now() - inicio < LIMITE_TEMPO_MIGRACAO_MS) {
    resultado.turbo = await migrarHistoricoTurbo(redis, db, offsetTurbo);
  }

  const proximoOffsetTurbo = offsetTurbo + (resultado.turbo ? resultado.turbo.processados : 0);
  const turboConcluido = resultado.turbo && proximoOffsetTurbo >= resultado.turbo.total_disponivel;

  const done =
    resultado.flex && resultado.flex.concluido &&
    resultado.todos && resultado.todos.concluido &&
    turboConcluido;

  res.status(200).json({
    ok: true,
    tipo: 'migrar-redis-turso',
    done,
    resultado,
    proximo: done ? null : {
      cursor_flex: resultado.flex && !resultado.flex.concluido ? resultado.flex.proximo_cursor : '0',
      cursor_todos: resultado.todos && !resultado.todos.concluido ? resultado.todos.proximo_cursor : '0',
      offset_turbo: turboConcluido ? 0 : proximoOffsetTurbo,
    },
  });
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
    if (req.query.tipo === 'migrar-redis-turso') return await debugMigrarRedisTurso(req, res);
    res.status(400).json({ error: 'Use ?tipo=ml-claims, ?tipo=shopee-returns, ?tipo=criar-tabelas ou ?tipo=migrar-redis-turso' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
