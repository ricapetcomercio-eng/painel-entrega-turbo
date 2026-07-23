// lib/historicoFlex.js
// Grava/atualiza pedidos Flex no histórico (tabela historico_flex no Turso
// — migrado do Redis compartilhado, que estourava cota). Sempre reflete o
// status mais atual de cada pedido. Usado tanto pela coleta contínua
// (api/collect.js) quanto pelo backfill via API (api/backfill-flex-api.js).

const { getDb } = require('./db');

function linhaParaPedido(row) {
  return {
    marketplace: row.marketplace,
    conta: row.conta,
    order_id: row.order_id,
    date_created: row.date_created,
    total_amount: row.total_amount,
    shipment_id: row.shipment_id,
    coletado: row.coletado === 1 ? true : row.coletado === 0 ? false : null,
    categoria: row.categoria,
    coletado_em: row.coletado_em,
    entregue_em: row.entregue_em,
    horas_ate_coleta: row.horas_ate_coleta,
    horas_ate_entrega: row.horas_ate_entrega,
    itens: row.itens ? JSON.parse(row.itens) : [],
  };
}

async function registrarHistoricoFlex(pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };
  const db = getDb();

  for (const pedido of pedidos) {
    const idUnico = `mercado_livre:${pedido.order_id}`;
    const dateCreatedTs = new Date(pedido.date_created).getTime();
    const coletadoInt = pedido.coletado === true ? 1 : pedido.coletado === false ? 0 : null;

    await db.execute({
      sql: `INSERT INTO historico_flex (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, shipment_id, coletado, categoria, status_envio,
              coletado_em, entregue_em, horas_ate_coleta, horas_ate_entrega, itens
            ) VALUES (?, 'mercado_livre', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
            ON CONFLICT(id_unico) DO UPDATE SET
              conta = excluded.conta,
              order_id = excluded.order_id,
              date_created = excluded.date_created,
              date_created_ts = excluded.date_created_ts,
              total_amount = excluded.total_amount,
              shipment_id = excluded.shipment_id,
              coletado = excluded.coletado,
              categoria = excluded.categoria,
              coletado_em = excluded.coletado_em,
              entregue_em = excluded.entregue_em,
              horas_ate_coleta = excluded.horas_ate_coleta,
              horas_ate_entrega = excluded.horas_ate_entrega,
              itens = excluded.itens`,
      args: [
        idUnico, pedido.conta || null, String(pedido.order_id), pedido.date_created, dateCreatedTs,
        pedido.total_amount, pedido.shipment_id || null, coletadoInt,
        pedido.categoria || (pedido.coletado ? 'coletado' : 'aguardando'),
        pedido.coletado_em || null, pedido.entregue_em || null,
        typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
        typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  return { gravados: pedidos.length };
}

/**
 * Lista os registros dos últimos N (padrão 48h) — usado tanto pra montar o
 * "snapshot ao vivo" (sem precisar rebuscar tudo na API do ML) quanto pra
 * achar quais pedidos ainda estão "aguardando" e precisam ser reverificados.
 */
async function listarRecentes(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const rs = await db.execute({
    sql: 'SELECT * FROM historico_flex WHERE date_created_ts >= ? ORDER BY date_created_ts ASC',
    args: [desde],
  });
  return rs.rows.map(linhaParaPedido);
}

module.exports = { registrarHistoricoFlex, listarRecentes };
