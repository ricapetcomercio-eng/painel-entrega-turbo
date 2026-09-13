// api/dashboard-data.js
// Rota chamada PELO FRONTEND. Só lê o resultado já pronto (Turso) — não
// chama ML/Shopee, não processa nada pesado. CPU quase zero por chamada.

const { kvGet } = require('../lib/kv');
const { getDb } = require('../lib/db');
const { obterAdminSessao } = require('../lib/pontoAuth');

// Duas formas de acesso, sem conflito entre elas:
// - `?sessao=...`: sessão de login do painel (mesma usada no Ponto) — exige
//   admin de verdade, validado no banco a cada chamada.
// - sem `sessao` (rota usada pela TV, que não loga): segue o esquema antigo
//   do `DASHBOARD_TOKEN` — se a env var não estiver configurada, não
//   bloqueia nada, exatamente como sempre foi.
module.exports = async (req, res) => {
  const sessao = req.query.sessao || (req.body && req.body.sessao);
  if (sessao) {
    const resultado = await obterAdminSessao(sessao, getDb());
    if (resultado.erro) {
      res.status(resultado.status).json({ error: resultado.erro });
      return;
    }
  } else {
    const token = process.env.DASHBOARD_TOKEN;
    if (token && req.query.token !== token) {
      res.status(401).json({ error: 'Não autorizado' });
      return;
    }
  }

  const dados = await kvGet('entrega_turbo:ultima_coleta');
  const dadosFlex = await kvGet('entrega_turbo:ultima_coleta_flex');
  const dadosShopeeTodos = await kvGet('entrega_turbo:ultima_coleta_shopee_todos');

  if (!dados) {
    res.status(200).json({
      atualizado_em: null,
      pedidos: [],
      total: 0,
      pedidosFlex: (dadosFlex && dadosFlex.pedidos) || [],
      pedidosShopeeTodos: (dadosShopeeTodos && dadosShopeeTodos.pedidos) || [],
      aviso: 'Ainda não há dados coletados. Aguarde a primeira execução do cron.',
    });
    return;
  }

  res.status(200).json({
    ...dados,
    pedidosFlex: (dadosFlex && dadosFlex.pedidos) || [],
    atualizado_em_flex: (dadosFlex && dadosFlex.atualizado_em) || null,
    pedidosShopeeTodos: (dadosShopeeTodos && dadosShopeeTodos.pedidos) || [],
    atualizado_em_shopee_todos: (dadosShopeeTodos && dadosShopeeTodos.atualizado_em) || null,
  });
};
