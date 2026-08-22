// lib/estoqueSaldo.js
// Saldo de estoque que desce sozinho a cada venda gravada em historico_todos
// (ver lib/historicoTodos.js) e volta a subir se o pedido for cancelado ou
// devolvido depois. Começa do valor da última contagem física importada do
// painel-estoque-adesivo (importarContagemFisica) e manda um balanço
// mensal pra mesma planilha Google que a contagem física já usa
// (enviarBalancoMensalSeNecessario / enviarBalancoAgora), reaproveitando o
// Apps Script "EstoqueMobile_Corrigido.gs" já publicado (aba "Estoque
// Ricapet") — não muda nada do lado do Apps Script, só posta no mesmo
// formato que estoque.html já posta.
//
// Variáveis de ambiente necessárias:
//   JSONBIN_ESTOQUE_API_KEY, JSONBIN_ESTOQUE_BIN_ID — mesmas credenciais já
//     hardcoded em estoque.html (painel-estoque-adesivo), duplicadas aqui.
//   GOOGLE_SHEETS_WEBAPP_URL — mesma URL já hardcoded em estoque.html.

const { getDb } = require('./db');
const { kvGet, kvSet } = require('./kv');
const { buscarProdutoPorSku, NAO_MAPEADO } = require('./tabelaProdutos');

/**
 * historico_todos é gravado via upsert (mesmo pedido pode ser regravado
 * várias vezes conforme o status muda) — por isso cada item vendido só
 * pode gerar UMA linha em estoque_baixas (chave id_unico+item_index).
 * Um pedido cancelado/devolvido nunca chega a criar linha; se já tinha
 * baixa aplicada de quando ainda era vendável, ela é revertida aqui.
 */
async function reconciliarEstoque(pedidos) {
  if (!pedidos || pedidos.length === 0) return { processados: 0 };
  const db = getDb();
  const agora = new Date().toISOString();
  let processados = 0;

  for (const pedido of pedidos) {
    const marketplace = pedido.marketplace || 'mercado_livre';
    const idUnico = `${marketplace}:${pedido.order_id}`;
    const naoVendavel = !!pedido.cancelado || !!pedido.devolvido;

    if (naoVendavel) {
      await reverterBaixasDoPedido(idUnico);
      continue;
    }

    const jaProcessado = await db.execute({
      sql: 'SELECT 1 FROM estoque_baixas WHERE id_unico = ? LIMIT 1',
      args: [idUnico],
    });
    if (jaProcessado.rows.length > 0) continue; // já decidido numa execução anterior

    const itens = pedido.itens || [];
    for (let i = 0; i < itens.length; i++) {
      const item = itens[i] || {};
      const quantidade = Number(item.quantidade) || 0;
      if (quantidade <= 0) continue;

      const info = buscarProdutoPorSku(item.sku);
      if (info === NAO_MAPEADO) {
        await db.execute({
          sql: `INSERT INTO estoque_vendas_nao_mapeadas
                  (id_unico, item_index, sku, quantidade, marketplace, conta, registrado_em)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id_unico, item_index) DO NOTHING`,
          args: [idUnico, i, item.sku || null, quantidade, marketplace, pedido.conta || null, agora],
        });
        continue;
      }

      await db.execute({
        sql: `INSERT INTO estoque_saldo (produto, cor, tamanho, saldo, atualizado_em)
              VALUES (?, ?, ?, -?, ?)
              ON CONFLICT(produto, cor, tamanho) DO UPDATE SET
                saldo = estoque_saldo.saldo - ?,
                atualizado_em = ?`,
        args: [info.produto, info.cor, info.tamanho, quantidade, agora, quantidade, agora],
      });
      await db.execute({
        sql: `INSERT INTO estoque_baixas
                (id_unico, item_index, produto, cor, tamanho, quantidade, sku, aplicado_em, revertido)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
              ON CONFLICT(id_unico, item_index) DO NOTHING`,
        args: [idUnico, i, info.produto, info.cor, info.tamanho, quantidade, item.sku || null, agora],
      });
    }
    processados++;
  }

  return { processados };
}

/**
 * Devolve pro saldo qualquer baixa ainda não revertida desse pedido.
 * Chamada tanto por reconciliarEstoque (pedido já vem cancelado/devolvido
 * no upsert) quanto por marcarDevolucao em lib/historicoTodos.js (devolução
 * que só é descoberta depois, por um processo de enriquecimento separado —
 * não passa por registrarHistoricoTodos).
 */
