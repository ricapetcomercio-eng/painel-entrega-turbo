// lib/historicoFlex.js
// Grava/atualiza pedidos Flex no histórico (Redis HASH, sempre reflete o
// status mais atual — diferente de uma lista, que congelaria no status da
// primeira vez que o pedido foi visto). Usado tanto pela coleta contínua
// (api/collect.js) quanto pelo backfill via API (api/backfill-flex-api.js).

const HISTORICO_FLEX_HASH_KEY = 'entrega_turbo:historico_flex_hash';
const HISTORICO_FLEX_ZSET_KEY = 'entrega_turbo:historico_flex_zset';
const DIAS_RETENCAO_HISTORICO_FLEX = 400; // margem confortável acima de 1 ano

async function registrarHistoricoFlex(redis, pedidos) {
  if (!pedidos || pedidos.length === 0) return { gravados: 0 };

  const campos = {};
  const zaddArgs = [];
  for (const pedido of pedidos) {
    const idUnico = `mercado_livre:${pedido.order_id}`;
    campos[idUnico] = {
      marketplace: 'mercado_livre',
      conta: pedido.conta || null,
      order_id: String(pedido.order_id),
      shipment_id: pedido.shipment_id || null, // necessário pra reverificar o status depois
      date_created: pedido.date_created,
      total_amount: pedido.total_amount,
      coletado: pedido.coletado,
      categoria: pedido.categoria || (pedido.coletado ? 'coletado' : 'aguardando'),
      coletado_em: pedido.coletado_em || null,
      entregue_em: pedido.entregue_em || null,
      horas_ate_coleta: typeof pedido.horas_ate_coleta === 'number' ? pedido.horas_ate_coleta : null,
      horas_ate_entrega: typeof pedido.horas_ate_entrega === 'number' ? pedido.horas_ate_entrega : null,
      itens: pedido.itens || [],
    };
    zaddArgs.push({ score: new Date(pedido.date_created).getTime(), member: idUnico });
  }

  await redis.hset(HISTORICO_FLEX_HASH_KEY, campos);
  if (zaddArgs.length > 0) {
    await redis.zadd(HISTORICO_FLEX_ZSET_KEY, ...zaddArgs);
  }

  // Poda registros mais antigos que o limite de retenção
  const limiteAntigo = Date.now() - DIAS_RETENCAO_HISTORICO_FLEX * 24 * 60 * 60 * 1000;
  const idsAntigos = await redis.zrange(HISTORICO_FLEX_ZSET_KEY, 0, limiteAntigo, { byScore: true });
  if (idsAntigos.length > 0) {
    await redis.hdel(HISTORICO_FLEX_HASH_KEY, ...idsAntigos);
    await redis.zrem(HISTORICO_FLEX_ZSET_KEY, ...idsAntigos);
  }

  return { gravados: Object.keys(campos).length };
}

/**
 * Lista os registros dos últimos N (padrão 48h) — usado tanto pra montar o
 * "snapshot ao vivo" (sem precisar rebuscar tudo na API do ML) quanto pra
 * achar quais pedidos ainda estão "aguardando" e precisam ser reverificados.
 */
async function listarRecentes(redis, horasRetroativas = 48) {
  const desde = Date.now() - horasRetroativas * 60 * 60 * 1000;
  const ids = await redis.zrange(HISTORICO_FLEX_ZSET_KEY, desde, Date.now(), { byScore: true });
  if (!ids || ids.length === 0) return [];
  const valores = await redis.hmget(HISTORICO_FLEX_HASH_KEY, ...ids);
  return valores ? Object.values(valores).filter(Boolean) : [];
}

module.exports = { registrarHistoricoFlex, listarRecentes, HISTORICO_FLEX_HASH_KEY, HISTORICO_FLEX_ZSET_KEY };
