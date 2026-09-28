// api/dashboard-data.js
// Rota chamada PELO FRONTEND. Só lê o resultado já pronto (Turso) — não
// chama ML/Shopee, não processa nada pesado. CPU quase zero por chamada.

const { kvGet } = require('../lib/kv');
const { getDb } = require('../lib/db');
const { obterAdminSessao } = require('../lib/pontoAuth');
const { somarAppmaxPorDia } = require('../lib/appmaxCaixa');
const { dataFusoLoja } = require('../lib/registrosPonto');

// Duas formas de acesso, sem conflito entre elas:
// - `?sessao=...`: sessão de login do painel (mesma usada no Ponto) — exige
//   admin de verdade, validado no banco a cada chamada.
// - sem `sessao` (rota usada pela TV, que não loga): segue o esquema antigo
//   do `DASHBOARD_TOKEN` — se a env var não estiver configurada, não
//   bloqueia nada, exatamente como sempre foi.
module.exports = async (req, res) => {
  const sessao = req.query.sessao || (req.body && req.body.sessao);
  // projecao-financeira.html manda ?pagina=projecao-financeira porque usa
  // esta mesma rota pra buscar o campo projecaoFinanceira do payload --
  // resto (index.html/tv.html) usa o default 'dashboard'.
  const pagina = req.query.pagina === 'projecao-financeira' ? 'projecao-financeira' : 'dashboard';
  if (sessao) {
    const resultado = await obterAdminSessao(sessao, getDb(), pagina);
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
  const dadosProjecaoFinanceira = await kvGet('entrega_turbo:ultima_coleta_projecao_financeira');

  // Site automático via Appmax (webhook, ver api/debug.js?tipo=appmax-
  // webhook): diferente de MP/Shopee/Omie, não vem do blob salvo pelo
  // "Atualizar agora" -- é somado direto do Turso a cada carregamento
  // (leitura simples, mesmo espírito CPU-quase-zero deste arquivo). Só
  // calcula na tela de Fluxo de Caixa, e cobre a mesma janela de 30 dias
  // (hoje + 29) que a tela exibe (ver HORIZONTE_DIAS_EXIBIDO em
  // projecao-financeira.html) -- hoje calculado no fuso de São Paulo, não
  // no relógio do servidor (mesmo cuidado já documentado pro Omie).
  let siteAutomatico = null;
  let appmaxUltimoEvento = null;
  if (pagina === 'projecao-financeira') {
    const hojeLoja = dataFusoLoja(new Date());
    const ateLoja = dataFusoLoja(new Date(Date.now() + 29 * 86400000));
    siteAutomatico = await somarAppmaxPorDia(getDb(), hojeLoja, ateLoja);
    // Diagnóstico simples pra tela: último evento recebido no webhook da
    // Appmax, mesmo que tenha sido um tipo que a gente ignora (ver
    // debugAppmaxWebhook) -- ajuda a distinguir "webhook nunca chamou" de
    // "só chegaram eventos que não entram no Fluxo de Caixa ainda".
    appmaxUltimoEvento = await kvGet('entrega_turbo:appmax_ultimo_evento');
  }
  const projecaoFinanceiraComSite = dadosProjecaoFinanceira
    ? { ...dadosProjecaoFinanceira, siteAutomatico, appmaxUltimoEvento }
    : (siteAutomatico ? { siteAutomatico, appmaxUltimoEvento } : null);

  if (!dados) {
    res.status(200).json({
      atualizado_em: null,
      pedidos: [],
      total: 0,
      pedidosFlex: (dadosFlex && dadosFlex.pedidos) || [],
      pedidosShopeeTodos: (dadosShopeeTodos && dadosShopeeTodos.pedidos) || [],
      projecaoFinanceira: projecaoFinanceiraComSite,
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
    projecaoFinanceira: projecaoFinanceiraComSite,
  });
};
