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

// Valida um token de sessão e confere a flag admin no banco. Não escreve em
// req/res — cada rota decide como formatar o erro; devolve { funcionario }
// no sucesso ou { erro, status } na falha.
async function obterAdminSessao(token, db) {
  const funcionario = verificarTokenPonto(token);
  if (!funcionario) return { erro: 'Sessão expirada, faça login de novo.', status: 401 };
  if (!(await funcionarioEhAdmin(db, funcionario.id))) {
    return { erro: 'Seu usuário não tem acesso ao painel.', status: 403 };
  }
  return { funcionario };
}

module.exports = { hashPin, gerarTokenPonto, verificarTokenPonto, funcionarioEhAdmin, obterAdminSessao };
