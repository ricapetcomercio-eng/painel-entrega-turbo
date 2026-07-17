// api/shopee-debug-returns.js
// Rota de diagnóstico: busca devoluções reais da Shopee, SEM tentar
// classificar nada ainda — só pra inspecionarmos o formato real da
// resposta antes de escrever a lógica definitiva (nomes de campo de
// status/motivo ainda não confirmados contra dados reais).
//
// Uso: /api/shopee-debug-returns?loja=thapets&secret=SEU_CRON_SECRET

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
    const dados = await shopeeGet(loja, '/api/v2/returns/get_return_list', {
      page_size: 20,
    });
    res.status(200).json({ ok: true, loja, resposta_bruta: dados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
