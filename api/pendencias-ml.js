// api/pendencias-ml.js
// Chamado periodicamente pelo sistema local (C:\RobotOmie\checkout_bipagem.py,
// a cada ~15 min) pra saber se há perguntas de produto ou mensagens pós-venda
// pendentes de resposta no Mercado Livre, nas duas contas (Ricapet e Thapets).
//
// Consulta a API do ML em tempo real a cada chamada (sem cache/cron próprio
// aqui) — o intervalo de verificação é controlado inteiramente do lado
// local. Reaproveita os mesmos tokens/app ML de lib/mlAuth.js usados pelo
// resto do painel.
//
// GET  /api/pendencias-ml?secret=SEU_PENDENCIAS_ML_SECRET
//      -> perguntas/mensagens pendentes (com resposta_sugerida, se achar).
// POST /api/pendencias-ml   Body: { secret, conta, question_id, text }
//      -> publica de verdade a resposta de UMA pergunta no Mercado Livre.
//      Chamado pelo checkout_bipagem.py só depois que alguém aprova o
//      rascunho pelo WhatsApp ("SIM <question_id>") — essa rota nunca
//      decide sozinha o que responder, só publica o texto já aprovado.
//
// As duas ações dividem o mesmo arquivo (em vez de dois endpoints
// separados) pra não estourar o limite de Serverless Functions do plano
// Hobby da Vercel (12) — GET e POST no mesmo path contam como 1 função só.
//
// PENDENCIAS_ML_SECRET é um secret PRÓPRIO desta rota — de propósito, não
// é o mesmo CRON_SECRET usado por /api/collect (esse já está em produção,
// chamado por um cron externo a cada 1-2 min; usar outro aqui evita
// qualquer risco de quebrar aquele fluxo ao rotacionar).

const { getMLAccessToken, CONTAS } = require('../lib/mlAuth');
const { SELLER_IDS } = require('../lib/mlOrders');
const { gerarRespostaSugerida } = require('../lib/mlRespostaSugerida');

async function mlFetch(path, accessToken) {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro ML ${path} (${resp.status}): ${errText}`);
  }
  return resp.json();
}

// Multiget com os atributos completos (não só título) — precisa de
// attributes/variations pra lib/mlRespostaSugerida.js conseguir sugerir
// resposta de medidas/cor/material.
async function buscarDetalhesItens(accessToken, itemIds) {
  const detalhes = {};
  const ids = [...new Set(itemIds.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 20) {
    const lote = ids.slice(i, i + 20);
    const data = await mlFetch(
      `/items?ids=${lote.join(',')}&attributes=id,title,permalink,attributes,variations`,
      accessToken
    );
    for (const entrada of data) {
      const corpo = entrada.body || {};
      if (corpo.id) detalhes[corpo.id] = corpo;
    }
  }
  return detalhes;
}

async function buscarPerguntasNaoRespondidas(conta, accessToken) {
  const sellerId = SELLER_IDS[conta];
  const perguntas = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const data = await mlFetch(
      `/questions/search?seller_id=${sellerId}&status=UNANSWERED&api_version=4&offset=${offset}&limit=${limit}`,
      accessToken
    );
    const resultados = data.questions || [];
    perguntas.push(...resultados);
    offset += limit;
    if (offset >= (data.total || 0) || resultados.length === 0) break;
  }

  const itens = await buscarDetalhesItens(accessToken, perguntas.map((p) => p.item_id));
  return perguntas.map((p) => {
    const item = itens[p.item_id] || {};
    const sugestao = gerarRespostaSugerida(p.text, item);
    return {
      id: p.id,
      text: p.text,
      item_id: p.item_id,
      date_created: p.date_created,
      item_title: item.title || '',
      item_permalink: item.permalink || '',
      resposta_sugerida: sugestao ? sugestao.texto : null,
      resposta_categoria: sugestao ? sugestao.categoria : null,
    };
  });
}

async function buscarMensagensNaoLidas(conta, accessToken) {
  const userId = SELLER_IDS[conta];
  const data = await mlFetch(`/messages/unread/${userId}?tag=post_sale&role=seller`, accessToken);
  return (data.results || []).map((r) => ({
    pack_id: String(r.resource || '').replace(/\/$/, '').split('/').pop(),
    count: r.count || 0,
  }));
}

async function publicarResposta(accessToken, questionId, texto) {
  const resp = await fetch('https://api.mercadolibre.com/marketplace/answers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ question_id: Number(questionId), text: texto }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro ML (${resp.status}): ${errText}`);
  }
}

async function handleGet(req, res) {
  const secretEsperado = process.env.PENDENCIAS_ML_SECRET;
  if (!secretEsperado || req.query.secret !== secretEsperado) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const resultado = { atualizado_em: new Date().toISOString() };

  for (const conta of CONTAS) {
    try {
      const accessToken = await getMLAccessToken(conta);
      const [perguntas, mensagens] = await Promise.all([
        buscarPerguntasNaoRespondidas(conta, accessToken),
        buscarMensagensNaoLidas(conta, accessToken),
      ]);
      resultado[conta] = { perguntas, mensagens, erro: null };
    } catch (err) {
      resultado[conta] = { perguntas: [], mensagens: [], erro: err.message };
    }
  }

  res.status(200).json(resultado);
}

async function handlePost(req, res) {
  const secretEsperado = process.env.PENDENCIAS_ML_SECRET;
  const body = req.body || {};
  if (!secretEsperado || body.secret !== secretEsperado) {
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
    await publicarResposta(accessToken, question_id, text);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = async (req, res) => {
  if (req.method === 'POST') return handlePost(req, res);
  return handleGet(req, res);
};
