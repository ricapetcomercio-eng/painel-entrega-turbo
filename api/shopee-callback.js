// api/shopee-callback.js
// Recebe o redirect da autorização Shopee (depois que a loja aprova o
// acesso no fluxo OAuth, iniciado em /api/shopee-auth-url) e troca o `code`
// recebido por access_token + refresh_token, salvando tudo no Turso já
// vinculado à loja certa (junto com o shop_id, capturado automaticamente
// aqui — não precisa configurar SHOP_ID manualmente no Vercel).

const crypto = require('crypto');
const { fetchViaFixie, salvarTokenShopee } = require('../lib/shopeeAuth');

const AMBIENTE = (process.env.SHOPEE_AMBIENTE || 'sandbox').toLowerCase();
const HOST = AMBIENTE === 'producao'
  ? 'https://partner.shopeemobile.com'
  : 'https://partner.test-stable.shopeemobile.com';

function assinar(partnerKey, baseString) {
  return crypto.createHmac('sha256', partnerKey).update(baseString).digest('hex');
}

module.exports = async (req, res) => {
  try {
    const { code, shop_id: shopId, loja } = req.query;

    if (!code || !shopId || !loja) {
      res.status(400).send(
        `Faltam parâmetros no redirect (code=${code || '-'}, shop_id=${shopId || '-'}, loja=${loja || '-'}). ` +
        `Confirme que a URL de autorização foi gerada em /api/shopee-auth-url?loja=...`
      );
      return;
    }

    const prefix = `SHOPEE_${String(loja).toUpperCase()}`;
    const partnerId = process.env[`${prefix}_PARTNER_ID`];
    const partnerKey = process.env[`${prefix}_PARTNER_KEY`];

    if (!partnerId || !partnerKey) {
      res.status(500).send(`Faltam as variáveis ${prefix}_PARTNER_ID / ${prefix}_PARTNER_KEY no Vercel.`);
      return;
    }

    const path = '/api/v2/auth/token/get';
    const timestamp = Math.floor(Date.now() / 1000);
    const baseString = `${partnerId}${path}${timestamp}`;
    const sign = assinar(partnerKey, baseString);

    const url = `${HOST}${path}?partner_id=${partnerId}&timestamp=${timestamp}&sign=${sign}`;

    const resp = await fetchViaFixie(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        shop_id: Number(shopId),
        partner_id: Number(partnerId),
      }),
    });

    const data = await resp.json();
    if (!resp.ok || data.error) {
      res.status(500).send(`Falha ao trocar code por token (${loja}): ${JSON.stringify(data)}`);
      return;
    }

    await salvarTokenShopee(loja, {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      shop_id: String(shopId),
      expires_at: Date.now() + data.expire_in * 1000,
    });

    res.status(200).send(
      `<h2>Loja "${loja}" autorizada com sucesso!</h2>` +
      `<p>shop_id: ${shopId}</p>` +
      `<p>Token salvo. Pode fechar esta aba e voltar para o painel.</p>`
    );
  } catch (err) {
    res.status(500).send(`Erro: ${err.message}`);
  }
};