async function reverterBaixasDoPedido(idUnico) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT item_index, produto, cor, tamanho, quantidade FROM estoque_baixas WHERE id_unico = ? AND revertido = 0',
    args: [idUnico],
  });
  if (rs.rows.length === 0) return 0;

  const agora = new Date().toISOString();
  for (const row of rs.rows) {
    await db.execute({
      sql: `INSERT INTO estoque_saldo (produto, cor, tamanho, saldo, atualizado_em)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(produto, cor, tamanho) DO UPDATE SET
              saldo = estoque_saldo.saldo + ?,
              atualizado_em = ?`,
      args: [row.produto, row.cor, row.tamanho, row.quantidade, agora, row.quantidade, agora],
    });
  }
  await db.execute({
    sql: 'UPDATE estoque_baixas SET revertido = 1, revertido_em = ? WHERE id_unico = ? AND revertido = 0',
    args: [agora, idUnico],
  });
  return rs.rows.length;
}

/**
 * Busca a contagem física mais recente salva pelo painel-estoque-adesivo
 * (JSONBin, chave "estoque.stock") e usa como novo valor de saldo — sempre
 * sobrescreve (a contagem física é a verdade nova), não tenta reconciliar
 * com baixas antigas.
 */
async function importarContagemFisica() {
  const apiKey = process.env.JSONBIN_ESTOQUE_API_KEY;
  const binId = process.env.JSONBIN_ESTOQUE_BIN_ID;
  if (!apiKey || !binId) {
    throw new Error('Faltam as variáveis de ambiente JSONBIN_ESTOQUE_API_KEY e/ou JSONBIN_ESTOQUE_BIN_ID.');
  }

  const resp = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
    headers: { 'X-Master-Key': apiKey },
  });
  if (!resp.ok) throw new Error(`JSONBin respondeu ${resp.status} ao buscar a contagem física.`);
  const json = await resp.json();
  const stock = (json.record && json.record.estoque && json.record.estoque.stock) || {};

  const db = getDb();
  const agora = new Date().toISOString();
  let atualizados = 0;

  for (const produto of Object.keys(stock)) {
    for (const cor of Object.keys(stock[produto] || {})) {
      for (const tamanho of Object.keys(stock[produto][cor] || {})) {
        const entrada = stock[produto][cor][tamanho];
        const saldo = Number(entrada && entrada.proprio) || 0;
        await db.execute({
          sql: `INSERT INTO estoque_saldo (produto, cor, tamanho, saldo, atualizado_em)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(produto, cor, tamanho) DO UPDATE SET
                  saldo = excluded.saldo,
                  atualizado_em = excluded.atualizado_em`,
          args: [produto, cor, tamanho, saldo, agora],
        });
        atualizados++;
      }
    }
  }

  return { atualizados };
}

/** Linhas no mesmo formato que buildRowsForSheet() já usa em estoque.html. */
async function gerarLinhasBalanco() {
  const db = getDb();
  const rs = await db.execute('SELECT produto, cor, tamanho, saldo FROM estoque_saldo ORDER BY produto, tamanho, cor');
  return rs.rows.map((r) => ({
    produto: r.produto,
    cor: r.cor,
    medida: r.tamanho === '-' ? 'única' : r.tamanho,
    ricapet: r.saldo,
    full: 0,
  }));
}

async function enviarParaPlanilha(rows) {
  const url = process.env.GOOGLE_SHEETS_WEBAPP_URL;
  if (!url) throw new Error('Falta a variável de ambiente GOOGLE_SHEETS_WEBAPP_URL.');
  const resp = await fetch(url, {
    method: 'POST',
    body: JSON.stringify({ rows, data: new Date().toISOString() }),
  });
  let json = {};
  try { json = await resp.json(); } catch (e) { /* corpo vazio/inesperado */ }
  if (!resp.ok || !json.ok) throw new Error('Apps Script recusou o envio do balanço: ' + JSON.stringify(json));
  return json;
}

async function enviarBalancoAgora() {
  const rows = await gerarLinhasBalanco();
  return enviarParaPlanilha(rows);
}

/** Chamada a cada ciclo do collect.js — só envia de fato uma vez por mês. */
async function enviarBalancoMensalSeNecessario() {
  const mesAtual = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const ultimoMesEnviado = await kvGet('entrega_turbo:balanco_mensal_ultimo_mes');
  if (ultimoMesEnviado === mesAtual) {
    return { pulado: true, motivo: `Balanço de ${mesAtual} já enviado.` };
  }
  const resultado = await enviarBalancoAgora();
  await kvSet('entrega_turbo:balanco_mensal_ultimo_mes', mesAtual);
  return { pulado: false, mes: mesAtual, resultado };
}

module.exports = {
  reconciliarEstoque,
  reverterBaixasDoPedido,
  importarContagemFisica,
  gerarLinhasBalanco,
  enviarBalancoAgora,
  enviarBalancoMensalSeNecessario,
};
