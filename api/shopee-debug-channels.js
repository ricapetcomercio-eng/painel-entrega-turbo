// api/shopee-debug-channels.js
// Rota de diagnóstico: lista os canais de logística reais da loja Shopee,
// para confirmar o nome exato do canal "Entrega Turbo" (usado por
// lib/shopeeOrders.js para identificar pedidos Turbo). Não expõe tokens.
//
// Uso: https://SEU_DOMINIO/api/shopee-debug-channels?loja=thapets&secret=SEU_CRON_SECRET

const { shopeeGet } = require('../lib/shopeeAuth');

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.query.secret !== cronSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) {
    res.status(400).json({ error: 'Use ?loja=ricapet ou ?loja=thapets' });
    return;
  }

  try {
    const data = await shopeeGet(loja, '/api/v2/logistics/get_channel_list');
    const canais = (data.response && data.response.logistics_channel_list) || [];
    res.status(200).json({
      ok: true,
      loja,
      total_canais: canais.length,
      canais: canais.map((c) => ({
        id: c.logistics_channel_id,
        nome: c.logistics_channel_name,
        habilitado: c.enabled,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
