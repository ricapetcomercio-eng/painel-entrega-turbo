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
const { importarContagemFisica, importarSaldoDaPlanilha, completarCatalogoFaltante, corrigirCorArranhadorAdesivoBege, enviarBalancoAgora } = require('../lib/estoqueSaldo');

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
  `CREATE TABLE IF NOT EXISTS funcionarios (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS registros_ponto (
    id TEXT PRIMARY KEY,
    funcionario_id TEXT NOT NULL,
    tipo TEXT NOT NULL,
    registrado_em TEXT NOT NULL,
    metodo_validacao TEXT NOT NULL,
    latitude REAL,
    longitude REAL,
    distancia_metros REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_registros_ponto_funcionario ON registros_ponto(funcionario_id, registrado_em)`,
  `CREATE TABLE IF NOT EXISTS solicitacoes_ponto (
    id TEXT PRIMARY KEY,
    funcionario_id TEXT NOT NULL,
    data_referente TEXT NOT NULL,
    motivo TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pendente',
    criada_em TEXT NOT NULL,
    resolvida_em TEXT,
    resolvida_por TEXT,
    resposta_admin TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_solicitacoes_ponto_func ON solicitacoes_ponto(funcionario_id, data_referente)`,
  `CREATE TABLE IF NOT EXISTS jornadas_ponto (
    funcionario_id TEXT NOT NULL,
    dia_semana INTEGER NOT NULL,
    minutos_previstos INTEGER NOT NULL DEFAULT 0,
    entrada_ref TEXT,
    saida_ref TEXT,
    intervalo_min INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (funcionario_id, dia_semana)
  )`,
  `CREATE TABLE IF NOT EXISTS abonos_ponto (
    funcionario_id TEXT NOT NULL,
    data TEXT NOT NULL,
    tipo TEXT NOT NULL,
    observacao TEXT,
    criado_por TEXT,
    criado_em TEXT NOT NULL,
    PRIMARY KEY (funcionario_id, data)
  )`,
];

// Colunas adicionadas depois que as tabelas de ponto já existiam. ALTER é
// idempotente aqui: se a coluna já existe o Turso rejeita com "duplicate
// column name" e a gente ignora (dá pra rodar criar-tabelas de novo à vontade).
const ALTERS_PONTO = [
  "ALTER TABLE funcionarios ADD COLUMN admin INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE funcionarios ADD COLUMN cpf TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN origem TEXT NOT NULL DEFAULT 'batida'",
  "ALTER TABLE registros_ponto ADD COLUMN motivo TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN editado_por TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN editado_em TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN registrado_em_original TEXT",
  // Fase 4 -- inalterabilidade: NSR sequencial + hash encadeado. A partir daqui
  // registros_ponto vira append-only (correção = registro novo de ajuste).
  "ALTER TABLE registros_ponto ADD COLUMN nsr INTEGER",
  "ALTER TABLE registros_ponto ADD COLUMN hash TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN hash_anterior TEXT",
  "ALTER TABLE registros_ponto ADD COLUMN ref_nsr INTEGER",
  "ALTER TABLE registros_ponto ADD COLUMN cnpj TEXT",
  "CREATE TABLE IF NOT EXISTS config_ponto (chave TEXT PRIMARY KEY, valor TEXT)",
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
  for (const sql of ALTERS_PONTO) {
    try {
      await db.execute(sql);
      criadas.push(sql);
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
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

async function debugImportarSaldoDaPlanilha(req, res) {
  const resultado = await importarSaldoDaPlanilha();
  res.status(200).json({ ok: true, tipo: 'importar-saldo-da-planilha', ...resultado });
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

// Proxy pro JSONBin (contagem física) e Google Sheets (log de contagem),
// chamados por public/estoque.html e estoque-atualizar.html. Vivem aqui (em
// vez de um api/estoque.js próprio) só pra não estourar o limite de 12
// serverless functions do plano Hobby — mesmo motivo de todo o resto deste
// arquivo. Cada rota exige sessão de admin (obterAdminSessao), igual ao
// resto do painel.
//
// Reaproveita JSONBIN_ESTOQUE_API_KEY/BIN_ID e GOOGLE_SHEETS_WEBAPP_URL —
// já configuradas na Vercel pra lib/estoqueSaldo.js, que documenta serem as
// MESMAS credenciais que estoque.html usava hardcoded (mesmo bin/planilha).
// Não são variáveis novas a criar.
async function debugEstoqueContagemGet(req, res) {
  const resultado = await obterAdminSessao((req.body && req.body.sessao) || req.query.sessao, getDb());
  if (resultado.erro) { res.status(resultado.status).json({ ok: false, error: resultado.erro }); return; }
  const apiKey = process.env.JSONBIN_ESTOQUE_API_KEY;
  const binId = process.env.JSONBIN_ESTOQUE_BIN_ID;
  if (!apiKey || !binId) { res.status(200).json({ ok: true, record: null }); return; }
  try {
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': apiKey } });
    if (!resp.ok) { res.status(200).json({ ok: true, record: null }); return; }
    const json = await resp.json();
    res.status(200).json({ ok: true, record: json.record || null });
  } catch (err) {
    res.status(200).json({ ok: true, record: null });
  }
}

async function debugEstoqueContagemSet(req, res) {
  const resultado = await obterAdminSessao((req.body && req.body.sessao) || req.query.sessao, getDb());
  if (resultado.erro) { res.status(resultado.status).json({ ok: false, error: resultado.erro }); return; }
  const apiKey = process.env.JSONBIN_ESTOQUE_API_KEY;
  const binId = process.env.JSONBIN_ESTOQUE_BIN_ID;
  if (!apiKey || !binId) { res.status(200).json({ ok: false, error: 'JSONBin não configurado no servidor.' }); return; }
  try {
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
      body: JSON.stringify((req.body && req.body.record) || {}),
    });
    res.status(200).json({ ok: resp.ok });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}

async function debugEstoqueSheetsLog(req, res) {
  const resultado = await obterAdminSessao((req.body && req.body.sessao) || req.query.sessao, getDb());
  if (resultado.erro) { res.status(resultado.status).json({ ok: false, error: resultado.erro }); return; }
  const url = process.env.GOOGLE_SHEETS_WEBAPP_URL;
  if (!url) { res.status(200).json({ ok: false, error: 'Google Sheets não configurado no servidor.' }); return; }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ rows: (req.body && req.body.rows) || [], data: new Date().toISOString() }),
    });
    let json = {};
    try { json = await resp.json(); } catch (e) { /* corpo vazio/inesperado */ }
    res.status(200).json({ ok: !!(resp.ok && json.ok) });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
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

// Mesma ideia de debugTurboLiveStatus, mas pro Flex (historico_flex) - qual
// categoria ('aguardando'/'coletado'/'entregue') um shipment_id específico
// está agora, sem precisar ficar chamando /api/marcar-coletado às cegas só
// pra conferir. Aceita uma lista separada por vírgula em vez de só um, pra
// não custar N requisições HTTP numa conferência em lote (leitura simples,
// CPU ~zero - mesmo orçamento de dashboard-data.js).
async function debugFlexStatus(req, res) {
  const db = getDb();
  const idsBrutos = (req.query.shipment_ids || req.query.shipment_id || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (idsBrutos.length === 0) {
    res.status(400).json({ error: 'Use ?shipment_ids=id1,id2,... (ou ?shipment_id=id)' });
    return;
  }
  const placeholders = idsBrutos.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `SELECT order_id, shipment_id, categoria, coletado, coletado_em, entregue_em
          FROM historico_flex WHERE shipment_id IN (${placeholders})`,
    args: idsBrutos,
  });
  const porShipment = {};
  for (const row of rs.rows) porShipment[row.shipment_id] = row;
  const resultado = idsBrutos.map((id) => porShipment[id] || { shipment_id: id, encontrado: false });
  res.status(200).json({ ok: true, tipo: 'flex-status', total: resultado.length, registros: resultado });
}

