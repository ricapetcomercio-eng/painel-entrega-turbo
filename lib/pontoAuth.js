// lib/pontoAuth.js
// Login/sessão do painel (funcionário + PIN, token assinado, checagem de
// admin) — extraído de api/debug.js pra poder ser reaproveitado por outras
// rotas (api/dashboard-data.js, api/estoque.js) sem duplicar a lógica de
// autenticação em cada arquivo.

const crypto = require('crypto');

function hashPin(pin) {
  return crypto.createHash('sha256').update(`${pin}:${process.env.PONTO_PIN_SALT || ''}`).digest('hex');
}

function gerarTokenPonto(funcionario) {
  const payload = Buffer.from(JSON.stringify({ id: funcionario.id, nome: funcionario.nome })).toString('base64url');
  const assinatura = crypto.createHmac('sha256', process.env.PONTO_TOKEN_SECRET || '').update(payload).digest('hex');
  return `${payload}.${assinatura}`;
}

function verificarTokenPonto(token) {
  const [payload, assinatura] = String(token || '').split('.');
  if (!payload || !assinatura) return null;
  const esperado = crypto.createHmac('sha256', process.env.PONTO_TOKEN_SECRET || '').update(payload).digest('hex');
  const bufAssinatura = Buffer.from(assinatura);
  const bufEsperado = Buffer.from(esperado);
  if (bufAssinatura.length !== bufEsperado.length || !crypto.timingSafeEqual(bufAssinatura, bufEsperado)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

async function funcionarioEhAdmin(db, funcionarioId) {
  const rs = await db.execute({ sql: 'SELECT admin FROM funcionarios WHERE id = ? AND ativo = 1', args: [funcionarioId] });
  return !!(rs.rows[0] && rs.rows[0].admin === 1);
}

// Nível acima do admin comum — só quem tem essa flag (só o Ricardo, por
// decisão do dono do projeto) enxerga a tela de Acessos e ignora o
// controle por página abaixo (acesso total sempre). Setado 1x via
// ponto-definir-super-admin (CRON_SECRET), nunca pela própria tela de
// Acessos — evita que a tela usada pra conceder acesso vire um jeito de
// alguém se promover.
async function funcionarioEhSuperAdmin(db, funcionarioId) {
  try {
    const rs = await db.execute({ sql: 'SELECT super_admin FROM funcionarios WHERE id = ? AND ativo = 1', args: [funcionarioId] });
    return !!(rs.rows[0] && rs.rows[0].super_admin === 1);
  } catch (e) {
    // Coluna ainda não migrada nesse banco (deploy muito recente, antes da
    // 1ª chamada que roda garantirEsquemaPonto) -- trata como "ainda sem
    // super_admin" em vez de derrubar a rota com 500.
    return false;
  }
}

// Páginas do painel administrativo controláveis na tela de Acessos. As
// chaves batem com o data-menu-key já usado na barra lateral de cada
// página, pra não precisar de tradução entre os dois lados.
// 'concorrencia' e 'tv' são exceções documentadas: controlam só a
// visibilidade do link (a Análise de Concorrência é um iframe pra outro
// projeto/domínio, e o Painel TV é kiosk sem login por design) — não têm
// um endpoint próprio pra travar de verdade no backend.
const PAGINAS_PAINEL = ['ponto', 'dashboard', 'bipagem', 'estoque', 'projecao-financeira', 'concorrencia', 'tv'];

async function paginasPermitidas(db, funcionarioId, superAdminJaSabido) {
  const superAdmin = superAdminJaSabido !== undefined ? superAdminJaSabido : await funcionarioEhSuperAdmin(db, funcionarioId);
  if (superAdmin) return [...PAGINAS_PAINEL];
  try {
    const rs = await db.execute({ sql: 'SELECT pagina FROM funcionarios_paginas WHERE funcionario_id = ?', args: [funcionarioId] });
    return rs.rows.map((r) => r.pagina);
  } catch (e) {
    return []; // tabela ainda não migrada nesse banco -- ver funcionarioEhSuperAdmin
  }
}

async function funcionarioTemAcessoPagina(db, funcionarioId, pagina, superAdminJaSabido) {
  const superAdmin = superAdminJaSabido !== undefined ? superAdminJaSabido : await funcionarioEhSuperAdmin(db, funcionarioId);
  if (superAdmin) return true;
  try {
    const rs = await db.execute({
      sql: 'SELECT 1 FROM funcionarios_paginas WHERE funcionario_id = ? AND pagina = ?',
      args: [funcionarioId, pagina],
    });
    return !!rs.rows[0];
  } catch (e) {
    return false; // tabela ainda não migrada nesse banco -- ver funcionarioEhSuperAdmin
  }
}

// Valida um token de sessão, confere a flag admin no banco e, se `pagina`
// for informada, também confere se esse funcionário tem acesso liberado a
// essa página específica (super_admin sempre passa). Não escreve em
// req/res — cada rota decide como formatar o erro; devolve
// { funcionario, superAdmin } no sucesso ou { erro, status } na falha.
async function obterAdminSessao(token, db, pagina) {
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) return { erro: 'Sessão expirada, faça login de novo.', status: 401 };
  if (!(await funcionarioEhAdmin(db, funcionario.id))) {
    return { erro: 'Seu usuário não tem acesso ao painel.', status: 403 };
  }
  const superAdmin = await funcionarioEhSuperAdmin(db, funcionario.id);
  if (pagina && !(await funcionarioTemAcessoPagina(db, funcionario.id, pagina, superAdmin))) {
    return { erro: 'Você não tem acesso a esta área. Peça liberação ao Ricardo.', status: 403 };
  }
  return { funcionario, superAdmin };
}

module.exports = {
  hashPin, gerarTokenPonto, verificarTokenPonto, funcionarioEhAdmin, obterAdminSessao,
  funcionarioEhSuperAdmin, funcionarioTemAcessoPagina, paginasPermitidas, PAGINAS_PAINEL,
};
