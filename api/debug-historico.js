// api/debug-historico.js
// Endpoint de DIAGNÓSTICO — mostra o tamanho real dos históricos no Redis,
// sem passar pelo filtro de período. Uso temporário, para depuração.
// Protegido pelo mesmo CRON_SECRET.

const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  const hasValidSecret = cronSecret && req.query.secret === cronSecret;
  if (!hasValidSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const redis = getRedis();

  try {
    const hlenFlex = await redis.hlen('entrega_turbo:historico_flex_hash');
    const hlenTodos = await redis.hlen('entrega_turbo:historico_todos_hash');
    const zcardFlex = await redis.zcard('entrega_turbo:historico_flex_zset');
    const zcardTodos = await redis.zcard('entrega_turbo:historico_todos_zset');

    // Pega 3 amostras de cada hash, pra ver o formato/conteúdo real
    const amostraFlexKeys = await redis.hrandfield('entrega_turbo:historico_flex_hash', 3);
    const amostraFlex = amostraFlexKeys && amostraFlexKeys.length
      ? await redis.hmget('entrega_turbo:historico_flex_hash', ...amostraFlexKeys)
      : [];

    res.status(200).json({
      hlen_flex: hlenFlex,
      hlen_todos: hlenTodos,
      zcard_flex: zcardFlex,
      zcard_todos: zcardTodos,
      amostra_flex: amostraFlex,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
