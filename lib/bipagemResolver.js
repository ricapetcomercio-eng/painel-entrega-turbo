// lib/bipagemResolver.js
// Traduz bipagem_diaria.n_id_pedido (codigo_pedido INTERNO da Omie — não é
// order_id nem shipment_id de nenhum marketplace, confirmado empiricamente,
// ver CLAUDE.md) pro order_id real do canal de venda (Mercado Livre ou
// Shopee), pra permitir cruzar bipagem com devolução via
// historico_todos.order_id.
//
// Cadeia de resolução (confirmada com dado real de produção):
//   Omie ConsultarPedido(codigo_pedido) -> cabecalho.origem_pedido:
//     "SHP" (Shopee)       -> numero_pedido_cliente JÁ é o order_id.
//     "MLV" (Mercado Livre) -> numero_pedido_cliente é, na verdade, o
//        shipment_id — precisa de mais 1 chamada (GET /shipments/{id})
//        pra pegar o order_id de verdade.
//
// Custo: 1 chamada (Shopee) ou 2 chamadas (ML) por pedido resolvido — por
// isso só roda sob demanda (botão "Resolver pendentes" em bipagem.html),
// nunca em loop automático, mesmo espírito de custo controlado do resto
// do projeto (ver CLAUDE.md).

const { getOmieConfig } = require('./omieContasPagar');
const { getMLAccessToken } = require('./mlAuth');

async function consultarPedidoOmie(conta, codigoPedido) {
  const { appKey, appSecret } = getOmieConfig(conta);
  const resp = await fetch('https://app.omie.com/api/v1/produtos/pedido/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call: 'ConsultarPedido',
      app_key: appKey,
      app_secret: appSecret,
      param: [{ codigo_pedido: Number(codigoPedido) }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Erro Omie ConsultarPedido (${conta}, ${codigoPedido}): ${JSON.stringify(data)}`);
  return data.pedido_venda_produto;
}

async function buscarOrderIdViaShipment(conta, shipmentId) {
  const accessToken = await getMLAccessToken(conta);
  const resp = await fetch(`https://api.mercadolibre.com/shipments/${shipmentId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Erro ML /shipments/${shipmentId} (${resp.status}): ${JSON.stringify(data)}`);
  return data.order_id ? String(data.order_id) : null;
}

/**
 * @param {'ricapet'|'thapets'} conta
 * @param {string|number} codigoPedidoOmie — bipagem_diaria.n_id_pedido
 * @returns {Promise<{orderId: string|null, marketplace: 'mercado_livre'|'shopee'|null, erro: string|null}>}
 */
async function resolverPedidoBipagem(conta, codigoPedidoOmie) {
  let pedido;
  try {
    pedido = await consultarPedidoOmie(conta, codigoPedidoOmie);
  } catch (err) {
    return { orderId: null, marketplace: null, erro: err.message };
  }
  if (!pedido || !pedido.cabecalho) {
    return { orderId: null, marketplace: null, erro: 'Pedido não encontrado na Omie.' };
  }

  const origem = pedido.cabecalho.origem_pedido;
  const numeroPedidoCliente = pedido.informacoes_adicionais && pedido.informacoes_adicionais.numero_pedido_cliente;

  if (origem === 'SHP') {
    return {
      orderId: numeroPedidoCliente || null,
      marketplace: 'shopee',
      erro: numeroPedidoCliente ? null : 'Pedido Shopee sem numero_pedido_cliente na Omie.',
    };
  }

  if (origem === 'MLV') {
    if (!numeroPedidoCliente) {
      return { orderId: null, marketplace: 'mercado_livre', erro: 'Pedido ML sem numero_pedido_cliente (shipment_id) na Omie.' };
    }
    try {
      const orderId = await buscarOrderIdViaShipment(conta, numeroPedidoCliente);
      return { orderId, marketplace: 'mercado_livre', erro: orderId ? null : 'Shipment do ML sem order_id.' };
    } catch (err) {
      return { orderId: null, marketplace: 'mercado_livre', erro: err.message };
    }
  }

  return { orderId: null, marketplace: null, erro: `origem_pedido desconhecida na Omie: "${origem}"` };
}

module.exports = { resolverPedidoBipagem };
