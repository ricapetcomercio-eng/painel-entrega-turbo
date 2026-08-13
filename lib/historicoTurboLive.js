// lib/historicoTurboLive.js
// Grava/atualiza pedidos Shopee Entrega Turbo no rastreamento "ao vivo"
// (tabela historico_turbo_live no Turso). Diferente de historico_turbo
// (log permanente, grava uma vez e nunca atualiza), esta tabela sempre
// reflete o status mais atual de cada pedido — mesmo espírito de
// lib/historicoFlex.js, pro Flex do ML.
//
// Sem isso, o bucket Turbo "ao vivo" era reconstruído do zero a cada ciclo
// a partir só das últimas 6h — um pedido Turbo que ficasse preso (nunca
// coletado) desaparecia do painel depois de 6h, mesmo continuando parado
// de verdade.

const { getDb } = require('./db');

function linhaParaPedido(row) {
  return {
    marketplace: row.marketplace,
    conta: row.conta,
    order_id: row.order_id,
    date_created: row.date_created,
    total_amount: row.total_amount,
    categoria: row.categoria,
    status_pedido: row.status_pedido,
    resolvido_em: row.resolvido_em,
    deadline: row.deadline,
    itens: row.itens ? JSON.parse(row.itens) : [],
  };
}

async function registrarHistoricoTurboLive(pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };
  const db = getDb();

  for (const pedido of pedidos) {
    const idUnico = `shopee:${pedido.order_id}`;
    const dateCreatedTs = new Date(pedido.date_created).getTime();

    await db.execute({
      sql: `INSERT INTO historico_turbo_live (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, categoria, status_pedido, resolvido_em, deadline, itens
            ) VALUES (?, 'shopee', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_unico) DO UPDATE SET
              conta = excluded.conta,
              order_id = excluded.order_id,
              date_created = excluded.date_created,
              date_created_ts = excluded.date_created_ts,
              total_amount = excluded.total_amount,
              categoria = excluded.categoria,
              status_pedido = excluded.status_pedido,
              resolvido_em = excluded.resolvido_em,
              deadline = excluded.deadline,
              itens = excluded.itens`,
      args: [
        idUnico, pedido.conta || null, String(pedido.order_id), pedido.date_created, dateCreatedTs,
        pedido.total_amount, pedido.categoria || 'aguardando', pedido.status_pedido || null,
        pedido.resolvido_em || null, pedido.deadline || null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  return { gravados: pedidos.length };
}

/**
 * Lista os registros dos últimos N (padrão 48h) — usado pra montar o
 * snapshot ao vivo. Inclui TAMBÉM qualquer pedido "aguardando" independente
 * da idade, mesmo motivo do listarRecentes do Flex: sem isso, um pedido
 * Turbo preso há dias fica invisível pra sempre.
 */
async function listarRecentesTurbo(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const rs = await db.execute({
    sql: "SELECT * FROM historico_turbo_live WHERE date_created_ts >= ? OR categoria = 'aguardando' ORDER BY date_created_ts ASC",
    args: [desde],
  });
  return rs.rows.map(linhaParaPedido);
}

module.exports = { registrarHistoricoTurboLive, listarRecentesTurbo };
