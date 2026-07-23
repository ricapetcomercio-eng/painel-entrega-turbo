// lib/mlAuth.js
// Gerencia access_token/refresh_token do Mercado Livre para as duas contas
// (Ricapet e Thapets), guardando e renovando via Turso (SQLite na nuvem —
// banco dedicado, migrado do Redis compartilhado que causava estouro de cota).
//
// Variáveis de ambiente necessárias:
//   ML_RICAPET_CLIENT_ID, ML_RICAPET_CLIENT_SECRET, ML_RICAPET_REFRESH_TOKEN
//   ML_THAPETS_CLIENT_ID, ML_THAPETS_CLIENT_SECRET, ML_THAPETS_REFRESH_TOKEN
//
// Tabela: ml_tokens (conta TEXT PRIMARY KEY, access_token, refresh_token, user_id, expires_at)

const { getDb } = require('./db');

const CONTAS = ['ricapet', 'thapets'];

function envPrefix(conta) {
  return `ML_${conta.toUpperCase()}`;
}

function getContaConfig(conta) {
  if (!CONTAS.includes(conta)) {
    throw new Error(`Conta ML inválida: ${conta}. Use 'ricapet' ou 'thapets'.`);
  }
  const prefix = envPrefix(conta);
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const fallbackRefreshToken = process.env[`${prefix}_REFRESH_TOKEN`];
  if (!clientId || !clientSecret) {
    throw new Error(
      `Faltam variáveis de ambiente ${prefix}_CLIENT_ID / ${prefix}_CLIENT_SECRET.`
    );
  }
  return { clientId, clientSecret, fallbackRefreshToken };
}

async function trocarRefreshTokenPorAccessToken(clientId, clientSecret, refreshToken) {
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha ao renovar token ML (${resp.status}): ${errText}`);
  }
  return resp.json();
  // { access_token, token_type, expires_in, scope, user_id, refresh_token }
}

async function buscarTokenSalvo(conta) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT access_token, refresh_token, user_id, expires_at FROM ml_tokens WHERE conta = ?',
    args: [conta],
  });
  return rs.rows[0] || null;
}

async function salvarToken(conta, dados) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO ml_tokens (conta, access_token, refresh_token, user_id, expires_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conta) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            user_id = excluded.user_id,
            expires_at = excluded.expires_at`,
    args: [conta, dados.access_token, dados.refresh_token, dados.user_id || null, dados.expires_at],
  });
}

/**
 * Retorna um access_token válido para a conta informada, renovando
 * automaticamente se estiver expirado ou perto de expirar.
 * @param {'ricapet'|'thapets'} conta
 */
async function getMLAccessToken(conta) {
  const { clientId, clientSecret, fallbackRefreshToken } = getContaConfig(conta);
  const saved = await buscarTokenSalvo(conta);
  const now = Date.now();
  // Margem de segurança: renova se faltar menos de 5 minutos para expirar
  const MARGEM_MS = 5 * 60 * 1000;
  if (saved && saved.access_token && saved.expires_at && saved.expires_at - now > MARGEM_MS) {
    return saved.access_token;
  }

  const refreshTokenParaUsar = (saved && saved.refresh_token) || fallbackRefreshToken;
  if (!refreshTokenParaUsar) {
    throw new Error(
      `Nenhum refresh_token disponível para a conta ${conta}. ` +
      `Defina ${envPrefix(conta)}_REFRESH_TOKEN ou salve um token válido (tabela ml_tokens, conta=${conta}).`
    );
  }

  const tokenData = await trocarRefreshTokenPorAccessToken(clientId, clientSecret, refreshTokenParaUsar);
  const toSave = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || refreshTokenParaUsar,
    user_id: tokenData.user_id,
    expires_at: now + tokenData.expires_in * 1000,
  };
  await salvarToken(conta, toSave);
  return toSave.access_token;
}

module.exports = { getMLAccessToken, CONTAS };