// Lê a linha CRUA de historico_todos por order_id (qualquer marketplace) —
// pra depurar de verdade o que está gravado (categoria/coletado/
// coletado_em), sem passar pelo filtro de listarShopeeAguardando que só
// mostra quem ainda está "pendente" (não ajuda a ver o que JÁ foi corrigido
// nem a diferenciar "nunca chegou a existir" de "existe mas com categoria
// nula"). Aceita lista separada por vírgula.
async function debugHistoricoTodosRow(req, res) {
  const db = getDb();
  const idsBrutos = (req.query.order_ids || req.query.order_id || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (idsBrutos.length === 0) {
    res.status(400).json({ error: 'Use ?order_ids=id1,id2,... (ou ?order_id=id)' });
    return;
  }
  const placeholders = idsBrutos.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `SELECT id_unico, marketplace, order_id, date_created, status_pedido, cancelado, categoria, coletado, coletado_em
          FROM historico_todos WHERE order_id IN (${placeholders})`,
    args: idsBrutos,
  });
  const porOrderId = {};
  for (const row of rs.rows) {
    (porOrderId[row.order_id] = porOrderId[row.order_id] || []).push(row);
  }
  const resultado = idsBrutos.map((id) => porOrderId[id] || [{ order_id: id, encontrado: false }]);
  res.status(200).json({ ok: true, tipo: 'historico-todos-row', total: resultado.length, registros: resultado });
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

// -------- Ponto (app nativo "Ricapet", ver PortalRicapetApp) --------
// Login por nome + PIN de 4 dígitos (mesma ideia do OPERADORES_EXPEDICAO
// do checkout_bipagem.py, mas com PIN guardado com hash aqui em vez de
// texto puro). Token simples (payload + HMAC), sem expiração -- é
// controle interno de presença, não o ponto oficial da folha.

const crypto = require('crypto');
const { hashPin, gerarTokenPonto, verificarTokenPonto, funcionarioEhAdmin, obterAdminSessao } = require('../lib/pontoAuth');

// O servidor roda em UTC; a loja opera no fuso de São Paulo (UTC-3 fixo desde
// o fim do horário de verão em 2019). Estas duas funções convertem entre um
// "AAAA-MM-DD / HH:MM de São Paulo" e o ISO em UTC que vai pro banco.
function dataFusoLoja(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(d));
}

function isoDeDiaHoraLoja(diaAAAAMMDD, horaHHMM) {
  const [h, m] = String(horaHHMM || '').split(':').map((x) => parseInt(x, 10));
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error('Hora inválida (use HH:MM).');
  }
  const d = new Date(`${diaAAAAMMDD}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
  if (isNaN(d)) throw new Error('Data/hora inválida.');
  return d.toISOString();
}

// Auto-migração das tabelas de ponto -- roda na primeira chamada que precisar
// (dispensa o script com CRON_SECRET). Idempotente e barata depois da 1ª vez.
let _esquemaPontoOk = false;
async function garantirEsquemaPonto(db) {
  if (_esquemaPontoOk) return;
  try {
    await db.execute('SELECT nsr, hash, ref_nsr, cnpj FROM registros_ponto LIMIT 1');
    await db.execute('SELECT 1 FROM abonos_ponto LIMIT 1');
    await db.execute('SELECT 1 FROM config_ponto LIMIT 1');
    _esquemaPontoOk = true;
    return;
  } catch (e) { /* falta coluna/tabela -> migra abaixo */ }

  for (const sql of TABELAS_SQL) {
    if (!/(_ponto|funcionarios)/.test(sql)) continue;
    try { await db.execute(sql); } catch (e) { if (!/already exists/i.test(e.message)) throw e; }
  }
  for (const sql of ALTERS_PONTO) {
    try { await db.execute(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  const rs = await db.execute('SELECT id, funcionario_id, tipo, registrado_em, origem, nsr FROM registros_ponto ORDER BY registrado_em, id');
  if (rs.rows.some((r) => r.nsr == null)) {
    const cfg = await configPonto(db);
    let anterior = '0'.repeat(64);
    let n = 0;
    for (const r of rs.rows) {
      n += 1;
      const origem = ['batida', 'ajuste_inclusao', 'ajuste_alteracao', 'ajuste_exclusao'].includes(r.origem) ? r.origem : 'batida';
      const hash = hashRegistro(anterior, { nsr: n, funcionario_id: r.funcionario_id, tipo: r.tipo, registrado_em: r.registrado_em, origem, ref_nsr: '', cnpj: cfg.cnpj || '' });
      await db.execute({
        sql: 'UPDATE registros_ponto SET nsr = ?, hash = ?, hash_anterior = ?, origem = ?, cnpj = ?, ref_nsr = NULL WHERE id = ?',
        args: [n, hash, anterior, origem, cfg.cnpj || null, r.id],
      });
      anterior = hash;
    }
  }
  _esquemaPontoOk = true;
}

// config_ponto: dados do empregador pro comprovante / AFD.
async function configPonto(db) {
  const rs = await db.execute('SELECT chave, valor FROM config_ponto');
  const c = {};
  rs.rows.forEach((r) => { c[r.chave] = r.valor; });
  return {
    empresa: c.empresa || process.env.PONTO_EMPRESA_NOME || 'Ricapet',
    cnpj: c.cnpj || process.env.PONTO_EMPRESA_CNPJ || '',
    endereco: c.endereco || process.env.PONTO_EMPRESA_ENDERECO || '',
    // batidas por dia (bate-ponto) antes de bloquear; tolerancia em minutos
    // pra nao contar atraso/extra dentro dela (CLT art. 58: ate 10 min/dia).
    limite_batidas_dia: Math.max(parseInt(c.limite_batidas_dia, 10) || 8, 2),
    tolerancia_min: c.tolerancia_min != null ? Math.max(parseInt(c.tolerancia_min, 10) || 0, 0) : 10,
  };
}

// ---- Fase 4: inalterabilidade (NSR + hash encadeado, append-only) ----
function hashRegistro(hashAnterior, r) {
  const conteudo = [r.nsr, r.funcionario_id, r.tipo, r.registrado_em, r.origem || 'batida', r.ref_nsr || '', r.cnpj || ''].join('|');
  return crypto.createHmac('sha256', process.env.PONTO_TOKEN_SECRET || '').update(String(hashAnterior || '') + conteudo).digest('hex');
}

async function inserirRegistroPonto(db, dados) {
  const ult = await db.execute('SELECT nsr, hash FROM registros_ponto WHERE nsr IS NOT NULL ORDER BY nsr DESC LIMIT 1');
  const nsr = (ult.rows[0] ? Number(ult.rows[0].nsr) : 0) + 1;
  const hashAnterior = ult.rows[0] ? ult.rows[0].hash : '0'.repeat(64);
  const cfg = await configPonto(db);
  const linha = {
    nsr,
    funcionario_id: dados.funcionario_id,
    tipo: dados.tipo,
    registrado_em: dados.registrado_em,
    origem: dados.origem || 'batida',
    ref_nsr: dados.ref_nsr || null,
    cnpj: cfg.cnpj || null,
  };
  const hash = hashRegistro(hashAnterior, linha);
  await db.execute({
    sql: `INSERT INTO registros_ponto
          (id, funcionario_id, tipo, registrado_em, metodo_validacao, latitude, longitude, distancia_metros,
           origem, motivo, editado_por, editado_em, ref_nsr, nsr, hash, hash_anterior, cnpj)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      `${dados.funcionario_id}:${dados.registrado_em}:${nsr}`,
      dados.funcionario_id, dados.tipo, dados.registrado_em, dados.metodo_validacao || 'edicao',
      dados.latitude ?? null, dados.longitude ?? null, dados.distancia_metros ?? null,
      linha.origem, dados.motivo || null, dados.autor_id || null, dados.autor_id ? new Date().toISOString() : null,
      linha.ref_nsr, nsr, hash, hashAnterior, linha.cnpj,
    ],
  });
  return { nsr, hash, registrado_em: dados.registrado_em };
}

