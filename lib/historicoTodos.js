// lib/historicoTodos.js
// Grava/atualiza TODOS os pedidos no histórico geral (tabela historico_todos
// no Turso — migrado do Redis compartilhado, que estourava cota),
// independente da forma de entrega OU do marketplace (Mercado Livre e
// Shopee compartilham esta mesma tabela).

const { getDb } = require('./db');
const { reconciliarEstoque, reverterBaixasDoPedido } = require('./estoqueSaldo');

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
    reclamado: paraBooleano(row.reclamado) || false,
    reclamacao_claim_id: row.reclamacao_claim_id,
    reclamacao_status: row.reclamacao_status,
    reclamacao_motivo: row.reclamacao_motivo,
    reclamacao_tipo: row.reclamacao_tipo,
    itens: row.itens ? JSON.parse(row.itens) : [],
  };
}

async function registrarHistoricoTodos(pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };
  const db = getDb();

  // Antes de sobrescrever, busca os registros já existentes para preservar
  // os campos de devolução/reclamação — eles são preenchidos por um processo
  // separado (enriquecerDevolucoes, em api/collect.js), e o fluxo normal de
  // coleta de pedidos não sabe nada sobre devolução/reclamação.
  const idsUnicos = pedidos.map((p) => `${p.marketplace || 'mercado_livre'}:${p.order_id}`);
  const existentes = {};
  if (idsUnicos.length > 0) {
    const placeholders = idsUnicos.map(() => '?').join(',');
    const rs = await db.execute({
      sql: `SELECT id_unico, devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id,
                   reclamado, reclamacao_claim_id, reclamacao_status, reclamacao_motivo, reclamacao_tipo
            FROM historico_todos WHERE id_unico IN (${placeholders})`,
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
    const reclamadoInt = typeof pedido.reclamado === 'boolean'
      ? paraInteiroBooleano(pedido.reclamado)
      : (anterior.reclamado != null ? anterior.reclamado : 0);

    await db.execute({
      sql: `INSERT INTO historico_todos (
              id_unico, marketplace, conta, order_id, date_created, date_created_ts,
              total_amount, forma_entrega, status_envio, status_pedido, cancelado,
              estado, cidade, categoria, coletado, coletado_em, entregue_em,
              horas_ate_coleta, horas_ate_entrega, prazo_entrega, atrasado,
              devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id,
              reclamado, reclamacao_claim_id, reclamacao_status, reclamacao_motivo, reclamacao_tipo, itens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
              -- Pedido Shopee "geral" (montarPedidoGenericoShopee) nunca
              -- calcula categoria/coletado/coletado_em (só a Entrega Turbo e
              -- o Flex fazem isso) — sem essa proteção, a marcação instantânea
              -- de "coletado" feita por marcar-coletado.js quando o galpão
              -- bipa a etiqueta (antes da Shopee confirmar a coleta do lado
              -- dela, que pode demorar horas) seria apagada de volta pra NULL
              -- no próximo ciclo normal de coleta. Só sobrescreve quando o
              -- pedido que chegou agora TEM de verdade um valor calculado.
              categoria = CASE WHEN excluded.categoria IS NULL THEN historico_todos.categoria ELSE excluded.categoria END,
              coletado = CASE WHEN excluded.coletado IS NULL THEN historico_todos.coletado ELSE excluded.coletado END,
              coletado_em = CASE WHEN excluded.coletado_em IS NULL THEN historico_todos.coletado_em ELSE excluded.coletado_em END,
              entregue_em = excluded.entregue_em,
              horas_ate_coleta = excluded.horas_ate_coleta,
              horas_ate_entrega = excluded.horas_ate_entrega,
              prazo_entrega = excluded.prazo_entrega,
              atrasado = excluded.atrasado,
              devolvido = excluded.devolvido,
              devolucao_claim_id = excluded.devolucao_claim_id,
              devolucao_status = excluded.devolucao_status,
              devolucao_reason_id = excluded.devolucao_reason_id,
              reclamado = excluded.reclamado,
              reclamacao_claim_id = excluded.reclamacao_claim_id,
              reclamacao_status = excluded.reclamacao_status,
              reclamacao_motivo = excluded.reclamacao_motivo,
              reclamacao_tipo = excluded.reclamacao_tipo,
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
        reclamadoInt,
        pedido.reclamacao_claim_id || anterior.reclamacao_claim_id || null,
        pedido.reclamacao_status || anterior.reclamacao_status || null,
        pedido.reclamacao_motivo || anterior.reclamacao_motivo || null,
        pedido.reclamacao_tipo || anterior.reclamacao_tipo || null,
        JSON.stringify(pedido.itens || []),
      ],
    });
  }

  // Baixa de estoque automática — não deve nunca impedir a gravação dos
  // pedidos em si (a coleta é o dado crítico; o saldo é derivado dele e
  // pode ser recalculado/corrigido depois), então erros aqui só ficam no
  // console em vez de propagar.
  try {
    await reconciliarEstoque(pedidos);
  } catch (err) {
    console.error('Erro ao reconciliar estoque:', err);
  }

  return { gravados: pedidos.length };
}

/**
 * Marca um pedido já existente no histórico como devolvido — usado pelo
 * processo de enriquecimento de devoluções (api/collect.js). Não faz nada
 * se o pedido ainda não estiver no histórico (ex: coletado depois).
 *
 * Também zera os campos de reclamação (reclamado/reclamacao_*) do mesmo
 * pedido: uma reclamação (claim de mediação/disputa sem devolução física,
 * ver lib/mlClaims.js) que evolui pra devolução física "gradua" — não faz
 * sentido continuar contando como reclamação em aberto depois que já virou
 * devolução de verdade.
 */
async function marcarDevolucao(idUnico, info) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT id_unico FROM historico_todos WHERE id_unico = ?', args: [idUnico] });
  if (!rs.rows[0]) return false;

  await db.execute({
    sql: `UPDATE historico_todos SET
            devolvido = 1, devolucao_claim_id = ?, devolucao_status = ?, devolucao_reason_id = ?,
            reclamado = 0, reclamacao_claim_id = NULL, reclamacao_status = NULL, reclamacao_motivo = NULL, reclamacao_tipo = NULL
          WHERE id_unico = ?`,
    args: [info.claimId || null, info.status || null, info.reasonId || null, idUnico],
  });

  try {
    await reverterBaixasDoPedido(idUnico);
  } catch (err) {
    console.error('Erro ao reverter baixa de estoque por devolução:', err);
  }

  return true;
}

/**
 * Marca um pedido já existente no histórico como reclamado — claim do ML de
 * mediação/disputa que o cliente abriu mas que NÃO envolve devolução física
 * do produto (ver claimEhDevolucao em lib/mlClaims.js). Diferente de
 * marcarDevolucao, não mexe no estoque (nenhum produto está voltando) e não
 * toca nos campos de devolução — se o pedido já estiver marcado como
 * devolvido, marcarDevolucao é quem decide (chamada separada, mesmo ciclo de
 * enriquecerDevolucoes em api/collect.js) e sempre "vence" por rodar depois
 * na mesma passada, já que um claim clássifica como devolução OU reclamação,
 * nunca os dois ao mesmo tempo, na mesma execução.
 */
async function marcarReclamacao(idUnico, info) {
  const db = getDb();
  const rs = await db.execute({ sql: 'SELECT id_unico FROM historico_todos WHERE id_unico = ?', args: [idUnico] });
  if (!rs.rows[0]) return false;

  await db.execute({
    sql: `UPDATE historico_todos SET
            reclamado = 1, reclamacao_claim_id = ?, reclamacao_status = ?, reclamacao_motivo = ?, reclamacao_tipo = ?
          WHERE id_unico = ?`,
    args: [info.claimId || null, info.status || null, info.motivo || null, info.tipo || null, idUnico],
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

/**
 * Lista pedidos Shopee (Ricapet e Thapets) ainda não coletados, QUALQUER
 * forma de entrega — usado pelo painel de expedição (tv.html) como
 * complemento à Entrega Turbo (que é um subconjunto bem mais estrito, já
 * coberto por historicoTurboLive.js/listarRecentesTurbo). Como o pedido
 * genérico (montarPedidoGenericoShopee) não grava `categoria` (só faz
 * sentido pra quem tem promessa expressa), usa status_pedido direto pra
 * decidir "ainda aguardando" — mesma lista de status usada em
 * categoriaPedidoShopee (lib/shopeeOrders.js) pra essa mesma condição.
 *
 * Exclui Shopee Full (forma_entrega/shipping_carrier = "Full") de propósito
 * — a pedido do dono do painel: quem cuida da separação/despacho desses
 * pedidos é a própria Shopee (fulfillment center deles), não o galpão da
 * Ricapet/Thapets, então não faz sentido aparecer como "aguardando" aqui.
 *
 * Só pedido PAGO (READY_TO_SHIP/PROCESSED) — também a pedido do dono:
 * UNPAID/INVOICE_PENDING pode nunca ser pago (a Shopee cancela sozinha por
 * falta de pagamento) e o galpão não tem nada pra fazer com ele ainda
 * mesmo que seja pago depois, então não faz sentido ocupar espaço na TV
 * antes da confirmação. A reverificação periódica (reverificarPendentes-
 * ShopeeTodos, api/collect.js) garante que ele entra na lista assim que
 * o status virar READY_TO_SHIP.
 */
async function listarShopeeAguardando(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const rs = await db.execute({
    sql: `SELECT * FROM historico_todos
          WHERE marketplace = 'shopee'
            AND (cancelado IS NULL OR cancelado = 0)
            AND (categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
            AND status_pedido IN ('READY_TO_SHIP', 'PROCESSED')
            AND (forma_entrega IS NULL OR LOWER(forma_entrega) != 'full')
            AND date_created_ts >= ?
          ORDER BY date_created_ts ASC`,
    args: [desde],
  });
  return rs.rows.map(linhaParaPedido);
}

/**
 * Versão mais ampla de listarShopeeAguardando, pra USO INTERNO da
 * reverificação periódica (reverificarPendentesShopeeTodos, api/collect.js)
 * — não pro painel. Inclui também UNPAID/INVOICE_PENDING (ainda não pago,
 * por isso escondido do painel), porque alguém precisa continuar
 * consultando esses pedidos de tempos em tempos pra saber quando o
 * pagamento é confirmado (viram READY_TO_SHIP) ou a Shopee desiste e
 * cancela sozinha — sem isso, um pedido excluído da lista de exibição
 * nunca mais seria revisitado e ficaria invisível pra sempre, mesmo
 * depois de pago de verdade.
 */
async function listarShopeePendentesParaReverificar(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const rs = await db.execute({
    sql: `SELECT * FROM historico_todos
          WHERE marketplace = 'shopee'
            AND (cancelado IS NULL OR cancelado = 0)
            AND (categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
            AND status_pedido IN ('UNPAID', 'INVOICE_PENDING', 'READY_TO_SHIP', 'PROCESSED')
            AND (forma_entrega IS NULL OR LOWER(forma_entrega) != 'full')
            AND date_created_ts >= ?
          ORDER BY date_created_ts ASC`,
    args: [desde],
  });
  return rs.rows.map(linhaParaPedido);
}

module.exports = {
  registrarHistoricoTodos, marcarDevolucao, marcarReclamacao, buscarPorPeriodo,
  listarShopeeAguardando, listarShopeePendentesParaReverificar,
};
