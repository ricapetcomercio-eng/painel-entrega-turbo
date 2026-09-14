// lib/mpAuth.js
// Gerencia access_token/refresh_token de um app OAuth do Mercado Livre
// dedicado a escopos de pagamento/faturamento (Mercado Pago), separado do
// app usado em lib/mlAuth.js (que cuida de pedidos/anúncios/etc). Mesmo
// fluxo OAuth (auth.mercadolivre.com.br), app diferente, escopos diferentes
// ("Faturamento de uma venda" / "Payments") — necessário pra consultar
// /v1/payments/search (money_release_date) na API do Mercado Pago.
//
// Variáveis de ambiente necessárias (por conta):
//   MP_RICAPET_CLIENT_ID, MP_RICAPET_CLIENT_SECRET
//   MP_THAPETS_CLIENT_ID, MP_THAPETS_CLIENT_SECRET
//
// Tabela: mp_tokens (conta TEXT PRIMARY KEY, access_token, refresh_token, user_id, expires_at)

const { getDb } = require('./db');

const CONTAS = ['ricapet', 'thapets'];

function envPrefix(conta) {
  return `MP_${conta.toUpperCase()}`;
}

function getContaConfig(conta) {
  if (!CONTAS.includes(conta)) {
    throw new Error(`Conta MP inválida: ${conta}. Use 'ricapet' ou 'thapets'.`);
  }
  const prefix = envPrefix(conta);
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) {
    throw new Error(
      `Faltam variáveis de ambiente ${prefix}_CLIENT_ID / ${prefix}_CLIENT_SECRET.`
    );
  }
  return { clientId, clientSecret };
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
    throw new Error(`Falha ao renovar token MP (${resp.status}): ${errText}`);
  }
  return resp.json();
  // { access_token, token_type, expires_in, scope, user_id, refresh_token }
}

/**
 * Troca um "code" de autorização (fluxo OAuth feito manualmente uma vez
 * pelo usuário, via /api/debug?tipo=mp-oauth-url) por access_token/refresh_token
 * iniciais — necessário porque este app ainda não tem nenhum refresh_token
 * salvo (nunca foi autorizado antes).
 */
async function trocarCodigoPorTokens(clientId, clientSecret, code, redirectUri) {
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Falha ao trocar code por token MP (${resp.status}): ${errText}`);
  }
  return resp.json();
}

async function buscarTokenSalvo(conta) {
  const db = getDb();
  const rs = await db.execute({
    sql: 'SELECT access_token, refresh_token, user_id, expires_at FROM mp_tokens WHERE conta = ?',
    args: [conta],
  });
  return rs.rows[0] || null;
}

async function salvarToken(conta, dados) {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO mp_tokens (conta, access_token, refresh_token, user_id, expires_at)
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
 * Retorna um access_token MP válido para a conta informada, renovando
 * automaticamente se estiver expirado ou perto de expirar.
 * @param {'ricapet'|'thapets'} conta
 */
async function getMPAccessToken(conta) {
  const { clientId, clientSecret } = getContaConfig(conta);
  const saved = await buscarTokenSalvo(conta);
  const now = Date.now();
  const MARGEM_MS = 5 * 60 * 1000;
  if (saved && saved.access_token && saved.expires_at && saved.expires_at - now > MARGEM_MS) {
    return saved.access_token;
  }

  if (!saved || !saved.refresh_token) {
    throw new Error(
      `Nenhum refresh_token disponível para a conta ${conta}. ` +
      `Autorize primeiro em /api/debug?tipo=mp-oauth-url&conta=${conta}&redirect_uri=...`
    );
  }

  const tokenData = await trocarRefreshTokenPorAccessToken(clientId, clientSecret, saved.refresh_token);
  const toSave = {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token || saved.refresh_token,
    user_id: tokenData.user_id,
    expires_at: now + tokenData.expires_in * 1000,
  };
  await salvarToken(conta, toSave);
  return toSave.access_token;
}

module.exports = { getMPAccessToken, CONTAS, getContaConfig, trocarCodigoPorTokens, salvarToken };
