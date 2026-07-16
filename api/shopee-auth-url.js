// api/shopee-auth-url.js
// Gera o link de autorização Shopee para uma loja específica (ricapet ou
// thapets). Abra no navegador:
//   https://painel-entrega-turbo.vercel.app/api/shopee-auth-url?loja=thapets
// e clique no link retornado. Isso leva à tela de login/aprovação da loja
// na Shopee. Depois de aprovar, a Shopee redireciona automaticamente para
// /api/shopee-callback, que troca o código recebido por um token válido e
// já salva tudo no Redis — não precisa copiar nada manualmente.

const crypto = require('crypto');

const AMBIENTE = (process.env.SHOPEE_AMBIENTE || 'sandbox').toLowerCase();
const HOST = AMBIENTE === 'producao'
  ? 'https://partner.shopeemobile.com'
  : 'https://partner.test-stable.shopeemobile.com';

function assinar(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

module.exports = async (req, res) => {
  const loja = (req.query.loja || '').toLowerCase();
  if (!['ricapet', 'thapets'].includes(loja)) {
    res.status(400).send('Use ?loja=ricapet ou ?loja=thapets');
    return;
  }

  const prefix = `SHOPEE_${loja.toUpperCase()}`;
  const partnerId = process.env[`${prefix}_PARTNER_ID`];
  const partnerKey = process.env[`${prefix}_PARTNER_KEY`];

  if (!partnerId || !partnerKey) {
    res.status(500).send(
      `Faltam as variáveis ${prefix}_PARTNER_ID / ${prefix}_PARTNER_KEY no Vercel. ` +
      `Configure-as e faça um novo deploy antes de tentar autorizar.`
    );
    return;
  }

  const path = '/api/v2/shop/auth_partner';
  const timestamp = Math.floor(Date.now() / 1000);
  const baseString = `${partnerId}${path}${timestamp}`;
  const sign = assinar(partnerKey, baseString);

  // O domínio precisa bater com o "Redirect URL Domain" cadastrado no app
  // Shopee — já confirmado como painel-entrega-turbo.vercel.app.
  const redirect = encodeURIComponent(
    `https://painel-entrega-turbo.vercel.app/api/shopee-callback?loja=${loja}`
  );

  const authUrl = `${HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`;

  res.status(200).send(
    `<p>Ambiente: <b>${AMBIENTE}</b></p>` +
    `<p><a href="${authUrl}">Clique aqui para autorizar a loja "${loja}" na Shopee</a></p>` +
    `<p style="color:#888;font-size:12px;word-break:break-all;">${authUrl}</p>`
  );
};