// Reduz as linhas cruas (batida + ajustes) às marcações vigentes.
// Cada marcação carrega o `nsr` da linha que a originou -- é por ele que as
// correções seguintes referenciam (ref_nsr).
function resolverMarcacoes(rows) {
  const ordenadas = [...rows].sort((a, b) => (Number(a.nsr) || 0) - (Number(b.nsr) || 0));
  const efetivas = new Map();
  for (const r of ordenadas) {
    const origem = r.origem || 'batida';
    if (origem === 'batida' || origem === 'ajuste_inclusao') {
      efetivas.set(Number(r.nsr), {
        nsr: Number(r.nsr), tipo: r.tipo, registrado_em: r.registrado_em,
        metodo_validacao: r.metodo_validacao, editado: origem !== 'batida', origem,
      });
    } else if (origem === 'ajuste_alteracao') {
      const alvo = efetivas.get(Number(r.ref_nsr));
      if (alvo) { alvo.tipo = r.tipo; alvo.registrado_em = r.registrado_em; alvo.editado = true; }
    } else if (origem === 'ajuste_exclusao') {
      efetivas.delete(Number(r.ref_nsr));
    }
  }
  return [...efetivas.values()].sort((a, b) => new Date(a.registrado_em) - new Date(b.registrado_em));
}

// Jornada esperada por dia da semana (0=domingo … 6=sábado), em minutos já
// líquidos do intervalo. Devolve null quando o funcionário não tem jornada
// cadastrada -- nesse caso o painel não calcula extras/faltas/saldo dele.
async function jornadaSemana(db, funcionarioId) {
  const rs = await db.execute({
    sql: 'SELECT dia_semana, minutos_previstos, entrada_ref, saida_ref, intervalo_min FROM jornadas_ponto WHERE funcionario_id = ?',
    args: [funcionarioId],
  });
  if (!rs.rows.length) return null;
  const semana = Array.from({ length: 7 }, () => ({ minutos: 0, entrada: null, saida: null, intervalo: 0 }));
  rs.rows.forEach((r) => {
    const d = Number(r.dia_semana);
    if (d >= 0 && d <= 6) semana[d] = {
      minutos: Number(r.minutos_previstos) || 0,
      entrada: r.entrada_ref || null, saida: r.saida_ref || null, intervalo: Number(r.intervalo_min) || 0,
    };
  });
  return semana;
}

async function debugPontoFuncionarios(req, res) {
  const db = getDb();
  const rs = await db.execute('SELECT id, nome FROM funcionarios WHERE ativo = 1 ORDER BY nome');
  res.status(200).json({ ok: true, tipo: 'ponto-funcionarios', funcionarios: rs.rows });
}

async function debugPontoLogin(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { funcionario_id | nome, pin }' }); return; }
  const { funcionario_id, nome, pin } = req.body || {};
  if ((!funcionario_id && !nome) || !pin) { res.status(400).json({ error: 'Use POST { funcionario_id | nome, pin }' }); return; }

  const db = getDb();
  const rs = funcionario_id
    ? await db.execute({ sql: 'SELECT id, nome, pin_hash, admin FROM funcionarios WHERE id = ? AND ativo = 1', args: [funcionario_id] })
    : await db.execute({ sql: 'SELECT id, nome, pin_hash, admin FROM funcionarios WHERE lower(nome) = lower(?) AND ativo = 1', args: [String(nome).trim()] });
  const funcionario = rs.rows[0];
  if (!funcionario || funcionario.pin_hash !== hashPin(pin)) {
    res.status(401).json({ ok: false, error: 'Nome ou PIN incorreto, tenta de novo.' });
    return;
  }
  res.status(200).json({
    ok: true, tipo: 'ponto-login',
    token: gerarTokenPonto(funcionario), nome: funcionario.nome, admin: funcionario.admin === 1,
  });
}

// Valida um token de login do portal (usado pelo checkout_bipagem.py pra
// criar a sessão da expedição sem pedir senha de novo).
async function debugPontoValidarToken(req, res) {
  const token = (req.body && req.body.token) || req.query.token;
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) { res.status(401).json({ ok: false, error: 'Token inválido ou expirado.' }); return; }
  res.status(200).json({ ok: true, tipo: 'ponto-validar-token', id: funcionario.id, nome: funcionario.nome });
}

async function debugPontoBater(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, metodo_validacao, ... }' }); return; }
  const { token, metodo_validacao, latitude, longitude, distancia_metros } = req.body || {};
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) { res.status(401).json({ ok: false, error: 'Sessão expirada, faça login de novo.' }); return; }
  if (!['rede', 'gps', 'rede+gps'].includes(metodo_validacao)) {
    res.status(400).json({ error: "metodo_validacao precisa ser 'rede', 'gps' ou 'rede+gps'" });
    return;
  }

  const db = getDb();
  await garantirEsquemaPonto(db);
  const recentes = await db.execute({
    sql: `SELECT nsr, tipo, registrado_em, metodo_validacao, origem, ref_nsr
          FROM registros_ponto WHERE funcionario_id = ? ORDER BY nsr DESC LIMIT 60`,
    args: [funcionario.id],
  });
  const marcacoes = resolverMarcacoes(recentes.rows);
  const cfg = await configPonto(db);

  // limite de batidas por dia (fuso da loja)
  const hojeLoja = dataFusoLoja(new Date());
  const batidasHoje = marcacoes.filter((m) => dataFusoLoja(m.registrado_em) === hojeLoja).length;
  if (batidasHoje >= cfg.limite_batidas_dia) {
    res.status(429).json({
      ok: false,
      error: `Você já bateu ${batidasHoje} vezes hoje (limite ${cfg.limite_batidas_dia}). Se precisar ajustar, fale com o administrador.`,
    });
    return;
  }

  const ultima = marcacoes[marcacoes.length - 1];
  const proximoTipo = ultima && ultima.tipo === 'entrada' ? 'saida' : 'entrada';
  const agora = new Date().toISOString();

  const { nsr, hash } = await inserirRegistroPonto(db, {
    funcionario_id: funcionario.id, tipo: proximoTipo, registrado_em: agora, metodo_validacao,
    latitude, longitude, distancia_metros, origem: 'batida',
  });

  const dadosFunc = await db.execute({ sql: 'SELECT cpf FROM funcionarios WHERE id = ?', args: [funcionario.id] });

  res.status(200).json({
    ok: true, tipo: 'ponto-bater', registro: proximoTipo, registrado_em: agora, nome: funcionario.nome,
    comprovante: {
      nsr, registrado_em: agora, tipo: proximoTipo,
      empresa: cfg.empresa, cnpj: cfg.cnpj,
      funcionario: funcionario.nome, cpf: dadosFunc.rows[0]?.cpf || null,
      codigo: hash.slice(0, 24),
    },
  });
}

