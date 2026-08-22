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
const { kvGet, kvDel } = require('../lib/kv');
const { importarContagemFisica, completarCatalogoFaltante, corrigirCorArranhadorAdesivoBege, enviarBalancoAgora } = require('../lib/estoqueSaldo');

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
    tipo TEXT,
    deadline TEXT,
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
  `CREATE TABLE IF NOT EXISTS historico_turbo_live (
    id_unico TEXT PRIMARY KEY,
    marketplace TEXT,
    conta TEXT,
    order_id TEXT,
    date_created TEXT,
    date_created_ts INTEGER,
    total_amount REAL,
    categoria TEXT,
    status_pedido TEXT,
    resolvido_em TEXT,
    deadline TEXT,
    itens TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_historico_turbo_live_data ON historico_turbo_live(date_created_ts)`,
  `CREATE TABLE IF NOT EXISTS estoque_saldo (
    produto TEXT NOT NULL,
    cor TEXT NOT NULL,
    tamanho TEXT NOT NULL,
    saldo REAL NOT NULL DEFAULT 0,
    atualizado_em TEXT,
    PRIMARY KEY (produto, cor, tamanho)
  )`,
  `CREATE TABLE IF NOT EXISTS estoque_baixas (
    id_unico TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    produto TEXT,
    cor TEXT,
    tamanho TEXT,
    quantidade REAL,
    sku TEXT,
    aplicado_em TEXT,
    revertido INTEGER NOT NULL DEFAULT 0,
    revertido_em TEXT,
    PRIMARY KEY (id_unico, item_index)
  )`,
  `CREATE TABLE IF NOT EXISTS estoque_vendas_nao_mapeadas (
    id_unico TEXT NOT NULL,
    item_index INTEGER NOT NULL,
    sku TEXT,
    quantidade REAL,
    marketplace TEXT,
    conta TEXT,
    registrado_em TEXT,
    PRIMARY KEY (id_unico, item_index)
  )`,
];

// Corrige shipment_id gravados como "123456789.0" em vez de "123456789" —
// bug no INSERT que não convertia o número pra string antes de gravar numa
// coluna TEXT, fazendo o SQLite aplicar a conversão REAL->TEXT (que sempre
// inclui ".0"). Isso quebrava a reverificação de status desses pedidos pra
// sempre, porque "123456789.0" não é um shipment_id válido na API do ML.
async function debugCorrigirShipmentId(req, res) {
  const db = getDb();
  const antes = await db.execute(
    "SELECT id_unico, shipment_id FROM historico_flex WHERE shipment_id LIKE '%.0'"
  );
  await db.execute(
    "UPDATE historico_flex SET shipment_id = SUBSTR(shipment_id, 1, LENGTH(shipment_id) - 2) WHERE shipment_id LIKE '%.0'"
  );
  res.status(200).json({
    ok: true,
    tipo: 'corrigir-shipment-id',
    corrigidos: antes.rows.length,
    exemplos: antes.rows.slice(0, 10),
  });
}

async function debugCriarTabelas(req, res) {
  const db = getDb();
  const criadas = [];
  for (const sql of TABELAS_SQL) {
    await db.execute(sql);
    criadas.push(sql.split('\n')[0].trim());
  }
  res.status(200).json({ ok: true, tipo: 'criar-tabelas', comandos_executados: criadas.length, detalhe: criadas });
}

