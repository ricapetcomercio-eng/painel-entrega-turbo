// api/responder-pergunta-ml.js
// Publica de verdade a resposta de uma pergunta no Mercado Livre. Chamado
// pelo checkout_bipagem.py (RobotOmie) só depois que alguém aprova o
// rascunho pelo WhatsApp (respondendo "SIM <question_id>" no grupo) — essa
// rota nunca decide sozinha o que responder, só publica o texto que já foi
// aprovado por uma pessoa.
//
// POST /api/responder-pergunta-ml
// Body: { secret, conta, question_id, text }

const { getMLAccessToken, CONTAS } = require('../lib/mlAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const body = req.body || {};
  if (!cronSecret || body.secret !== cronSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const { conta, question_id, text } = body;
  if (!CONTAS.includes(conta) || !question_id || !text) {
    res.status(400).json({ error: 'Use {conta, question_id, text}' });
    return;
  }

  try {
    const accessToken = await getMLAccessToken(conta);
    const resp = await fetch('https://api.mercadolibre.com/marketplace/answers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ question_id: Number(question_id), text }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Erro ML (${resp.status}): ${errText}`);
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
