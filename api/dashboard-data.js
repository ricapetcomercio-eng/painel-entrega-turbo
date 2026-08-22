// api/dashboard-data.js
// Rota chamada PELO FRONTEND. Só lê o resultado já pronto (Turso) — não
// chama ML/Shopee, não processa nada pesado. CPU quase zero por chamada.

const { kvGet } = require('../lib/kv');

// Sem isso, qualquer pessoa com a URL via pedidos reais (valores, SKUs, IDs)
// sem precisar de login — a TV/painel viviam publicamente abertos. Segue o
// mesmo esquema do CRON_SECRET em collect.js: se DASHBOARD_TOKEN não estiver
// configurada, não bloqueia nada (não quebra quem ainda não configurou).
module.exports = async (req, res) => {
  const token = process.env.DASHBOARD_TOKEN;
  if (token && req.query.token !== token) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const dados = await kvGet('entrega_turbo:ultima_coleta');
  const dadosFlex = await kvGet('entrega_turbo:ultima_coleta_flex');

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
