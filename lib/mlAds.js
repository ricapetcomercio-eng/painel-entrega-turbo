// lib/mlAds.js
// Métricas de anúncio (Product Ads) do Mercado Livre — impressões, cliques,
// custo, unidades vendidas via anúncio. Usa o MESMO access_token OAuth já
// usado pra pedidos (lib/mlAuth.js); a API de Advertising só funciona se o
// app tiver o produto "Advertising"/Publicidade liberado no ML e a conta
// tiver Publicidade ativada (Mercado Livre > Mi perfil > Publicidade) —
// ⚠️ TODO: validado só via api/debug.js?tipo=ml-ads-test, nunca contra
// tráfego real de produção ainda.
//
// Limite documentado da API: só aceita date_from/date_to dentro dos
// últimos 90 dias — por isso a coleta é diária e incremental (grava em
// ads_metricas_diarias via lib/historicoAds.js), nunca um backfill retroativo
// de mais de 90 dias.

const { getMLAccessToken } = require('./mlAuth');

async function mlAdsFetch(path, accessToken, apiVersion = '2') {
  const resp = await fetch(`https://api.mercadolibre.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Api-Version': apiVersion },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Erro ML Ads ${path} (${resp.status}): ${errText}`);
  }
  return resp.json();
}

/**
 * Busca o advertiser_id (Product Ads) da conta. Lança erro com mensagem
 * clara se a conta não tiver Publicidade habilitada (404 documentado).
 */
async function buscarAdvertiserId(conta) {
  const accessToken = await getMLAccessToken(conta);
  const data = await mlAdsFetch('/advertising/advertisers?product_id=PADS', accessToken, '1');
  const advertisers = data.advertisers || [];
  if (!advertisers.length) {
    throw new Error(
      `Nenhum advertiser Product Ads encontrado pra conta ${conta}. ` +
      `Confirme em Mercado Livre > Mi perfil > Publicidade que Product Ads está habilitado nessa conta.`
    );
  }
  // Se houver mais de um site (raro pra contas BR), prioriza MLB.
  const mlb = advertisers.find((a) => a.site_id === 'MLB');
  return (mlb || advertisers[0]).advertiser_id;
}

/**
 * Busca métricas de TODOS os anúncios da conta num intervalo de datas
 * (YYYY-MM-DD, máx. 90 dias pra trás), paginando o endpoint de listagem.
 * Retorna [{ item_id, clicks, prints, cost, units_quantity }].
 */
async function buscarMetricasAnuncios(conta, dataInicio, dataFim, { limit = 100 } = {}) {
  const accessToken = await getMLAccessToken(conta);
  const advertiserId = await buscarAdvertiserId(conta);

  const metrics = 'clicks,prints,cost,units_quantity';
  const resultados = [];
  let offset = 0;
  // Paginação defensiva: nunca mais de 50 páginas (5000 anúncios) numa
  // chamada só, pra não estourar o tempo de execução da function.
  for (let pagina = 0; pagina < 50; pagina++) {
    const data = await mlAdsFetch(
      `/advertising/advertisers/${advertiserId}/product_ads/items` +
        `?limit=${limit}&offset=${offset}&date_from=${dataInicio}&date_to=${dataFim}&metrics=${metrics}`,
      accessToken
    );
    const pageResults = data.results || [];
    for (const item of pageResults) {
      const m = item.metrics || {};
      resultados.push({
        item_id: item.item_id,
        clicks: m.clicks || 0,
        prints: m.prints || 0,
        cost: m.cost || 0,
        units_quantity: m.units_quantity || 0,
      });
    }
    const total = (data.paging && data.paging.total) || 0;
    offset += pageResults.length;
    if (pageResults.length === 0 || offset >= total) break;
  }

  return resultados;
}

module.exports = { buscarAdvertiserId, buscarMetricasAnuncios };
