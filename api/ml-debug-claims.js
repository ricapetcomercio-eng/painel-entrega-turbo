// api/ml-debug-claims.js
// Rota de diagnóstico: busca reclamações/devoluções reais do Mercado Livre
// nos últimos N dias, SEM tentar classificar nada ainda — só pra
// inspecionarmos o formato real da resposta antes de escrever a lógica
// definitiva (nomes de campo de status/tipo ainda não confirmados contra
// dados reais).
//
// Uso: /api/ml-debug-claims?conta=ricapet&dias=30&secret=SEU_CRON_SECRET

const { getMLAccessToken } = require('../lib/mlAuth');

async function mlFetch(path, accessToken) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Erro ML ${path} (${resp.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.query.secret !== cronSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const conta = req.query.conta;
  const dias = parseInt(req.query.dias, 10) || 30;
  if (!conta) {
    res.status(400).json({ error: 'Use ?conta=ricapet ou ?conta=thapets' });
    return;
  }

  try {
    const accessToken = await getMLAccessToken(conta);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    const ate = new Date().toISOString();

    const dados = await mlFetch(
      `/post-purchase/v1/claims/search?range=date_created:after:${encodeURIComponent(desde)},before:${encodeURIComponent(ate)}`,
      accessToken
    );

    res.status(200).json({ ok: true, conta, periodo: { desde, ate }, resposta_bruta: dados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
