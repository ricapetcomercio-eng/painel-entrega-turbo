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
    shipment_id: row.shipment_id,
    forma_entrega: row.forma_entrega,
    status_envio: row.status_envio,
    status_substatus: row.status_substatus,
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
              total_amount, shipment_id, forma_entrega, status_envio, status_substatus, status_pedido, cancelado,
              estado, cidade, categoria, coletado, coletado_em, entregue_em,
              horas_ate_coleta, horas_ate_entrega, prazo_entrega, atrasado,
              devolvido, devolucao_claim_id, devolucao_status, devolucao_reason_id,
              reclamado, reclamacao_claim_id, reclamacao_status, reclamacao_motivo, reclamacao_tipo, itens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id_unico) DO UPDATE SET
              marketplace = excluded.marketplace,
              conta = excluded.conta,
              order_id = excluded.order_id,
              date_created = excluded.date_created,
              date_created_ts = excluded.date_created_ts,
              total_amount = excluded.total_amount,
              shipment_id = CASE WHEN excluded.shipment_id IS NULL THEN historico_todos.shipment_id ELSE excluded.shipment_id END,
              forma_entrega = excluded.forma_entrega,
              status_envio = excluded.status_envio,
              status_substatus = excluded.status_substatus,
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
        pedido.total_amount, pedido.shipment_id || null, pedido.forma_entrega || 'Não identificado', pedido.status_envio || null,
        pedido.status_substatus || null,
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
 *
 * ⚠️ `date_created_ts >= desde` sozinho é um bug — confirmado em produção
 * (out/2026, comparação contra o painel orosconnect): um pedido com mais
 * de 48h ainda genuinamente aguardando despacho (`261003K48JU0JH`,
 * `261003KQX37F1M` — criados há ~54h no momento da captura, `categoria`
 * ainda `null`) simplesmente sumia da tela, mesmo precisando de despacho
 * mais do que nunca. Diferente de `listarRecentes` (`lib/historicoFlex.js`),
 * que já tinha a proteção certa (`date_created_ts >= desde OR categoria =
 * 'aguardando'`) — aqui nunca existiu o equivalente. Corrigido com o mesmo
 * padrão: a condição de categoria logo acima já garante "só quem ainda não
 * foi resolvido", então o filtro de data vira só uma otimização (OR), nunca
 * mais um motivo pra esconder pedido genuinamente pendente.
 *
 * ⚠️ 8ª rodada: remover o corte de 48h por completo abriu a porta pra outro
 * problema (out/2026, confirmado ao reativar "ML geral") — linha "zumbi"
 * (nunca resolvida, `categoria` sempre `null`, geralmente porque a
 * reconferência nunca conseguiu tocar nela de novo, ou é pedido de teste
 * antigo) passou a aparecer pra SEMPRE, com contagem sintética de dezenas
 * ou centenas de dias (`-338d`, `-68d`...) — nenhum pedido real da operação
 * fica tanto tempo "aguardando despacho" de verdade. `IDADE_MAXIMA_
 * AGUARDANDO_MS` é um teto duro (15 dias — generoso frente ao caso real
 * confirmado de ~54h) que some com esse tipo de linha da exibição E do
 * pool de reconferência (mesma função usada pelos dois, ver `api/
 * collect.js`): a partir desse teto, a reconferência automática não
 * consegue mesmo acompanhar o volume, e insistir nela só desperdiça o
 * orçamento de tempo de cada ciclo tentando revisitar pedido quase certamente
 * já resolvido de verdade no marketplace. Pedido específico que precisar
 * mesmo assim ter o status real corrigido no banco depois do teto: rodar
 * `api/backfill-todos-api.js`/`api/backfill-shopee-todos.js` manualmente
 * pra essa janela antiga (não é urgente — só afeta dado histórico, não a
 * exibição ao vivo).
 */
const IDADE_MAXIMA_AGUARDANDO_MS = 15 * 24 * 60 * 60 * 1000;

