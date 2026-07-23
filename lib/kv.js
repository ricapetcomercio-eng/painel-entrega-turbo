// lib/kv.js
// Substituto simples de get/set/del do Redis, usando a tabela kv_simples
// do Turso. Serializa valores automaticamente em JSON (o Upstash fazia
// isso de forma transparente; aqui replicamos o mesmo comportamento).

const { getDb } = require('./db');

async function kvGet(chave) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT valor FROM kv_simples WHERE chave = ?', args: [chave] });
  if (!rs.rows[0]) return null;
  const valor = rs.rows[0].valor;
  if (valor === null || valor === undefined) return null;
  try {
    return JSON.parse(valor);
  } catch (e) {
    return valor; // valor não-JSON (string simples) — devolve como veio
  }
}

async function kvSet(chave, valor) {
  const db = getDb();
  const serializado = typeof valor === 'string' ? valor : JSON.stringify(valor);
  await db.execute({
    sql: `INSERT INTO kv_simples (chave, valor, atualizado_em) VALUES (?, ?, ?)
          ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = excluded.atualizado_em`,
    args: [chave, serializado, Date.now()],
  });
}

async function kvDel(chave) {
  const db = getDb();
  await db.execute({ sql: 'DELETE FROM kv_simples WHERE chave = ?', args: [chave] });
}

module.exports = { kvGet, kvSet, kvDel };