// Histórico do próprio funcionário logado -- chamado pelo app (portal
// Ricapet) com o PONTO_PUBLIC_SECRET. Só devolve as batidas de quem é dono
// do token, nunca as de outra pessoa.
async function debugPontoHistorico(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token }' }); return; }
  const { token } = req.body || {};
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) { res.status(401).json({ ok: false, error: 'Sessão expirada, faça login de novo.' }); return; }

  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 600, 1), 2000);
  const db = getDb();
  await garantirEsquemaPonto(db);
  const rs = await db.execute({
    sql: `SELECT nsr, registrado_em, tipo, metodo_validacao, origem, ref_nsr
          FROM registros_ponto WHERE funcionario_id = ?
          ORDER BY nsr DESC LIMIT ${limite}`,
    args: [funcionario.id],
  });
  const sol = await db.execute({
    sql: `SELECT id, data_referente, motivo, status, criada_em, resolvida_em, resposta_admin
          FROM solicitacoes_ponto WHERE funcionario_id = ? ORDER BY criada_em DESC LIMIT 90`,
    args: [funcionario.id],
  });
  const abo = await db.execute({
    sql: 'SELECT data, tipo, observacao FROM abonos_ponto WHERE funcionario_id = ? ORDER BY data DESC LIMIT 200',
    args: [funcionario.id],
  });
  const cfg = await configPonto(db);
  res.status(200).json({
    ok: true, tipo: 'ponto-historico', nome: funcionario.nome,
    hoje: dataFusoLoja(new Date()),
    jornada: await jornadaSemana(db, funcionario.id),
    marcacoes: resolverMarcacoes(rs.rows),
    solicitacoes: sol.rows,
    abonos: abo.rows,
    config: { tolerancia_min: cfg.tolerancia_min, limite_batidas_dia: cfg.limite_batidas_dia },
    empresa: { empresa: cfg.empresa, cnpj: cfg.cnpj },
  });
}