async function listarShopeeAguardando(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const limiteMaximo = Date.now() - IDADE_MAXIMA_AGUARDANDO_MS;
  const rs = await db.execute({
    sql: `SELECT * FROM historico_todos
          WHERE marketplace = 'shopee'
            AND (cancelado IS NULL OR cancelado = 0)
            AND (categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
            AND status_pedido IN ('READY_TO_SHIP', 'PROCESSED')
            AND (forma_entrega IS NULL OR LOWER(forma_entrega) != 'full')
            AND date_created_ts >= ?
            AND (date_created_ts >= ? OR categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
          ORDER BY date_created_ts ASC`,
    args: [limiteMaximo, desde],
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
 *
 * Mesmo fix de `date_created_ts >= desde` que `listarShopeeAguardando`
 * ganhou (ver comentário lá) — sem isso, um pedido com mais de 48h também
 * saía do POOL DE RECONFERÊNCIA, não só da exibição: nunca mais teria seu
 * `categoria`/`status_pedido` atualizado, travado pra sempre no estado em
 * que foi capturado pela última vez. Mesmo teto duro `IDADE_MAXIMA_
 * AGUARDANDO_MS` da 8ª rodada (ver comentário em `listarShopeeAguardando`)
 * também se aplica aqui, pelo mesmo motivo: sem ele, essas linhas "zumbi"
 * dominavam o orçamento de tempo da reconferência (`ORDER BY
 * date_created_ts ASC` prioriza as mais antigas primeiro).
 */
async function listarShopeePendentesParaReverificar(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const limiteMaximo = Date.now() - IDADE_MAXIMA_AGUARDANDO_MS;
  const rs = await db.execute({
    sql: `SELECT * FROM historico_todos
          WHERE marketplace = 'shopee'
            AND (cancelado IS NULL OR cancelado = 0)
            AND (categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
            AND status_pedido IN ('UNPAID', 'INVOICE_PENDING', 'READY_TO_SHIP', 'PROCESSED')
            AND (forma_entrega IS NULL OR LOWER(forma_entrega) != 'full')
            AND date_created_ts >= ?
            AND (date_created_ts >= ? OR categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
          ORDER BY date_created_ts ASC`,
    args: [limiteMaximo, desde],
  });
  return rs.rows.map(linhaParaPedido);
}

/**
 * Equivalente a listarShopeeAguardando, mas pro Mercado Livre — pedidos
 * ainda não despachados, QUALQUER forma de entrega (não só Flex, já
 * coberto em tempo real por historicoFlex.js/listarRecentes). Usado pelo
 * painel de expedição (tv.html) pra dar visibilidade de volume além do
 * que já tem promessa expressa, mesmo espírito da versão Shopee.
 *
 * Reaproveita o histórico que "Todos os pedidos (ML)" já grava a cada 5min
 * (coletarNovosParaHistoricoTodos, api/collect.js) — zero chamada de API
 * nova, só leitura do Turso (ver Restrição de design nº 1 no CLAUDE.md).
 *
 * Diferente da Shopee (um único campo `status_pedido` cobre pagamento +
 * despacho), o Mercado Livre separa os dois: `status_pedido` é o status do
 * PEDIDO (ex.: "paid"), `status_envio` é o status do SHIPMENT (ex.:
 * "pending"/"handling"/"ready_to_ship"/"shipped"/"delivered"). "Aguardando
 * despacho" aqui é só sobre o shipment, não confere pagamento do pedido
 * separadamente.
 *
 * ⚠️ `status_envio IN (pending, handling, ready_to_ship)` sozinho NÃO é
 * suficiente — confirmado em produção (out/2026, `?tipo=ml-aguardando-
 * substatus`, pedido #2000018704052230): pra `logistic_type: xd_drop_off`
 * (Correios/pontos de envio), o shipment fica com `status: "ready_to_ship"`
 * MESMO DEPOIS de já despachado de verdade (confirmado "A caminho" no
 * próprio Mercado Livre) — só o `status_substatus` revela isso
 * (`dropped_off` → `picked_up` → `in_hub` → `in_packing_list`, nessa
 * ordem). Por isso a exclusão abaixo também olha `status_substatus`.
 * `STATUS_SUBSTATUS_JA_DESPACHADO` cobre os substatus confirmados com dado
 * real (`in_packing_list`, `in_hub`, `authorized_by_carrier`) — lista
 * deliberadamente conservadora: substatus desconhecido continua contando
 * como "aguardando" (prefere mostrar demais a esconder um pedido que ainda
 * precisa ser despachado). `authorized_by_carrier` tinha ficado de fora
 * inicialmente (1 ocorrência, ambíguo sem confirmação) — confirmado horas
 * depois com o pedido #2000018705030292: tela do próprio Mercado Livre
 * mostrando "A caminho, chegará hoje" enquanto `status_substatus` gravado
 * era exatamente `authorized_by_carrier`.
 *
 * Exclui Mercado Envios Full (`forma_entrega` traduzido em mlAllOrders.js)
 * pelo mesmo motivo do Full da Shopee: quem separa/despacha é o próprio
 * fulfillment center do Mercado Livre, não o galpão da Ricapet/Thapets.
 *
 * Também exclui `categoria IN (coletado, entregue, cancelado)` — mesma
 * proteção que `listarShopeeAguardando` já tinha: `api/marcar-coletado.js`
 * marca `categoria = 'coletado'` em `historico_todos` assim que o galpão
 * bipa a etiqueta (sinal instantâneo, não depende de esperar a API do ML
 * confirmar o despacho do lado dela, que pode nunca acontecer se
 * `status_envio` não progredir — ver 3ª/4ª rodada do bug acima). Até
 * out/2026 isso só existia pro lado Shopee; `marcar-coletado.js` nunca
 * atualizava `historico_todos` numa bipagem de ML (só `historico_flex`),
 * então um ML "geral" bipado continuava "aguardando" até a reconferência
 * normal confirmar — corrigido junto com este filtro.
 *
 * ⚠️ Mesmo fix de `date_created_ts >= desde` que `listarShopeeAguardando`
 * ganhou (out/2026, achado comparando com o painel orosconnect) — sem
 * isso, um pedido ML com mais de 48h ainda genuinamente aguardando some
 * da tela sozinho, exatamente a hora em que mais precisa aparecer. A
 * condição de categoria logo acima já garante "só quem ainda não foi
 * resolvido", então o filtro de data vira só uma otimização (OR).
 *
 * ⚠️ Mesmo teto duro `IDADE_MAXIMA_AGUARDANDO_MS` da 8ª rodada (ver
 * comentário em `listarShopeeAguardando`) — ao reativar "ML geral" ficou
 * claro que o OR acima, sozinho, deixa linha "zumbi" (nunca resolvida,
 * às vezes pedido de teste antigo) aparecer pra sempre com contagem de
 * dezenas/centenas de dias. O teto fecha isso sem reintroduzir o bug
 * original (ele é bem mais generoso que o caso real confirmado, ~54h).
 */
const STATUS_SUBSTATUS_JA_DESPACHADO = ['in_packing_list', 'in_hub', 'authorized_by_carrier'];

async function listarMlAguardando(horasRetroativas = 48) {
  const db = getDb();
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const limiteMaximo = Date.now() - IDADE_MAXIMA_AGUARDANDO_MS;
  const placeholdersSubstatus = STATUS_SUBSTATUS_JA_DESPACHADO.map(() => '?').join(',');
  const rs = await db.execute({
    sql: `SELECT * FROM historico_todos
          WHERE marketplace = 'mercado_livre'
            AND (cancelado IS NULL OR cancelado = 0)
            AND (categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
            AND status_envio IN ('pending', 'handling', 'ready_to_ship')
            AND (status_substatus IS NULL OR status_substatus NOT IN (${placeholdersSubstatus}))
            AND (forma_entrega IS NULL OR LOWER(forma_entrega) NOT LIKE '%full%')
            AND date_created_ts >= ?
            AND (date_created_ts >= ? OR categoria IS NULL OR categoria NOT IN ('coletado', 'entregue', 'cancelado'))
          ORDER BY date_created_ts ASC`,
    args: [...STATUS_SUBSTATUS_JA_DESPACHADO, limiteMaximo, desde],
  });
  return rs.rows.map(linhaParaPedido);
}

module.exports = {
  registrarHistoricoTodos, marcarDevolucao, marcarReclamacao, buscarPorPeriodo,
  listarShopeeAguardando, listarShopeePendentesParaReverificar, listarMlAguardando,
};