// Adiciona as colunas "tipo" (flex/turbo/agora) e "deadline" (prazo real,
// vindo do SLA oficial do ML ou calculado) em bancos que já existiam antes
// delas — CREATE TABLE IF NOT EXISTS não adiciona coluna em tabela já criada.
// Idempotente: se a coluna já existe, o Turso rejeita com "duplicate column
// name" e a gente só ignora (pode rodar de novo sem problema).
async function debugAdicionarColunaTipo(req, res) {
  const db = getDb();
  const adicionadas = [];
  for (const [coluna, sql] of [
    ['tipo', "ALTER TABLE historico_flex ADD COLUMN tipo TEXT DEFAULT 'flex'"],
    ['deadline', 'ALTER TABLE historico_flex ADD COLUMN deadline TEXT'],
  ]) {
    try {
      await db.execute(sql);
      adicionadas.push(coluna);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
  res.status(200).json({ ok: true, tipo: 'adicionar-coluna-tipo', adicionadas });
}

// -------- Saldo de estoque (ver lib/estoqueSaldo.js) --------

async function debugImportarContagemFisica(req, res) {
  const resultado = await importarContagemFisica();
  res.status(200).json({ ok: true, tipo: 'importar-contagem-fisica', ...resultado });
}

async function debugCompletarCatalogoFaltante(req, res) {
  const resultado = await completarCatalogoFaltante();
  res.status(200).json({ ok: true, tipo: 'completar-catalogo-faltante', ...resultado });
}

async function debugCorrigirCorArranhadorAdesivoBege(req, res) {
  const resultado = await corrigirCorArranhadorAdesivoBege();
  res.status(200).json({ ok: true, tipo: 'corrigir-cor-arranhador-adesivo-bege', ...resultado });
}

async function debugEstoqueSaldo(req, res) {
  const db = getDb();
  const rs = await db.execute('SELECT produto, cor, tamanho, saldo, atualizado_em FROM estoque_saldo ORDER BY produto, tamanho, cor');
  const naoMapeadas = await db.execute('SELECT COUNT(*) AS total FROM estoque_vendas_nao_mapeadas');
  res.status(200).json({
    ok: true,
    tipo: 'estoque-saldo',
    total_produtos: rs.rows.length,
    vendas_nao_mapeadas: naoMapeadas.rows[0].total,
    saldo: rs.rows,
  });
}

async function debugBalancoMensal(req, res) {
  const resultado = await enviarBalancoAgora();
  res.status(200).json({ ok: true, tipo: 'balanco-mensal', resultado });
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

// Teste isolado da API de Product Ads (impressões/cliques) ANTES de montar
// a coleta diária de verdade — a API só funciona se o app OAuth do ML
// tiver o produto "Advertising" liberado e a conta tiver Publicidade
// habilitada (Mercado Livre > Mi perfil > Publicidade); nunca testado
// contra produção até rodar isso aqui uma vez.
async function debugMlAdsTest(req, res) {
  const conta = req.query.conta;
  if (!conta) { res.status(400).json({ error: 'Use ?conta=ricapet ou ?conta=thapets' }); return; }

  const { buscarAdvertiserId, buscarMetricasAnuncios, buscarCampanhas, buscarDetalheAnuncio } = require('../lib/mlAds');

  // Janela de 7 dias inteiros, terminando ontem — evita qualquer problema
  // com "hoje" ainda não estar fechado/consolidado nas métricas do ML.
  const hoje = new Date();
  const ontem = new Date(hoje.getTime() - 24 * 60 * 60 * 1000);
  const seteDiasAtras = new Date(hoje.getTime() - 8 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const periodo = { de: fmt(seteDiasAtras), ate: fmt(ontem) };

  // Anúncio real, pego da TABELA_AUXILIAR (Código do anúncio da SKU
  // "Alimentador_Automatico"), só pra testar o endpoint de item único —
  // pode ser sobrescrito via ?item_id= se quiser testar outro.
  const itemIdTeste = req.query.item_id || 'MLB5993419290';

  const resultado = { ok: true, tipo: 'ml-ads-test', conta, periodo, item_id_teste: itemIdTeste };

  try {
    resultado.advertiser_id = await buscarAdvertiserId(conta);
  } catch (err) {
    resultado.advertiser_id_erro = err.message;
  }

  try {
    const campanhas = await buscarCampanhas(conta, periodo.de, periodo.ate);
    resultado.campanhas = { total: (campanhas.paging && campanhas.paging.total) || 0, amostra: (campanhas.results || []).slice(0, 3) };
  } catch (err) {
    resultado.campanhas_erro = err.message;
  }

  try {
    const metricas = await buscarMetricasAnuncios(conta, periodo.de, periodo.ate, { limit: 5 });
    resultado.anuncios_lista = { total_retornado: metricas.length, amostra: metricas.slice(0, 5) };
  } catch (err) {
    resultado.anuncios_lista_erro = err.message;
  }

  try {
    resultado.anuncio_unico = await buscarDetalheAnuncio(conta, itemIdTeste);
  } catch (err) {
    resultado.anuncio_unico_erro = err.message;
  }

  res.status(200).json(resultado);
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

async function debugMlShipment(req, res) {
  const conta = req.query.conta;
  const orderId = req.query.order_id;
  let shipmentId = req.query.shipment_id;
  if (!conta || (!orderId && !shipmentId)) {
    res.status(400).json({ error: 'Use ?conta=ricapet&order_id=... (ou &shipment_id=...)' });
    return;
  }

  const accessToken = await getMLAccessToken(conta);

  let pedido = null;
  if (!shipmentId) {
    pedido = await mlFetch(`/orders/${orderId}`, accessToken);
    shipmentId = pedido.shipping && pedido.shipping.id;
    if (!shipmentId) {
      res.status(200).json({ ok: true, tipo: 'ml-shipment', conta, order_id: orderId, aviso: 'Pedido não tem shipping.id', pedido_bruto: pedido });
      return;
    }
  }

  const shipment = await mlFetch(`/shipments/${shipmentId}`, accessToken);
  let historico = null;
  try {
    historico = await mlFetch(`/shipments/${shipmentId}/history`, accessToken);
  } catch (err) {
    historico = { erro: err.message };
  }

  res.status(200).json({
    ok: true,
    tipo: 'ml-shipment',
    conta,
    order_id: orderId || null,
    shipment_id: shipmentId,
    shipment_status: shipment.status,
    shipment_substatus: shipment.substatus,
    shipment_bruto: shipment,
    historico_bruto: historico,
  });
}

// Testa o endpoint oficial GET /shipments/{id}/sla — a doc do ML só confirma
// esse endpoint pra Envios Agora, mas o path não parece exclusivo. Antes de
// confiar nele pra Flex/Turbo (e trocar nosso cálculo manual de prazo por
// ele), precisamos ver se devolve algo válido pra esses tipos também.
async function debugMlSla(req, res) {
  const conta = req.query.conta;
  const orderId = req.query.order_id;
  let shipmentId = req.query.shipment_id;
  if (!conta || (!orderId && !shipmentId)) {
    res.status(400).json({ error: 'Use ?conta=ricapet&order_id=... (ou &shipment_id=...)' });
    return;
  }

  const accessToken = await getMLAccessToken(conta);

  if (!shipmentId) {
    const pedido = await mlFetch(`/orders/${orderId}`, accessToken);
    shipmentId = pedido.shipping && pedido.shipping.id;
    if (!shipmentId) {
      res.status(200).json({ ok: true, tipo: 'ml-sla', conta, order_id: orderId, aviso: 'Pedido não tem shipping.id' });
      return;
    }
  }

  try {
    const sla = await mlFetch(`/shipments/${shipmentId}/sla`, accessToken);
    res.status(200).json({ ok: true, tipo: 'ml-sla', conta, order_id: orderId || null, shipment_id: shipmentId, sla_bruto: sla });
  } catch (err) {
    res.status(200).json({ ok: false, tipo: 'ml-sla', conta, order_id: orderId || null, shipment_id: shipmentId, erro: err.message });
  }
}

// Mostra o estado do cursor incremental do coletor de "Todos os pedidos"
// da Shopee (api/collect.js: coletarNovosParaHistoricoTodosShopee) — se a
// janela (desde/ate) ficou presa num intervalo antigo (ex: de quando o
// Fixie estava quebrado), o coletor nunca avança pros pedidos recentes até
// terminar de processar aquela janela velha inteira.
// Mostra o conteúdo bruto da tabela historico_turbo_live (rastreamento "ao
// vivo" do Turbo) — prova direta se um pedido específico foi capturado pelo
// nosso sistema, independente do que aparece no painel (que só mostra
// categoria='aguardando').
async function debugTurboLiveStatus(req, res) {
  const db = getDb();
  const orderSn = req.query.order_sn;

  if (orderSn) {
    const rs = await db.execute({
      sql: 'SELECT * FROM historico_turbo_live WHERE order_id = ?',
      args: [orderSn],
    });
    res.status(200).json({ ok: true, tipo: 'turbo-live-status', order_sn: orderSn, encontrado: rs.rows.length > 0, registro: rs.rows[0] || null });
    return;
  }

  const rs = await db.execute('SELECT id_unico, conta, order_id, date_created, categoria, status_pedido, deadline FROM historico_turbo_live ORDER BY date_created_ts DESC LIMIT 50');
  res.status(200).json({ ok: true, tipo: 'turbo-live-status', total: rs.rows.length, registros: rs.rows });
}

async function debugShopeeTodosStatus(req, res) {
  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) { res.status(400).json({ error: 'Use ?loja=ricapet ou ?loja=thapets' }); return; }

  if (req.query.resetar === '1') {
    await kvDel(`entrega_turbo:todos_shopee_janela_desde:${loja}`);
    await kvDel(`entrega_turbo:todos_shopee_janela_ate:${loja}`);
    await kvDel(`entrega_turbo:todos_shopee_janela_cursor:${loja}`);
  }

  const ultimaCompleta = await kvGet(`entrega_turbo:todos_shopee_ultima_completa_ts:${loja}`);
  const janelaDesde = await kvGet(`entrega_turbo:todos_shopee_janela_desde:${loja}`);
  const janelaAte = await kvGet(`entrega_turbo:todos_shopee_janela_ate:${loja}`);
  const janelaCursor = await kvGet(`entrega_turbo:todos_shopee_janela_cursor:${loja}`);
  const ultimaExecucaoShopee = await kvGet('entrega_turbo:ultima_execucao_shopee_ts');

  res.status(200).json({
    ok: true,
    tipo: 'shopee-todos-status',
    loja,
    ultima_janela_completa: ultimaCompleta,
    janela_em_andamento: {
      desde: janelaDesde ? new Date(Number(janelaDesde) * 1000).toISOString() : null,
      ate: janelaAte ? new Date(Number(janelaAte) * 1000).toISOString() : null,
      cursor: janelaCursor,
    },
    ultima_execucao_shopee_geral: ultimaExecucaoShopee ? new Date(ultimaExecucaoShopee).toISOString() : null,
    resetado: req.query.resetar === '1',
  });
}

// Chama get_order_detail direto pra 1-2 order_sn reais e devolve a resposta
// bruta — usado pra descobrir por que o coletor de "Todos os pedidos" da
// Shopee grava zero registros mesmo sem erro (suspeita: order_list vem
// vazio de get_order_detail, silenciosamente, com response_optional_fields).
async function debugShopeeOrderDetail(req, res) {
  const loja = (req.query.loja || '').toLowerCase();
  const orderSn = req.query.order_sn;
  if (!['ricapet', 'thapets'].includes(loja) || !orderSn) {
    res.status(400).json({ error: 'Use ?loja=ricapet&order_sn=XXXXX' });
    return;
  }

  const data = await shopeeGet(loja, '/api/v2/order/get_order_detail', {
    order_sn_list: orderSn,
    response_optional_fields: 'item_list,total_amount,shipping_carrier,recipient_address',
  });

  res.status(200).json({ ok: true, tipo: 'shopee-order-detail', loja, order_sn: orderSn, resposta_bruta: data });
}

// Mostra os canais de logística reais da loja — diagnóstico útil pra
// conferir nomes/status, mas a identificação do Turbo em si usa
// shipping_carrier no pedido (não precisa mais bater channel_id contra essa
// lista — ver lib/shopeeOrders.js).
async function debugShopeeChannels(req, res) {
  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) { res.status(400).json({ error: 'Use ?loja=ricapet ou ?loja=thapets' }); return; }

  const data = await shopeeGet(loja, '/api/v2/logistics/get_channel_list');
  const canais = (data.response && data.response.logistics_channel_list) || [];

  res.status(200).json({
    ok: true,
    tipo: 'shopee-channels',
    loja,
    total_canais: canais.length,
    canais: canais.map((c) => ({
      logistics_channel_id: c.logistics_channel_id,
      logistics_channel_name: c.logistics_channel_name,
      enabled: c.enabled,
    })),
  });
}

// Consulta direto na API da Shopee (sem depender do nosso pipeline/histórico)
// quantos pedidos existem num período — pra confirmar se "zero pedidos no
// histórico" é falta de venda real ou falha silenciosa de coleta.
async function debugShopeeOrdersRecentes(req, res) {
  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) { res.status(400).json({ error: 'Use ?loja=ricapet ou ?loja=thapets' }); return; }
  const dias = Math.min(parseInt(req.query.dias, 10) || 7, 15); // API limita a 15 dias por chamada

  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - dias * 24 * 60 * 60;

  const data = await shopeeGet(loja, '/api/v2/order/get_order_list', {
    time_range_field: 'create_time',
    time_from: timeFrom,
    time_to: timeTo,
    page_size: 100,
  });

  const pedidos = (data.response && data.response.order_list) || [];

  res.status(200).json({
    ok: true,
    tipo: 'shopee-orders-recentes',
    loja,
    periodo_dias: dias,
    total_pedidos: pedidos.length,
    more: (data.response && data.response.more) || false,
    exemplos: pedidos.slice(0, 10).map((p) => ({ order_sn: p.order_sn, order_status: p.order_status })),
  });
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

// Rotas chamadas direto do navegador (botão/tela em painel-estoque-adesivo,
// outro projeto) — usam o ESTOQUE_PUBLIC_SECRET, mais fraco, em vez do
// CRON_SECRET (que também protege rotas sensíveis como troca de token
// OAuth), pra não expor esse último num arquivo client-side.
const TIPOS_PUBLICOS_ESTOQUE = new Set(['importar-contagem-fisica', 'estoque-saldo', 'completar-catalogo-faltante', 'corrigir-cor-arranhador-adesivo-bege']);

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const isRotaPublicaEstoque = TIPOS_PUBLICOS_ESTOQUE.has(req.query.tipo);
  if (isRotaPublicaEstoque) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  }
  const estoquePublicSecret = process.env.ESTOQUE_PUBLIC_SECRET;
  const secretAutorizado =
    (cronSecret && req.query.secret === cronSecret) ||
    (isRotaPublicaEstoque && estoquePublicSecret && req.query.secret === estoquePublicSecret);
  if (!secretAutorizado) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  try {
    if (req.query.tipo === 'ml-oauth-url') {
      const conta = req.query.conta;
      const redirectUri = req.query.redirect_uri;
      if (!conta || !redirectUri) {
        res.status(400).json({ error: 'Use ?conta=ricapet|thapets&redirect_uri=<uma URI já cadastrada no app>' });
        return;
      }
      const { getContaConfig } = require('../lib/mlAuth');
      const { clientId } = getContaConfig(conta);
      const authUrl = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
      res.status(200).json({ ok: true, tipo: 'ml-oauth-url', conta, redirect_uri: redirectUri, url_para_abrir: authUrl });
      return;
    }
    if (req.query.tipo === 'ml-oauth-exchange') {
      const conta = req.query.conta;
      const code = req.query.code;
      const redirectUri = req.query.redirect_uri;
      if (!conta || !code || !redirectUri) {
        res.status(400).json({ error: 'Use ?conta=ricapet|thapets&code=<code recebido>&redirect_uri=<mesma URI usada no ml-oauth-url>' });
        return;
      }
      const { getContaConfig, trocarCodigoPorTokens, salvarToken } = require('../lib/mlAuth');
      const { clientId, clientSecret } = getContaConfig(conta);
      const tokenData = await trocarCodigoPorTokens(clientId, clientSecret, code, redirectUri);
      await salvarToken(conta, {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        user_id: tokenData.user_id,
        expires_at: Date.now() + tokenData.expires_in * 1000,
      });
      res.status(200).json({ ok: true, tipo: 'ml-oauth-exchange', conta, escopo_concedido: tokenData.scope, user_id: tokenData.user_id });
      return;
    }
    if (req.query.tipo === 'ml-client-ids') {
      res.status(200).json({
        ok: true, tipo: 'ml-client-ids',
        ricapet: process.env.ML_RICAPET_CLIENT_ID || null,
        thapets: process.env.ML_THAPETS_CLIENT_ID || null,
      });
      return;
    }
    if (req.query.tipo === 'ml-ads-test') return await debugMlAdsTest(req, res);
    if (req.query.tipo === 'ml-ads-varios-itens') {
      const conta = req.query.conta;
      if (!conta) { res.status(400).json({ error: 'Use ?conta=ricapet ou ?conta=thapets' }); return; }
      const { getMLAccessToken } = require('../lib/mlAuth');
      const { chamadaBruta } = require('../lib/mlAds');
      const accessToken = await getMLAccessToken(conta);

      // Anúncios reais dos produtos mais vendidos (Arranhador Adesivo),
      // pegos direto da TABELA_AUXILIAR — mais chance de estarem
      // anunciados de verdade do que um item aleatório.
      const itensPadrao = [
        'MLB5266670312', 'MLB4113207571', 'MLB4112797061', 'MLB5473940642',
        'MLB3959143795', 'MLB3960024607', 'MLB5267523998', 'MLB5266582944',
        'MLB3959131641', 'MLB3960028631', 'MLB3959960521', 'MLB5266714014',
      ];
      const itens = req.query.item_ids ? req.query.item_ids.split(',') : itensPadrao;

      const resultados = {};
      for (const itemId of itens) {
        const r = await chamadaBruta(`/advertising/product_ads/items/${itemId}`, accessToken, { 'Api-Version': '2' });
        resultados[itemId] = { status: r.status, corpo: r.status === 200 ? JSON.parse(r.body) : r.body };
      }

      res.status(200).json({ ok: true, tipo: 'ml-ads-varios-itens', conta, total_testados: itens.length, resultados });
      return;
    }
    if (req.query.tipo === 'ml-ads-raw') {
      const conta = req.query.conta;
      if (!conta) { res.status(400).json({ error: 'Use ?conta=ricapet ou ?conta=thapets' }); return; }
      const { getMLAccessToken } = require('../lib/mlAuth');
      const { buscarAdvertiserId, chamadaBruta } = require('../lib/mlAds');
      const accessToken = await getMLAccessToken(conta);
      const advertiserId = await buscarAdvertiserId(conta);

      const hoje = new Date();
      const ontem = new Date(hoje.getTime() - 24 * 60 * 60 * 1000);
      const seteDiasAtras = new Date(hoje.getTime() - 8 * 24 * 60 * 60 * 1000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const de = fmt(seteDiasAtras), ate = fmt(ontem);

      const tentativas = {
        campanhas_sem_query: await chamadaBruta(
          `/advertising/advertisers/${advertiserId}/product_ads/campaigns`, accessToken, { 'Api-Version': '2' }),
        campanhas_com_datas_sem_metrics: await chamadaBruta(
          `/advertising/advertisers/${advertiserId}/product_ads/campaigns?date_from=${de}&date_to=${ate}`, accessToken, { 'Api-Version': '2' }),
        campanhas_header_minusculo: await chamadaBruta(
          `/advertising/advertisers/${advertiserId}/product_ads/campaigns?date_from=${de}&date_to=${ate}&metrics=clicks,prints`, accessToken, { 'api-version': '2' }),
        campanhas_sem_header_versao: await chamadaBruta(
          `/advertising/advertisers/${advertiserId}/product_ads/campaigns?date_from=${de}&date_to=${ate}&metrics=clicks,prints`, accessToken, {}),
        items_sem_query: await chamadaBruta(
          `/advertising/advertisers/${advertiserId}/product_ads/items`, accessToken, { 'Api-Version': '2' }),
      };

      res.status(200).json({ ok: true, tipo: 'ml-ads-raw', conta, advertiser_id: advertiserId, periodo: { de, ate }, tentativas });
      return;
    }
    if (req.query.tipo === 'ml-claims') return await debugMlClaims(req, res);
    if (req.query.tipo === 'ml-shipment') return await debugMlShipment(req, res);
    if (req.query.tipo === 'ml-sla') return await debugMlSla(req, res);
    if (req.query.tipo === 'shopee-returns') return await debugShopeeReturns(req, res);
    if (req.query.tipo === 'shopee-channels') return await debugShopeeChannels(req, res);
    if (req.query.tipo === 'shopee-orders-recentes') return await debugShopeeOrdersRecentes(req, res);
    if (req.query.tipo === 'shopee-todos-status') return await debugShopeeTodosStatus(req, res);
    if (req.query.tipo === 'turbo-live-status') return await debugTurboLiveStatus(req, res);
    if (req.query.tipo === 'shopee-order-detail') return await debugShopeeOrderDetail(req, res);
    if (req.query.tipo === 'criar-tabelas') return await debugCriarTabelas(req, res);
    if (req.query.tipo === 'migrar-redis-turso') return await debugMigrarRedisTurso(req, res);
    if (req.query.tipo === 'corrigir-shipment-id') return await debugCorrigirShipmentId(req, res);
    if (req.query.tipo === 'adicionar-coluna-tipo') return await debugAdicionarColunaTipo(req, res);
    if (req.query.tipo === 'importar-contagem-fisica') return await debugImportarContagemFisica(req, res);
    if (req.query.tipo === 'estoque-saldo') return await debugEstoqueSaldo(req, res);
    if (req.query.tipo === 'completar-catalogo-faltante') return await debugCompletarCatalogoFaltante(req, res);
    if (req.query.tipo === 'corrigir-cor-arranhador-adesivo-bege') return await debugCorrigirCorArranhadorAdesivoBege(req, res);
    if (req.query.tipo === 'balanco-mensal') return await debugBalancoMensal(req, res);
    res.status(400).json({ error: 'Use ?tipo=ml-claims, ?tipo=ml-shipment, ?tipo=ml-sla, ?tipo=shopee-returns, ?tipo=shopee-channels, ?tipo=criar-tabelas, ?tipo=migrar-redis-turso, ?tipo=corrigir-shipment-id ou ?tipo=adicionar-coluna-tipo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
