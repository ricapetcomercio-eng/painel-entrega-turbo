// lib/shopeeAuth.js
// Autenticação e assinatura de chamadas à Shopee Open API v2.
//
// Variáveis de ambiente necessárias (por loja):
//   SHOPEE_<LOJA>_PARTNER_ID
//   SHOPEE_<LOJA>_PARTNER_KEY
//   SHOPEE_<LOJA>_SHOP_ID
//   SHOPEE_<LOJA>_REFRESH_TOKEN   (fallback inicial; depois é renovado e salvo no Redis)
//
// Chave no Redis: shopee_token:<loja> -> { access_token, refresh_token, expires_at }
//
// Documentação da assinatura: https://open.shopee.com/documents (Authorization)
// base_string = partner_id + path + timestamp [+ access_token + shop_id]
// sign = HMAC_SHA256(base_string, partner_key) em hex

const crypto = require('crypto');
const { getRedis } = require('./redis');

const LOJAS = ['ricapet', 'thapets']; // ajustar conforme as lojas Shopee reais

// SHOPEE_AMBIENTE: 'sandbox' (padrão, enquanto o app está em "Developing"/Test)
// ou 'producao' (depois que o app passar pelo "Go-Live" e tiver credenciais reais).
const AMBIENTE = (process.env.SHOPEE_AMBIENTE || 'sandbox').toLowerCase();
const HOST = AMBIENTE === 'producao'
  ? 'https://partner.shopeemobile.com'
  : 'https://partner.test-stable.shopeemobile.com';

function envPrefix(loja) {
  return `SHOPEE_${loja.toUpperCase()}`;
}

function getLojaConfig(loja) {
  if (!LOJAS.includes(loja)) {
    throw new Error(`Loja Shopee inválida: ${loja}`);
  }
  const prefix = envPrefix(loja);
  const partnerId = process.env[`${prefix}_PARTNER_ID`];
  const partnerKey = process.env[`${prefix}_PARTNER_KEY`];
  const shopId = process.env[`${prefix}_SHOP_ID`];
  const fallbackRefreshToken = process.env[`${prefix}_REFRESH_TOKEN`];

  if (!partnerId || !partnerKey || !shopId) {
    throw new Error(
      `Faltam variáveis ${prefix}_PARTNER_ID / ${prefix}_PARTNER_KEY / ${prefix}_SHOP_ID.`
    );
  }

  return { partnerId, partnerKey, shopId, fallbackRefreshToken };
}

function assinar(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

/**
 * Monta a URL assinada para uma chamada autenticada (com access_token de loja).
 */
function montarUrlAssinada(path, { partnerId, partnerKey, shopId }, accessToken) {
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  const sign = assinar(partnerKey, baseString);

  const params = new URLSearchParams({
    partner_id: partnerId,
    timestamp: String(timestamp),
    access_token: accessToken,
    shop_id: shopId,
    sign,
  });

  return `${HOST}${path}?${params.toString()}`;
}

async function trocarRefreshToken(loja) {
  const { partnerId, partnerKey, shopId, fallbackRefreshToken } = getLojaConfig(loja);
  const redis = getRedis();
  const key = `shopee_token:${loja}`;

  const saved = await redis.get(key);
  const refreshToken = (saved && saved.refresh_token) || fallbackRefreshToken;

  if (!refreshToken) {
    throw new Error(`Nenhum refresh_token disponível para a loja ${loja}.`);
  }

  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = assinar(partnerKey, baseString);

  const url = `${HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: refreshToken,
      partner_id: Number(partnerId),
      shop_id: Number(shopId),
    }),
  });

  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Falha ao renovar token Shopee (${loja}): ${JSON.stringify(data)}`);
  }

  const toSave = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expire_in * 1000,
  };

  await redis.set(key, toSave);
  return toSave.access_token;
}

/**
 * Retorna um access_token válido para a loja informada, renovando se necessário.
 */
async function getShopeeAccessToken(loja) {
  const redis = getRedis();
  const key = `shopee_token:${loja}`;
  const saved = await redis.get(key);
  const now = Date.now();
  const MARGEM_MS = 5 * 60 * 1000;

  if (saved && saved.access_token && saved.expires_at && saved.expires_at - now > MARGEM_MS) {
    return saved.access_token;
  }

  return trocarRefreshToken(loja);
}

/**
 * Faz uma chamada GET autenticada à Shopee API.
 */
async function shopeeGet(loja, path, queryParams = {}) {
  const config = getLojaConfig(loja);
  const accessToken = await getShopeeAccessToken(loja);
  const baseUrl = montarUrlAssinada(path, config, accessToken);

  const extraParams = new URLSearchParams(queryParams).toString();
  const fullUrl = extraParams ? `${baseUrl}&${extraParams}` : baseUrl;

  const resp = await fetch(fullUrl);
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Erro Shopee ${path} (loja ${loja}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { getShopeeAccessToken, shopeeGet, LOJAS };
