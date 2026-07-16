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
//
// PROXY FIXIE: a Shopee (produção) exige IP fixo autorizado via whitelist.
// Como a Vercel não tem IP de saída fixo, todas as chamadas HTTP para a
// Shopee passam pelo proxy Fixie (variável FIXIE_URL, criada automaticamente
// na integração Vercel+Fixie). Usamos o ProxyAgent do `undici`, que é o que
// o fetch nativo do Node entende via a opção `dispatcher`.

const crypto = require('crypto');
const { ProxyAgent } = require('undici');
const { getRedis } = require('./redis');

const LOJAS = ['ricapet', 'thapets']; // ajustar conforme as lojas Shopee reais

// SHOPEE_AMBIENTE: 'sandbox' (padrão, enquanto o app está em "Developing"/Test)
// ou 'producao' (depois que o app passar pelo "Go-Live" e tiver credenciais reais).
const AMBIENTE = (process.env.SHOPEE_AMBIENTE || 'sandbox').toLowerCase();
const HOST = AMBIENTE === 'producao'
  ? 'https://partner.shopeemobile.com'
  : 'https://partner.test-stable.shopeemobile.com';

// Agente de proxy Fixie, criado uma única vez e reutilizado em todas as chamadas.
// Se FIXIE_URL não estiver definida (ex: ambiente local/dev), cai para chamada direta.
const fixieProxyAgent = process.env.FIXIE_URL
  ? new ProxyAgent(process.env.FIXIE_URL)
  : null;

/**
 * Faz um fetch roteado pelo proxy Fixie (quando disponível).
 * Usado em toda chamada HTTP feita à API da Shopee.
 */
function fetchViaFixie(url, options = {}) {
  if (!fixieProxyAgent) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, dispatcher: fixieProxyAgent });
}

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
  // SHOP_ID e REFRESH_TOKEN agora são OPCIONAIS como env var: depois que a
  // loja passa pelo fluxo de autorização (api/shopee-callback.js), os dois
  // ficam salvos no Redis junto com o token, e são lidos de lá — evitando
  // erro de digitação/mismatch ao copiar valores manualmente. As env vars
  // aqui servem só de fallback (ex: se quiser fixar um shop_id conhecido
  // antes de autorizar pela primeira vez).
  const shopIdEnv = process.env[`${prefix}_SHOP_ID`];
  const fallbackRefreshToken = process.env[`${prefix}_REFRESH_TOKEN`];

  if (!partnerId || !partnerKey) {
    throw new Error(
      `Faltam variáveis ${prefix}_PARTNER_ID / ${prefix}_PARTNER_KEY.`
    );
  }

  return { partnerId, partnerKey, shopIdEnv, fallbackRefreshToken };
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
  const { partnerId, partnerKey, shopIdEnv, fallbackRefreshToken } = getLojaConfig(loja);
  const redis = getRedis();
  const key = `shopee_token:${loja}`;

  const saved = await redis.get(key);
  const refreshToken = (saved && saved.refresh_token) || fallbackRefreshToken;
  const shopId = (saved && saved.shop_id) || shopIdEnv;

  if (!refreshToken) {
    throw new Error(
      `Nenhum refresh_token disponível para a loja ${loja}. Autorize a loja primeiro em /api/shopee-auth-url?loja=${loja}.`
    );
  }
  if (!shopId) {
    throw new Error(
      `Nenhum shop_id disponível para a loja ${loja}. Autorize a loja primeiro em /api/shopee-auth-url?loja=${loja}.`
    );
  }

  const path = '/api/v2/auth/access_token/get';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = assinar(partnerKey, baseString);

  const url = `${HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

  const resp = await fetchViaFixie(url, {
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
    shop_id: String(shopId),
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
  const redis = getRedis();
  const saved = await redis.get(`shopee_token:${loja}`);
  const shopId = (saved && saved.shop_id) || config.shopIdEnv;
  if (!shopId) {
    throw new Error(
      `Nenhum shop_id disponível para a loja ${loja}. Autorize a loja primeiro em /api/shopee-auth-url?loja=${loja}.`
    );
  }
  const accessToken = await getShopeeAccessToken(loja);
  const baseUrl = montarUrlAssinada(path, { ...config, shopId }, accessToken);

  const extraParams = new URLSearchParams(queryParams).toString();
  const fullUrl = extraParams ? `${baseUrl}&${extraParams}` : baseUrl;

  const resp = await fetchViaFixie(fullUrl);
  const data = await resp.json();
  if (!resp.ok || data.error) {
    throw new Error(`Erro Shopee ${path} (loja ${loja}): ${JSON.stringify(data)}`);
  }
  return data;
}

module.exports = { getShopeeAccessToken, shopeeGet, LOJAS };