// -------- Correções do próprio funcionário --------
// Regra: sem autorização só no MESMO DIA (fuso da loja) e sempre com motivo.
// Dias anteriores -> só via solicitação (debugPontoSolicitarCorrecao), que um
// admin resolve no painel.
async function debugPontoEditarProprio(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, acao, ... }' }); return; }
  const { token, acao, ref_nsr, tipo, hora, motivo } = req.body || {};
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) { res.status(401).json({ ok: false, error: 'Sessão expirada, faça login de novo.' }); return; }
  if (!motivo || !String(motivo).trim()) { res.status(400).json({ error: 'Informe o motivo da alteração.' }); return; }
  const motivoLimpo = String(motivo).trim().slice(0, 500);

  const db = getDb();
  await garantirEsquemaPonto(db);
  const hoje = dataFusoLoja(new Date());

  // marcação vigente referenciada por ref_nsr (tem que ser do funcionário e de hoje)
  async function marcacaoDeHoje(nsrAlvo) {
    const rs = await db.execute({
      sql: `SELECT nsr, tipo, registrado_em, metodo_validacao, origem, ref_nsr
            FROM registros_ponto WHERE funcionario_id = ? ORDER BY nsr`,
      args: [funcionario.id],
    });
    const m = resolverMarcacoes(rs.rows).find((x) => x.nsr === Number(nsrAlvo));
    if (!m) { res.status(404).json({ error: 'Batida não encontrada.' }); return null; }
    if (dataFusoLoja(m.registrado_em) !== hoje) {
      res.status(403).json({ error: 'Sem autorização, só dá pra mexer nas batidas de hoje. Pra outro dia, peça a correção.' });
      return null;
    }
    return m;
  }

  try {
    if (acao === 'adicionar') {
      if (!['entrada', 'saida'].includes(tipo)) { res.status(400).json({ error: "tipo precisa ser 'entrada' ou 'saida'" }); return; }
      const iso = isoDeDiaHoraLoja(hoje, hora);
      const r = await inserirRegistroPonto(db, {
        funcionario_id: funcionario.id, tipo, registrado_em: iso,
        origem: 'ajuste_inclusao', motivo: motivoLimpo, autor_id: funcionario.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-editar-proprio', acao, nsr: r.nsr });
      return;
    }

    if (acao === 'editar') {
      const m = await marcacaoDeHoje(ref_nsr);
      if (!m) return;
      const iso = isoDeDiaHoraLoja(hoje, hora);
      const r = await inserirRegistroPonto(db, {
        funcionario_id: funcionario.id, tipo: ['entrada', 'saida'].includes(tipo) ? tipo : m.tipo,
        registrado_em: iso, origem: 'ajuste_alteracao', ref_nsr: m.nsr,
        motivo: motivoLimpo, autor_id: funcionario.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-editar-proprio', acao, nsr: r.nsr });
      return;
    }

    if (acao === 'remover') {
      const m = await marcacaoDeHoje(ref_nsr);
      if (!m) return;
      const r = await inserirRegistroPonto(db, {
        funcionario_id: funcionario.id, tipo: m.tipo, registrado_em: m.registrado_em,
        origem: 'ajuste_exclusao', ref_nsr: m.nsr, motivo: motivoLimpo, autor_id: funcionario.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-editar-proprio', acao, nsr: r.nsr });
      return;
    }

    res.status(400).json({ error: "acao precisa ser 'adicionar', 'editar' ou 'remover'" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Pede pro admin liberar a correção de um dia anterior. Só motivo.
async function debugPontoSolicitarCorrecao(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, data, motivo }' }); return; }
  const { token, data, motivo } = req.body || {};
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) { res.status(401).json({ ok: false, error: 'Sessão expirada, faça login de novo.' }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) { res.status(400).json({ error: 'Data inválida (use AAAA-MM-DD).' }); return; }
  if (!motivo || !String(motivo).trim()) { res.status(400).json({ error: 'Informe o motivo do pedido.' }); return; }

  const db = getDb();
  await garantirEsquemaPonto(db);
  const jaTem = await db.execute({
    sql: "SELECT id FROM solicitacoes_ponto WHERE funcionario_id = ? AND data_referente = ? AND status = 'pendente'",
    args: [funcionario.id, data],
  });
  if (jaTem.rows[0]) { res.status(409).json({ ok: false, error: 'Você já tem um pedido pendente pra esse dia.' }); return; }

  await db.execute({
    sql: `INSERT INTO solicitacoes_ponto (id, funcionario_id, data_referente, motivo, status, criada_em)
          VALUES (?, ?, ?, ?, 'pendente', ?)`,
    args: [`${funcionario.id}:${data}:${Date.now()}`, funcionario.id, data, String(motivo).trim().slice(0, 500), new Date().toISOString()],
  });
  res.status(200).json({ ok: true, tipo: 'ponto-solicitar-correcao', data });
}

// Só pra gestão (CRON_SECRET) -- marca quem são os admins do painel de ponto.
async function debugPontoDefinirAdmins(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { nomes: ["Fulano", ...] }' }); return; }
  const nomes = (req.body && req.body.nomes) || [];
  if (!Array.isArray(nomes) || !nomes.length) { res.status(400).json({ error: 'Use POST { nomes: [...] }' }); return; }
  const db = getDb();
  await db.execute('UPDATE funcionarios SET admin = 0');
  for (const nome of nomes) {
    await db.execute({ sql: 'UPDATE funcionarios SET admin = 1 WHERE lower(nome) = lower(?)', args: [String(nome).trim()] });
  }
  const rs = await db.execute('SELECT nome FROM funcionarios WHERE admin = 1 ORDER BY nome');
  res.status(200).json({ ok: true, tipo: 'ponto-definir-admins', admins: rs.rows.map((r) => r.nome) });
}

// ===== Painel de administração do ponto =====
// Chamado pelo site do admin (outro domínio) com o PONTO_PUBLIC_SECRET na porta
// + um token de login (ponto-login) de alguém com admin = 1, que é o gate real.
async function exigirAdmin(req, res, db) {
  const resultado = await obterAdminSessao((req.body && req.body.token) || req.query.token, db);
  if (resultado.erro) { res.status(resultado.status).json({ ok: false, error: resultado.erro }); return null; }
  await garantirEsquemaPonto(db);
  return resultado.funcionario;
}

// Admin: define razão social / CNPJ / endereço + ajustes (limite de batidas
// por dia, tolerância em minutos).
async function debugPontoAdminEmpresa(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, empresa, cnpj, endereco, limite_batidas_dia, tolerancia_min }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;
  const { empresa, cnpj, endereco, limite_batidas_dia, tolerancia_min } = req.body || {};
  const pares = [
    ['empresa', empresa], ['cnpj', cnpj], ['endereco', endereco],
    ['limite_batidas_dia', limite_batidas_dia], ['tolerancia_min', tolerancia_min],
  ];
  for (const [k, v] of pares) {
    if (v == null || v === '') continue;
    await db.execute({
      sql: 'INSERT INTO config_ponto (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
      args: [k, String(v).trim()],
    });
  }
  res.status(200).json({ ok: true, tipo: 'ponto-admin-empresa', config: await configPonto(db) });
}

async function debugPontoAdminVisao(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, de, ate }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { de, ate } = req.body || {};
  const validaDia = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const inicioISO = validaDia(de) ? isoDeDiaHoraLoja(de, '00:00') : new Date(Date.now() - 30 * 864e5).toISOString();
  const fimISO = validaDia(ate) ? isoDeDiaHoraLoja(ate, '23:59') : new Date().toISOString();

  // pega uma janela um pouco maior que o período pra não perder ajustes
  // feitos fora dele que corrigem marcações de dentro.
  const janelaISO = new Date(new Date(inicioISO).getTime() - 90 * 864e5).toISOString();

  const funcs = await db.execute('SELECT id, nome, admin, cpf FROM funcionarios WHERE ativo = 1 ORDER BY nome');
  const regs = await db.execute({
    sql: `SELECT id, funcionario_id, tipo, registrado_em, metodo_validacao, latitude, longitude,
                 distancia_metros, origem, motivo, editado_por, editado_em, nsr, hash, ref_nsr
          FROM registros_ponto WHERE registrado_em >= ? ORDER BY nsr`,
    args: [janelaISO],
  });
  const sols = await db.execute(
    `SELECT id, funcionario_id, data_referente, motivo, status, criada_em, resolvida_em, resolvida_por, resposta_admin
     FROM solicitacoes_ponto ORDER BY criada_em DESC LIMIT 300`
  );

  const jorn = await db.execute(
    'SELECT funcionario_id, dia_semana, minutos_previstos, entrada_ref, saida_ref, intervalo_min FROM jornadas_ponto'
  );
  const abon = await db.execute('SELECT funcionario_id, data, tipo, observacao FROM abonos_ponto');

  const porFunc = new Map(funcs.rows.map((f) => [f.id, {
    id: f.id, nome: f.nome, admin: f.admin === 1, cpf: f.cpf || null,
    registros: [], marcacoes: [], solicitacoes: [], jornada: null, abonos: [],
  }]));
  const rawPorFunc = new Map();
  regs.rows.forEach((r) => {
    if (!rawPorFunc.has(r.funcionario_id)) rawPorFunc.set(r.funcionario_id, []);
    rawPorFunc.get(r.funcionario_id).push(r);
    const f = porFunc.get(r.funcionario_id);
    if (f && r.registrado_em >= inicioISO && r.registrado_em <= fimISO) f.registros.push(r);
  });
  for (const [fid, linhas] of rawPorFunc) {
    const f = porFunc.get(fid);
    if (f) f.marcacoes = resolverMarcacoes(linhas).filter((m) => m.registrado_em >= inicioISO && m.registrado_em <= fimISO);
  }
  sols.rows.forEach((s) => { const f = porFunc.get(s.funcionario_id); if (f) f.solicitacoes.push(s); });
  abon.rows.forEach((a) => { const f = porFunc.get(a.funcionario_id); if (f) f.abonos.push({ data: a.data, tipo: a.tipo, observacao: a.observacao }); });
  jorn.rows.forEach((j) => {
    const f = porFunc.get(j.funcionario_id);
    if (!f) return;
    if (!f.jornada) f.jornada = Array.from({ length: 7 }, () => ({ minutos: 0, entrada: null, saida: null, intervalo: 0 }));
    const d = Number(j.dia_semana);
    if (d >= 0 && d <= 6) f.jornada[d] = {
      minutos: Number(j.minutos_previstos) || 0, entrada: j.entrada_ref || null,
      saida: j.saida_ref || null, intervalo: Number(j.intervalo_min) || 0,
    };
  });

  res.status(200).json({
    ok: true, tipo: 'ponto-admin-visao',
    hoje: dataFusoLoja(new Date()),
    periodo: { de: validaDia(de) ? de : dataFusoLoja(inicioISO), ate: validaDia(ate) ? ate : dataFusoLoja(fimISO) },
    funcionarios: [...porFunc.values()],
    pendentes: sols.rows.filter((s) => s.status === 'pendente').length,
    empresa: await configPonto(db),
  });
}

// Admin define/atualiza a jornada de um funcionário. dias = array de
// { dia_semana (0-6), entrada "HH:MM", saida "HH:MM", intervalo_min }.
// Dia ausente do array vira folga (minutos 0).
async function debugPontoAdminJornada(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, funcionario_id, dias }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { funcionario_id, dias } = req.body || {};
  if (!funcionario_id || !Array.isArray(dias)) { res.status(400).json({ error: 'Use POST { funcionario_id, dias: [...] }' }); return; }

  const minutosEntre = (ent, sai, inter) => {
    const p = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
    let bruto = p(sai) - p(ent);
    if (bruto < 0) bruto += 1440;
    return Math.max(bruto - (Number(inter) || 0), 0);
  };

  await db.execute({ sql: 'DELETE FROM jornadas_ponto WHERE funcionario_id = ?', args: [funcionario_id] });
  for (const d of dias) {
    const ds = Number(d.dia_semana);
    if (!(ds >= 0 && ds <= 6) || !/^\d{1,2}:\d{2}$/.test(d.entrada || '') || !/^\d{1,2}:\d{2}$/.test(d.saida || '')) continue;
    const inter = Number(d.intervalo_min) || 0;
    await db.execute({
      sql: `INSERT INTO jornadas_ponto (funcionario_id, dia_semana, minutos_previstos, entrada_ref, saida_ref, intervalo_min)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [funcionario_id, ds, minutosEntre(d.entrada, d.saida, inter), d.entrada, d.saida, inter],
    });
  }
  res.status(200).json({ ok: true, tipo: 'ponto-admin-jornada', funcionario_id, jornada: await jornadaSemana(db, funcionario_id) });
}

// Só pra gestão (CRON_SECRET) -- bulk das jornadas (usado pelo script de setup).
async function debugPontoConfigJornadas(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { jornadas: { <funcionario_id>: [dias...] } }' }); return; }
  const jornadas = (req.body && req.body.jornadas) || {};
  const db = getDb();
  const minutosEntre = (ent, sai, inter) => {
    const p = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
    let bruto = p(sai) - p(ent);
    if (bruto < 0) bruto += 1440;
    return Math.max(bruto - (Number(inter) || 0), 0);
  };
  const feitos = [];
  for (const [fid, dias] of Object.entries(jornadas)) {
    await db.execute({ sql: 'DELETE FROM jornadas_ponto WHERE funcionario_id = ?', args: [fid] });
    for (const d of dias || []) {
      const inter = Number(d.intervalo_min) || 0;
      await db.execute({
        sql: `INSERT INTO jornadas_ponto (funcionario_id, dia_semana, minutos_previstos, entrada_ref, saida_ref, intervalo_min)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [fid, Number(d.dia_semana), minutosEntre(d.entrada, d.saida, inter), d.entrada, d.saida, inter],
      });
    }
    feitos.push(fid);
  }
  res.status(200).json({ ok: true, tipo: 'ponto-config-jornadas', funcionarios: feitos });
}

// Só pra TESTE (CRON_SECRET) -- injeta batidas de exemplo. dias = array de
// { data "AAAA-MM-DD", marcacoes: ["HH:MM", ...] } -- cada horário vira uma
// batida 'batida' alternando entrada/saída, na cadeia normal.
async function debugPontoConfigSimular(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { funcionario_id, dias }' }); return; }
  const { funcionario_id, dias } = req.body || {};
  if (!funcionario_id || !Array.isArray(dias)) { res.status(400).json({ error: 'Use POST { funcionario_id, dias: [{data, marcacoes:[...]}] }' }); return; }
  const db = getDb();
  let n = 0;
  for (const d of dias) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.data || ''))) continue;
    const horas = (d.marcacoes || []).slice().sort();
    for (let i = 0; i < horas.length; i++) {
      const iso = isoDeDiaHoraLoja(d.data, horas[i]);
      await inserirRegistroPonto(db, {
        funcionario_id, tipo: i % 2 === 0 ? 'entrada' : 'saida', registrado_em: iso,
        metodo_validacao: 'simulado', origem: 'batida',
      });
      n += 1;
    }
  }
  res.status(200).json({ ok: true, tipo: 'ponto-config-simular', batidas_inseridas: n });
}

