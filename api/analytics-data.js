// api/analytics-data.js
// Rota chamada PELO FRONTEND do painel de analytics (public/index.html).
// Só lê os históricos já acumulados no Redis — não chama ML/Shopee, não
// processa nada pesado. Toda a agregação (por hora, por região, etc.)
// é feita no navegador, em JavaScript, a partir dessas listas brutas.

const { getRedis } = require('../lib/redis');

const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
const HISTORICO_FLEX_KEY = 'entrega_turbo:historico_pedidos_flex';

module.exports = async (req, res) => {
  const redis = getRedis();
  const pedidos = await redis.lrange(HISTORICO_KEY, 0, -1);
  const pedidosFlex = await redis.lrange(HISTORICO_FLEX_KEY, 0, -1);

  res.status(200).json({
    total: pedidos.length,
    pedidos: pedidos || [],
    totalFlex: pedidosFlex.length,
    pedidosFlex: pedidosFlex || [],
  });
};
