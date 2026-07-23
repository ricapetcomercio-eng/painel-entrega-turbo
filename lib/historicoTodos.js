// lib/historicoTodos.js
// Grava/atualiza TODOS os pedidos no histórico geral (tabela historico_todos
// no Turso — migrado do Redis compartilhado, que estourava cota),
// independente da forma de entrega OU do marketplace (Mercado Livre e
// Shopee compartilham esta mesma tabela).

const { getDb } = require('./db');

function paraInteiroBooleano(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

function paraBooleano(v) {
  if (v === 1) return true;
  if (v === 0) return false;
  return null;
}

function linhaParaPedido(row) {
  return {
    marketplace: row.marketplace,
    conta: row.conta,
    order_id: row.order_id,
    date_created: row.date_created,
    total_amount: row.total_amount,
    forma_entrega: row.forma_entrega,
    status_envio: row.status_envio,
    status_pedido: row.status_pedido,
    cancelado: paraBooleano(row.cancelado) || false,
    estado: row.estado,
    cidade: row.cidade,
    categoria: row.categoria,
    coletado: paraBooleano(row.coletado),
    coletado_em: row.coletado_em,
    entregue_em: row.entregue_em,
    horas_ate_coleta: row.horas_ate_coleta,
    horas_ate_entrega: row.horas_ate_entrega,
    prazo_entrega: row.prazo_entrega,
    atrasado: paraBooleano(row.atrasado),
    devolvido: paraBooleano(row.devolvido) || false,
    devolucao_claim_id: row.devolucao_claim_id,
    devolucao_status: row.devolucao_status,
    devolucao_reason_id: row.devolucao_reason_id,
    itens: row.itens ? JSON.parse(row.itens) : [],
  };
}

async function registrarHistoricoTodos(pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };
  const db = getDb();

  // Antes de sobrescrever, busca os registros já existentes para preservar
  // os campos de devolução — eles são preenchidos por um processo separado
  // (enriquecerDevolucoes, em api/collect.js), e o fluxo normal de coleta
  // de pedidos não sabe nada sobre devolução.
  const idsUnicos = pedidos.map((p) => `${p.marketplace || 'mercado_livre'}:${p.order_id}`);
  const existentes = {};
  if (idsUnicos.length > 0) {
    const placeholders = idsUnicos.map(() => '?').join(',');
    const rs = await db.execute({
      sql: `SELECT id_unico, devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id FROM historico_todos WHERE id_unico IN (${placeholders})`,
      args: idsUnicos,
    });
    for (const row of rs.rows) existentes[row.id_unico] = row;
  }

  for (const pedido of pedidos) {
    const marketplace = pedido.marketplace || 'mercado_livre';
    const idUnico = `${marketplace}:${pedido.order_id}`;
    const anterior = existentes[idUnico] || {};
    const dateCreatedTs = new Date(pedido.date_created).getTime();

    const devolvidoInt = typeof pedido.devolvido === 'boolean'
      ? paraInteiroBooleano(pedido.devolvido)
      : (anterior.devolvido != null ? anterior.devolvido : 0);

    await db.execute({
      sql: `INSERT INTO historico_todos (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, forma_entrega, status_envio, status_pedido, cancelado,
              estado, cidade, categoria, coletado, coletado_em, entregue_em,
              horas_ate_coleta, horas_ate_entrega, prazo_entrega, atrasado,
              devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id, itens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_unico) DO UPDATE SET
              marketplace = excluded.marketplace,
              conta = excluded.conta,
              order_id = excluded.order_id,
              date_created = excluded.date_created,
              date_created_ts = excluded.date_created_ts,
              total_amount = excluded.total_amount,
              forma_entrega = excluded.forma_entrega,
              status_envio = excluded.status_envio,
              status_pedido = excluded.status_pedido,
              cancelado = excluded.cancelado,
              estado = excluded.estado,
              cidade = excluded.cidade,
              categoria = excluded.categoria,
              coletado = excluded.coletado,
              coletado_em = excluded.coletado_em,
              entregue_em = excluded.entregue_em,
              horas_ate_coleta = excluded.horas_ate_coleta,
              horas_ate_entrega = excluded.horas_ate_entrega,
              prazo_entrega = excluded.prazo_entrega,
              atrasado = excluded.atrasado,
              devolvido = excluded.devolvido,
              devolucao_claim_id = excluded.devolucao_claim_id,
              devolucao_status = excluded.devolucao_status,
              devolucao_reason_id = excluded.devolucao_reason_id,
              itens = excluded.itens`,
      args: [
        idUnico, marketplace, pedido.conta || null, String(pedido.order_id), pedido.date_created, dateCreatedTs,
        pedido.total_amount, pedido.forma_entrega || 'Não identificado', pedido.status_envio || null,
        pedido.status_pedido || null, paraInteiroBooleano(typeof pedido.cancelado === 'boolean' ? pedido.cancelado : false),
        pedido.estado || null, pedido.cidade || null, pedido.categoria || null,
        paraInteiroBooleano(typeof pedido.coletado === 'boolean' ? pedido.coletado : null),
        pedido.coletado_em || null, pedido.entregue_em || null,
        typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
        typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
        pedido.prazo_entrega || null,
        paraInteiroBooleano(typeof pedido.atrasado === 'boolean' ? pedido.atrasado : null),
        devolvidoInt,
        pedido.devolucao_claim_id || anterior.devolucao_claim_id || null,
        pedido.devolucao_status || anterior.devolucao_status || null,
        pedido.devolucao_reason_id || anterior.devolucao_reason_id || null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  return { gravados: pedidos.length };
}

/**
 * Marca um pedido já existente no histórico como devolvido — usado pelo
 * processo de enriquecimento de devoluções (api/collect.js). Não faz nada
 * se o pedido ainda não estiver no histórico (ex: coletado depois).
 */
async function marcarDevolucao(idUnico, info) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT id_unico FROM historico_todos WHERE id_unico = ?', args: [idUnico] });
  if (!rs.rows[0]) return false;

  await db.execute({
    sql: `UPDATE historico_todos SET devolvido = 1, devolucao_claim_id = ?, devolucao_status = ?, devolucao_reason_id = ? WHERE id_unico = ?`,
    args: [info.claimId || null, info.status || null, info.reasonId || null, idUnico],
  });
  return true;
}

/**
 * Busca pedidos por período (usado por api/analytics-todos-data.js),
 * substituindo o antigo ZRANGE+HMGET do Redis por uma consulta SQL direta.
 */
async function buscarPorPeriodo(desdeTs, ateTs) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT * FROM historico_todos WHERE date_created_ts >= ? AND date_created_ts <= ? ORDER BY date_created_ts ASC',
    args: [desdeTs, ateTs],
  });
  return rs.rows.map(linhaParaPedido);
}

module.exports = { registrarHistoricoTodos, marcarDevolucao, buscarPorPeriodo };
