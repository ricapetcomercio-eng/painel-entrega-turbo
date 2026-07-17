// lib/historicoTodos.js
// Grava/atualiza TODOS os pedidos no histórico geral (Redis HASH, sempre
// reflete o status mais atual), independente da forma de entrega OU do
// marketplace (Mercado Livre e Shopee compartilham este mesmo histórico).
// O filtro por forma de entrega acontece depois, na tela (public/index.html)
// e na rota de leitura (api/analytics-todos-data.js).

const HISTORICO_TODOS_HASH_KEY = 'entrega_turbo:historico_todos_hash';
const HISTORICO_TODOS_ZSET_KEY = 'entrega_turbo:historico_todos_zset';
const DIAS_RETENCAO_HISTORICO_TODOS = 400; // margem confortável acima de 1 ano

async function registrarHistoricoTodos(redis, pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };

  const campos = {};
  const zaddArgs = [];
  for (const pedido of pedidos) {
    // Antes só existia Mercado Livre, então isso era fixo. Agora que a
    // Shopee também entra aqui, o ID único e o campo "marketplace" precisam
    // refletir a origem real do pedido — senão pedidos da Shopee seriam
    // salvos como se fossem do Mercado Livre, ou colidiriam entre si se
    // dois marketplaces tiverem o mesmo order_id.
    const marketplace = pedido.marketplace || 'mercado_livre';
    const idUnico = `${marketplace}:${pedido.order_id}`;
    campos[idUnico] = {
      marketplace,
      conta: pedido.conta || null,
      order_id: String(pedido.order_id),
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      forma_entrega: pedido.forma_entrega || 'Não identificado',
      status_envio: pedido.status_envio || null,
      status_pedido: pedido.status_pedido || null,
      cancelado: typeof pedido.cancelado === 'boolean' ? pedido.cancelado : false,
      estado: pedido.estado || null,
      cidade: pedido.cidade || null,
      categoria: pedido.categoria || null,
      coletado: typeof pedido.coletado === 'boolean' ? pedido.coletado : null,
      coletado_em: pedido.coletado_em || null,
      entregue_em: pedido.entregue_em || null,
      horas_ate_coleta: typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
      horas_ate_entrega: typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
      prazo_entrega: pedido.prazo_entrega || null,
      atrasado: typeof pedido.atrasado === 'boolean' ? pedido.atrasado : null,
      itens: pedido.itens || [],
    };
    zaddArgs.push({ score: new Date(pedido.date_created).getTime(), member: idUnico });
  }

  await redis.hset(HISTORICO_TODOS_HASH_KEY, campos);
  if (zaddArgs.length > 0) {
    await redis.zadd(HISTORICO_TODOS_ZSET_KEY, ...zaddArgs);
  }

  const limiteAntigo = Date.now() - DIAS_RETENCAO_HISTORICO_TODOS * 24 * 60 * 60 * 1000;
  const idsAntigos = await redis.zrange(HISTORICO_TODOS_ZSET_KEY, 0, limiteAntigo, { byScore: true });
  if (idsAntigos.length > 0) {
    await redis.hdel(HISTORICO_TODOS_HASH_KEY, ...idsAntigos);
    await redis.zrem(HISTORICO_TODOS_ZSET_KEY, ...idsAntigos);
  }

  return { gravados: Object.keys(campos).length };
}

module.exports = { registrarHistoricoTodos, HISTORICO_TODOS_HASH_KEY, HISTORICO_TODOS_ZSET_KEY };