async function debugPontoAdminEditar(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, funcionario_id, acao, ... }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { funcionario_id, acao, ref_nsr, tipo, dia, hora, motivo } = req.body || {};
  if (!motivo || !String(motivo).trim()) { res.status(400).json({ error: 'Informe o motivo da alteração.' }); return; }
  const motivoLimpo = String(motivo).trim().slice(0, 500);

  try {
    if (acao === 'adicionar') {
      if (!funcionario_id || !['entrada', 'saida'].includes(tipo)) { res.status(400).json({ error: 'Informe funcionário, tipo e hora.' }); return; }
      const iso = isoDeDiaHoraLoja(dia, hora);
      const r = await inserirRegistroPonto(db, {
        funcionario_id, tipo, registrado_em: iso, origem: 'ajuste_inclusao',
        motivo: motivoLimpo, autor_id: admin.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-admin-editar', acao, nsr: r.nsr });
      return;
    }

    // acha a marcação vigente pelo NSR
    const rs = await db.execute({
      sql: `SELECT nsr, funcionario_id, tipo, registrado_em, origem, ref_nsr
            FROM registros_ponto WHERE funcionario_id = ? ORDER BY nsr`,
      args: [funcionario_id],
    });
    const m = resolverMarcacoes(rs.rows).find((x) => x.nsr === Number(ref_nsr));
    if (!m) { res.status(404).json({ error: 'Batida não encontrada.' }); return; }

    if (acao === 'remover') {
      const r = await inserirRegistroPonto(db, {
        funcionario_id, tipo: m.tipo, registrado_em: m.registrado_em,
        origem: 'ajuste_exclusao', ref_nsr: m.nsr, motivo: motivoLimpo, autor_id: admin.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-admin-editar', acao, nsr: r.nsr });
      return;
    }
    if (acao === 'editar') {
      const diaBase = /^\d{4}-\d{2}-\d{2}$/.test(String(dia || '')) ? dia : dataFusoLoja(m.registrado_em);
      const iso = isoDeDiaHoraLoja(diaBase, hora);
      const r = await inserirRegistroPonto(db, {
        funcionario_id, tipo: ['entrada', 'saida'].includes(tipo) ? tipo : m.tipo,
        registrado_em: iso, origem: 'ajuste_alteracao', ref_nsr: m.nsr,
        motivo: motivoLimpo, autor_id: admin.id,
      });
      res.status(200).json({ ok: true, tipo: 'ponto-admin-editar', acao, nsr: r.nsr });
      return;
    }
    res.status(400).json({ error: "acao precisa ser 'adicionar', 'editar' ou 'remover'" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Verifica a cadeia de hash de todos os registros (só admin).
async function debugPontoAdminIntegridade(req, res) {
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const rs = await db.execute('SELECT nsr, funcionario_id, tipo, registrado_em, origem, ref_nsr, cnpj, hash, hash_anterior FROM registros_ponto WHERE nsr IS NOT NULL ORDER BY nsr');
  let anterior = '0'.repeat(64);
  const quebras = [];
  for (const r of rs.rows) {
    const esperado = hashRegistro(anterior, r);
    if (r.hash !== esperado) quebras.push({ nsr: Number(r.nsr), registrado_em: r.registrado_em });
    anterior = r.hash;
  }
  res.status(200).json({
    ok: true, tipo: 'ponto-admin-integridade',
    total: rs.rows.length, ultimo_nsr: rs.rows.length ? Number(rs.rows[rs.rows.length - 1].nsr) : 0,
    integro: quebras.length === 0, quebras,
  });
}

// Bootstrap (CRON_SECRET): atribui NSR + cadeia de hash aos registros que já
// existiam antes da Fase 4. Roda uma vez. Idempotente: se todos já têm nsr,
// não faz nada.
async function debugPontoReindexarCadeia(req, res) {
  const db = getDb();
  const cfg = await configPonto(db);
  const rs = await db.execute("SELECT id, funcionario_id, tipo, registrado_em, origem FROM registros_ponto ORDER BY registrado_em, id");
  let anterior = '0'.repeat(64);
  let n = 0;
  for (const r of rs.rows) {
    n += 1;
    const origem = (r.origem && ['batida', 'ajuste_inclusao', 'ajuste_alteracao', 'ajuste_exclusao'].includes(r.origem)) ? r.origem : 'batida';
    const linha = { nsr: n, funcionario_id: r.funcionario_id, tipo: r.tipo, registrado_em: r.registrado_em, origem, ref_nsr: '', cnpj: cfg.cnpj || '' };
    const hash = hashRegistro(anterior, linha);
    await db.execute({
      sql: "UPDATE registros_ponto SET nsr = ?, hash = ?, hash_anterior = ?, origem = ?, cnpj = ?, ref_nsr = NULL WHERE id = ?",
      args: [n, hash, anterior, origem, cfg.cnpj || null, r.id],
    });
    anterior = hash;
  }
  res.status(200).json({ ok: true, tipo: 'ponto-reindexar-cadeia', registros_reindexados: n });
}

// Config do empregador pro comprovante/AFD (CRON_SECRET).
async function debugPontoConfigEmpresa(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { empresa, cnpj, endereco }' }); return; }
  const { empresa, cnpj, endereco } = req.body || {};
  const db = getDb();
  for (const [chave, valor] of [['empresa', empresa], ['cnpj', cnpj], ['endereco', endereco]]) {
    if (valor == null) continue;
    await db.execute({
      sql: 'INSERT INTO config_ponto (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor',
      args: [chave, String(valor)],
    });
  }
  res.status(200).json({ ok: true, tipo: 'ponto-config-empresa', config: await configPonto(db) });
}

// Abono / atestado de um dia (só admin). Um dia abonado não gera falta.
const TIPOS_ABONO = ['atestado', 'ferias', 'folga', 'falta_abonada', 'feriado', 'licenca', 'outro'];
async function debugPontoAdminAbono(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, funcionario_id, data, tipo, observacao } ou { ..., remover:true }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { funcionario_id, data, tipo, observacao, remover } = req.body || {};
  if (!funcionario_id || !/^\d{4}-\d{2}-\d{2}$/.test(String(data || ''))) {
    res.status(400).json({ error: 'Informe funcionario_id e data (AAAA-MM-DD).' }); return;
  }
  if (remover) {
    await db.execute({ sql: 'DELETE FROM abonos_ponto WHERE funcionario_id = ? AND data = ?', args: [funcionario_id, data] });
    res.status(200).json({ ok: true, tipo: 'ponto-admin-abono', acao: 'remover' });
    return;
  }
  if (!TIPOS_ABONO.includes(tipo)) { res.status(400).json({ error: 'tipo inválido. Use: ' + TIPOS_ABONO.join(', ') }); return; }
  await db.execute({
    sql: `INSERT INTO abonos_ponto (funcionario_id, data, tipo, observacao, criado_por, criado_em)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(funcionario_id, data) DO UPDATE SET tipo = excluded.tipo, observacao = excluded.observacao,
            criado_por = excluded.criado_por, criado_em = excluded.criado_em`,
    args: [funcionario_id, data, tipo, String(observacao || '').slice(0, 500), admin.id, new Date().toISOString()],
  });
  res.status(200).json({ ok: true, tipo: 'ponto-admin-abono', acao: 'salvar' });
}

async function debugPontoAdminResolver(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, solicitacao_id, decisao }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { solicitacao_id, decisao, resposta } = req.body || {};
  if (!['aprovar', 'recusar'].includes(decisao)) { res.status(400).json({ error: "decisao precisa ser 'aprovar' ou 'recusar'" }); return; }
  const status = decisao === 'aprovar' ? 'aprovada' : 'recusada';
  const r = await db.execute({
    sql: `UPDATE solicitacoes_ponto SET status = ?, resolvida_em = ?, resolvida_por = ?, resposta_admin = ?
          WHERE id = ? AND status = 'pendente'`,
    args: [status, new Date().toISOString(), admin.id, String(resposta || '').slice(0, 500), solicitacao_id],
  });
  if (!r.rowsAffected) { res.status(409).json({ ok: false, error: 'Pedido não encontrado ou já resolvido.' }); return; }
  res.status(200).json({ ok: true, tipo: 'ponto-admin-resolver', status });
}

// Só pra gestão (protegido pelo CRON_SECRET, não pelo secret público) --
// lista os registros de presença dos últimos N dias.
async function debugPontoRelatorio(req, res) {
  const dias = Math.min(parseInt(req.query.dias, 10) || 30, 90);
  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  const db = getDb();
  const rs = await db.execute({
    sql: `SELECT r.registrado_em, r.tipo, r.metodo_validacao, r.distancia_metros, f.nome
          FROM registros_ponto r JOIN funcionarios f ON f.id = r.funcionario_id
          WHERE r.registrado_em >= ? ORDER BY r.registrado_em DESC`,
    args: [desde],
  });
  res.status(200).json({ ok: true, tipo: 'ponto-relatorio', periodo_dias: dias, total: rs.rows.length, registros: rs.rows });
}

// Só pra gestão -- cadastra/atualiza um funcionário (nome + PIN + CPF opcional).
async function debugPontoCadastrarFuncionario(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { id, nome, pin, cpf? }' }); return; }
  const { id, nome, pin, cpf } = req.body || {};
  if (!id || !nome || !pin) { res.status(400).json({ error: 'Use POST { id, nome, pin }' }); return; }

  const db = getDb();
  await db.execute({
    sql: `INSERT INTO funcionarios (id, nome, pin_hash, ativo, criado_em) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, pin_hash = excluded.pin_hash, ativo = 1`,
    args: [id, nome, hashPin(pin), new Date().toISOString()],
  });
  if (cpf != null) {
    await db.execute({ sql: 'UPDATE funcionarios SET cpf = ? WHERE id = ?', args: [String(cpf).replace(/\D/g, '') || null, id] });
  }
  res.status(200).json({ ok: true, tipo: 'ponto-cadastrar-funcionario', id, nome });
}

// Admin: define o CPF de um funcionário (pro comprovante/AFD).
async function debugPontoAdminCpf(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, funcionario_id, cpf }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;
  const { funcionario_id, cpf } = req.body || {};
  if (!funcionario_id) { res.status(400).json({ error: 'Informe funcionario_id.' }); return; }
  await db.execute({ sql: 'UPDATE funcionarios SET cpf = ? WHERE id = ?', args: [String(cpf || '').replace(/\D/g, '') || null, funcionario_id] });
  res.status(200).json({ ok: true, tipo: 'ponto-admin-cpf' });
}

// AFD -- Arquivo Fonte de Dados (Portaria MTP 671/2021), best-effort.
// ⚠️ O layout exato deve ser conferido com o contador / software do DP antes
// de usar oficialmente -- este arquivo serve pra conferência e importação
// assistida, não como AFD assinado de REP-P certificado.
async function debugPontoAdminAFD(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST { token, de, ate }' }); return; }
  const db = getDb();
  const admin = await exigirAdmin(req, res, db);
  if (!admin) return;

  const { de, ate } = req.body || {};
  const validaDia = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const inicioISO = validaDia(de) ? isoDeDiaHoraLoja(de, '00:00') : new Date(Date.now() - 30 * 864e5).toISOString();
  const fimISO = validaDia(ate) ? isoDeDiaHoraLoja(ate, '23:59') : new Date().toISOString();
  const cfg = await configPonto(db);

  const funcs = await db.execute('SELECT id, nome, cpf FROM funcionarios');
  const cpfPorId = new Map(funcs.rows.map((f) => [f.id, (f.cpf || '').replace(/\D/g, '')]));

  const rs = await db.execute({
    sql: `SELECT nsr, funcionario_id, tipo, registrado_em, origem, ref_nsr, hash
          FROM registros_ponto WHERE nsr IS NOT NULL AND registrado_em >= ? AND registrado_em <= ? ORDER BY nsr`,
    args: [inicioISO, fimISO],
  });

  const isoLoja = (s) => {
    const d = new Date(s);
    const p = (n) => String(n).padStart(2, '0');
    const t = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
    return t.replace(' ', 'T') + '-03:00';
  };
  const pad = (v, n) => String(v == null ? '' : v).padEnd(n).slice(0, n);
  const padN = (v, n) => String(v == null ? '' : v).replace(/\D/g, '').padStart(n, '0').slice(-n);

  const linhas = [];
  const cnpj14 = padN(cfg.cnpj, 14);
  // tipo 1 -- cabeçalho
  linhas.push(`${padN('', 9)}1${'1'}${cnpj14}${padN('', 12)}${pad(cfg.empresa, 150)}${isoLoja(inicioISO)}${isoLoja(fimISO)}${isoLoja(new Date().toISOString())}`);
  // tipo 3 -- marcações (batida + ajustes)
  let qtd3 = 0;
  for (const r of rs.rows) {
    const flag = r.origem === 'batida' ? 'P' : r.origem === 'ajuste_exclusao' ? 'X' : 'A';
    linhas.push(`${padN(r.nsr, 9)}3${isoLoja(r.registrado_em)}${padN(cpfPorId.get(r.funcionario_id), 12)}${flag}${r.hash || ''}`);
    qtd3 += 1;
  }
  // tipo 9 -- trailer
  linhas.push(`${padN('', 9)}9${padN(0, 9)}${padN(0, 9)}${padN(qtd3, 9)}${padN(0, 9)}${padN(0, 9)}9`);

  const afd = linhas.join('\r\n') + '\r\n';
  res.status(200).json({
    ok: true, tipo: 'ponto-admin-afd',
    nome_arquivo: `AFD_${(cfg.cnpj || 'empresa').replace(/\D/g, '')}_${validaDia(de) ? de : dataFusoLoja(inicioISO)}_${validaDia(ate) ? ate : dataFusoLoja(fimISO)}.txt`,
    registros: qtd3, afd,
    aviso: 'Layout best-effort da Portaria 671/2021 (P=batida, A=ajuste, X=exclusão). Confira com o contador/DP antes de uso oficial.',
  });
}

// Rotas chamadas direto do app nativo (Ricapet) sem exigir o CRON_SECRET --
// usam o PONTO_PUBLIC_SECRET, próprio e mais fraco, mesma lógica do
// ESTOQUE_PUBLIC_SECRET abaixo.
const TIPOS_PUBLICOS_PONTO = new Set([
  'ponto-funcionarios', 'ponto-login', 'ponto-bater', 'ponto-historico',
  'ponto-editar-proprio', 'ponto-solicitar-correcao', 'ponto-validar-token',
  'ponto-admin-visao', 'ponto-admin-editar', 'ponto-admin-resolver', 'ponto-admin-jornada',
  'ponto-admin-integridade', 'ponto-admin-cpf', 'ponto-admin-afd', 'ponto-admin-abono',
  'ponto-admin-empresa',
]);

// Rotas chamadas direto do navegador (botão/tela em painel-estoque-adesivo,
// outro projeto) — usam o ESTOQUE_PUBLIC_SECRET, mais fraco, em vez do
// CRON_SECRET (que também protege rotas sensíveis como troca de token
// OAuth), pra não expor esse último num arquivo client-side.
const TIPOS_PUBLICOS_ESTOQUE = new Set(['importar-contagem-fisica', 'importar-saldo-da-planilha', 'estoque-saldo', 'completar-catalogo-faltante', 'corrigir-cor-arranhador-adesivo-bege', 'estoque-contagem-get', 'estoque-contagem-set', 'estoque-sheets-log']);

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const isRotaPublicaEstoque = TIPOS_PUBLICOS_ESTOQUE.has(req.query.tipo);
  const isRotaPublicaPonto = TIPOS_PUBLICOS_PONTO.has(req.query.tipo);
  if (isRotaPublicaEstoque || isRotaPublicaPonto) {
    // ponto-login/ponto-bater são POST com Content-Type: application/json,
    // o que faz o navegador mandar um preflight OPTIONS antes -- precisa
    // responder Allow-Methods/Allow-Headers, não só Allow-Origin (que
    // bastava pras rotas GET simples do Estoque).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  }
  const estoquePublicSecret = process.env.ESTOQUE_PUBLIC_SECRET;
  const pontoPublicSecret = process.env.PONTO_PUBLIC_SECRET;
  const secretAutorizado =
    (cronSecret && req.query.secret === cronSecret) ||
    (isRotaPublicaEstoque && estoquePublicSecret && req.query.secret === estoquePublicSecret) ||
    (isRotaPublicaPonto && pontoPublicSecret && req.query.secret === pontoPublicSecret);
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
    if (req.query.tipo === 'flex-status') return await debugFlexStatus(req, res);
    if (req.query.tipo === 'historico-todos-row') return await debugHistoricoTodosRow(req, res);
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
    if (req.query.tipo === 'importar-saldo-da-planilha') return await debugImportarSaldoDaPlanilha(req, res);
    if (req.query.tipo === 'estoque-saldo') return await debugEstoqueSaldo(req, res);
    if (req.query.tipo === 'estoque-contagem-get') return await debugEstoqueContagemGet(req, res);
    if (req.query.tipo === 'estoque-contagem-set') return await debugEstoqueContagemSet(req, res);
    if (req.query.tipo === 'estoque-sheets-log') return await debugEstoqueSheetsLog(req, res);
    if (req.query.tipo === 'completar-catalogo-faltante') return await debugCompletarCatalogoFaltante(req, res);
    if (req.query.tipo === 'corrigir-cor-arranhador-adesivo-bege') return await debugCorrigirCorArranhadorAdesivoBege(req, res);
    if (req.query.tipo === 'balanco-mensal') return await debugBalancoMensal(req, res);
    if (req.query.tipo === 'ponto-funcionarios') return await debugPontoFuncionarios(req, res);
    if (req.query.tipo === 'ponto-login') return await debugPontoLogin(req, res);
    if (req.query.tipo === 'ponto-validar-token') return await debugPontoValidarToken(req, res);
    if (req.query.tipo === 'ponto-bater') return await debugPontoBater(req, res);
    if (req.query.tipo === 'ponto-historico') return await debugPontoHistorico(req, res);
    if (req.query.tipo === 'ponto-editar-proprio') return await debugPontoEditarProprio(req, res);
    if (req.query.tipo === 'ponto-solicitar-correcao') return await debugPontoSolicitarCorrecao(req, res);
    if (req.query.tipo === 'ponto-definir-admins') return await debugPontoDefinirAdmins(req, res);
    if (req.query.tipo === 'ponto-admin-visao') return await debugPontoAdminVisao(req, res);
    if (req.query.tipo === 'ponto-admin-editar') return await debugPontoAdminEditar(req, res);
    if (req.query.tipo === 'ponto-admin-resolver') return await debugPontoAdminResolver(req, res);
    if (req.query.tipo === 'ponto-admin-abono') return await debugPontoAdminAbono(req, res);
    if (req.query.tipo === 'ponto-admin-empresa') return await debugPontoAdminEmpresa(req, res);
    if (req.query.tipo === 'ponto-admin-jornada') return await debugPontoAdminJornada(req, res);
    if (req.query.tipo === 'ponto-admin-integridade') return await debugPontoAdminIntegridade(req, res);
    if (req.query.tipo === 'ponto-admin-cpf') return await debugPontoAdminCpf(req, res);
    if (req.query.tipo === 'ponto-admin-afd') return await debugPontoAdminAFD(req, res);
    if (req.query.tipo === 'ponto-config-jornadas') return await debugPontoConfigJornadas(req, res);
    if (req.query.tipo === 'ponto-config-simular') return await debugPontoConfigSimular(req, res);
    if (req.query.tipo === 'ponto-config-empresa') return await debugPontoConfigEmpresa(req, res);
    if (req.query.tipo === 'ponto-reindexar-cadeia') return await debugPontoReindexarCadeia(req, res);
    if (req.query.tipo === 'ponto-relatorio') return await debugPontoRelatorio(req, res);
    if (req.query.tipo === 'ponto-cadastrar-funcionario') return await debugPontoCadastrarFuncionario(req, res);
    res.status(400).json({ error: 'Use ?tipo=ml-claims, ?tipo=ml-shipment, ?tipo=ml-sla, ?tipo=shopee-returns, ?tipo=shopee-channels, ?tipo=criar-tabelas, ?tipo=migrar-redis-turso, ?tipo=corrigir-shipment-id ou ?tipo=adicionar-coluna-tipo' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
