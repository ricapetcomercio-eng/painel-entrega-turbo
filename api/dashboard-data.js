// api/dashboard-data.js
// Rota chamada PELO FRONTEND. Só lê o resultado já pronto do Redis —
// não chama ML/Shopee, não processa nada pesado. CPU quase zero por chamada.

const { getRedis } = require('../lib/redis');

module.exports = async (req, res) => {
  const redis = getRedis();
  const dados = await redis.get('entrega_turbo:ultima_coleta');
  const dadosFlex = await redis.get('entrega_turbo:ultima_coleta_flex');

  if (!dados) {
    res.status(200).json({
      atualizado_em: null,
      pedidos: [],
      total: 0,
      pedidosFlex: (dadosFlex && dadosFlex.pedidos) || [],
      aviso: 'Ainda não há dados coletados. Aguarde a primeira execução do cron.',
    });
    return;
  }

  res.status(200).json({
    ...dados,
    pedidosFlex: (dadosFlex && dadosFlex.pedidos) || [],
    atualizado_em_flex: (dadosFlex && dadosFlex.atualizado_em) || null,
  });
};
