// lib/atrasoSemanal.js
// Soma o atraso real (hora da coleta − prazo, só quando positivo) de todo
// pedido já coletado/entregue nos últimos 7 dias corridos — pedido do dono
// do projeto (out/2026): "total de atraso que tivemos na semana". Métrica
// retrospectiva: só pedido já resolvido entra na soma — pedido ainda aberto
// e atrasado já aparece na TV como card vermelho piscando (zona "preto"),
// contá-lo aqui de novo misturaria atraso fechado com atraso em andamento
// (decisão explícita do dono do projeto ao escolher o escopo).
//
// Cobre as 3 tabelas que guardam prazo real: historico_flex (ML Flex/
// Turbo-tag/Agora), historico_turbo_live (Shopee Entrega Turbo) e
// historico_todos (Shopee geral/ML geral) — pedido sem prazo real (ex.:
// Shopee/ML geral quando prazo_entrega nunca foi coletado) não entra,
// porque não tem contra o que medir atraso de verdade.
//
// Só consulta o próprio Turso (sem chamada de API de marketplace) — custo
// de CPU desprezível, mesmo espírito das outras métricas agregadas deste
// projeto.

const { getDb } = require('./db');

const JANELA_MS = 7 * 24 * 60 * 60 * 1000;

function somarAtraso(rows, campoResolvido, campoPrazo) {
  let totalMs = 0;
  let pedidosAtrasados = 0;
  for (const row of rows) {
    const resolvidoEm = row[campoResolvido];
    const prazo = row[campoPrazo];
    if (!resolvidoEm || !prazo) continue;
    const atrasoMs = new Date(resolvidoEm).getTime() - new Date(prazo).getTime();
    if (atrasoMs > 0) {
      totalMs += atrasoMs;
      pedidosAtrasados += 1;
    }
  }
  return { totalMs, pedidosAtrasados };
}

async function calcularAtrasoSemana() {
  const db = getDb();
  const desde = new Date(Date.now() - JANELA_MS).toISOString();

  const [rsFlex, rsTurbo, rsTodos] = await Promise.all([
    db.execute({
      sql: `SELECT coletado_em, deadline FROM historico_flex
            WHERE coletado_em >= ? AND deadline IS NOT NULL AND categoria IN ('coletado', 'entregue')`,
      args: [desde],
    }),
    db.execute({
      sql: `SELECT resolvido_em, deadline FROM historico_turbo_live
            WHERE resolvido_em >= ? AND deadline IS NOT NULL AND categoria IN ('coletado', 'entregue')`,
      args: [desde],
    }),
    db.execute({
      sql: `SELECT coletado_em, prazo_entrega FROM historico_todos
            WHERE coletado_em >= ? AND prazo_entrega IS NOT NULL AND categoria IN ('coletado', 'entregue')`,
      args: [desde],
    }),
  ]);

  const flex = somarAtraso(rsFlex.rows, 'coletado_em', 'deadline');
  const turbo = somarAtraso(rsTurbo.rows, 'resolvido_em', 'deadline');
  const todos = somarAtraso(rsTodos.rows, 'coletado_em', 'prazo_entrega');

  return {
    total_ms: flex.totalMs + turbo.totalMs + todos.totalMs,
    pedidos_atrasados: flex.pedidosAtrasados + turbo.pedidosAtrasados + todos.pedidosAtrasados,
    janela_desde: desde,
    calculado_em: new Date().toISOString(),
  };
}

module.exports = { calcularAtrasoSemana };
