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
 *
 * O JSONBin só guarda contagem pras combinações produto/cor/tamanho que
 * alguém já digitou pelo menos uma vez — a maioria do catálogo nunca foi
 * contada e não aparece lá. Por isso usamos também catalog.json (publicado
 * pelo painel-estoque-adesivo, gerado de estoque.html via
 * scripts/gerar_catalog_json.py naquele repo) como a lista COMPLETA de
 * produto/cor/tamanho que existem — cada combinação sem contagem salva
 * ainda entra em estoque_saldo com saldo 0, em vez de simplesmente não
 * existir. Sem isso o saldo automático fica bem menor que o catálogo real
 * (e menor que a planilha "Estoque Ricapet", que sempre lista tudo).
 */
async function importarContagemFisica() {
  const apiKey = process.env.JSONBIN_ESTOQUE_API_KEY;
  const binId = process.env.JSONBIN_ESTOQUE_BIN_ID;
  if (!apiKey || !binId) {
    throw new Error('Faltam as variáveis de ambiente JSONBIN_ESTOQUE_API_KEY e/ou JSONBIN_ESTOQUE_BIN_ID.');
  }

  const [respJsonbin, respCatalogo] = await Promise.all([
    fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': apiKey } }),
    fetch('https://painel-estoque-adesivo-three.vercel.app/catalog.json'),
  ]);
  if (!respJsonbin.ok) throw new Error(`JSONBin respondeu ${respJsonbin.status} ao buscar a contagem física.`);
  if (!respCatalogo.ok) throw new Error(`catalog.json respondeu ${respCatalogo.status}.`);

  const json = await respJsonbin.json();
  const stock = (json.record && json.record.estoque && json.record.estoque.stock) || {};
  const catalogo = await respCatalogo.json();

  const db = getDb();
  const agora = new Date().toISOString();
  let atualizados = 0;

  for (const produto of Object.keys(catalogo)) {
    for (const cor of Object.keys(catalogo[produto] || {})) {
      for (const tamanho of catalogo[produto][cor] || []) {
        const entrada = stock[produto] && stock[produto][cor] && stock[produto][cor][tamanho];
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

/**
 * Igual importarContagemFisica, mas só PREENCHE combinações produto/cor/
 * tamanho que ainda não existem em estoque_saldo (saldo 0) — nunca
 * sobrescreve uma linha que já existe. Usada uma vez pra completar o
 * catálogo depois que catalog.json passou a existir, sem perder baixas de
 * venda já aplicadas nas combinações que já estavam sendo rastreadas.
 * importarContagemFisica continua sendo o jeito certo de definir um novo
 * baseline de verdade (contagem física nova por cima de tudo).
 */
async function completarCatalogoFaltante() {
  const resp = await fetch('https://painel-estoque-adesivo-three.vercel.app/catalog.json');
  if (!resp.ok) throw new Error(`catalog.json respondeu ${resp.status}.`);
  const catalogo = await resp.json();

  const db = getDb();
  const agora = new Date().toISOString();
  const antes = (await db.execute('SELECT COUNT(*) AS n FROM estoque_saldo')).rows[0].n;

  for (const produto of Object.keys(catalogo)) {
    for (const cor of Object.keys(catalogo[produto] || {})) {
      for (const tamanho of catalogo[produto][cor] || []) {
        await db.execute({
          sql: `INSERT INTO estoque_saldo (produto, cor, tamanho, saldo, atualizado_em)
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(produto, cor, tamanho) DO NOTHING`,
          args: [produto, cor, tamanho, agora],
        });
      }
    }
  }

  const depois = (await db.execute('SELECT COUNT(*) AS n FROM estoque_saldo')).rows[0].n;
  return { adicionados: depois - antes, total: depois };
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

/**
 * Correção pontual, única: a planilha TABELA_PRODUTOS tinha uma linha
 * duplicada do SKU ArranhadorAdesivo_Bege200x50 com a coluna COR errada
 * ("Arranhador Adesivo" em vez de "Bege") — como o gerador de
 * tabelaProdutos.json usa a última ocorrência do SKU, isso criou uma
 * linha "Arranhador Adesivo / Arranhador Adesivo / 200x50" em
 * estoque_saldo antes da planilha ser corrigida. Já corrigido na
 * planilha e no tabelaProdutos.json — isto só limpa o que já tinha sido
 * gravado errado: soma o saldo da linha errada na linha certa (Bege) e
 * corrige as baixas já registradas, pra não perder nem duplicar nada.
 */
async function corrigirCorArranhadorAdesivoBege() {
  const db = getDb();
  const errado = { produto: 'Arranhador Adesivo', cor: 'Arranhador Adesivo', tamanho: '200x50' };
  const certo = { produto: 'Arranhador Adesivo', cor: 'Bege', tamanho: '200x50' };
  const agora = new Date().toISOString();

  const linhaErrada = (await db.execute({
    sql: 'SELECT saldo FROM estoque_saldo WHERE produto = ? AND cor = ? AND tamanho = ?',
    args: [errado.produto, errado.cor, errado.tamanho],
  })).rows[0];

  let saldoMovido = 0;
  if (linhaErrada) {
    saldoMovido = linhaErrada.saldo;
    await db.execute({
      sql: `INSERT INTO estoque_saldo (produto, cor, tamanho, saldo, atualizado_em)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(produto, cor, tamanho) DO UPDATE SET
              saldo = estoque_saldo.saldo + ?,
              atualizado_em = ?`,
      args: [certo.produto, certo.cor, certo.tamanho, saldoMovido, agora, saldoMovido, agora],
    });
    await db.execute({
      sql: 'DELETE FROM estoque_saldo WHERE produto = ? AND cor = ? AND tamanho = ?',
      args: [errado.produto, errado.cor, errado.tamanho],
    });
  }

  await db.execute({
    sql: 'UPDATE estoque_baixas SET produto = ?, cor = ?, tamanho = ? WHERE produto = ? AND cor = ? AND tamanho = ?',
    args: [certo.produto, certo.cor, certo.tamanho, errado.produto, errado.cor, errado.tamanho],
  });

  return { linha_errada_encontrada: !!linhaErrada, saldo_movido_para_bege: saldoMovido };
}

module.exports = {
  reconciliarEstoque,
  reverterBaixasDoPedido,
  importarContagemFisica,
  completarCatalogoFaltante,
  corrigirCorArranhadorAdesivoBege,
  gerarLinhasBalanco,
  enviarBalancoAgora,
  enviarBalancoMensalSeNecessario,
};
