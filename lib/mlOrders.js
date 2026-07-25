// lib/mlOrders.js
// IDs de vendedor do Mercado Livre, usados por lib/mlFlexOrders.js e
// lib/mlAllOrders.js pra montar as chamadas de /orders/search.
//
// (Este arquivo já teve um coletor de pedidos "expressos" próprio — removido
// porque não era mais usado: a detecção real de Flex/Turbo/Envios Agora
// hoje vive em lib/mlFlexOrders.js, com Turbo identificado via tags do
// shipment, confirmado na doc oficial do ML.)

const SELLER_IDS = {
  ricapet: '736787693',
  thapets: '1139210125',
};

module.exports = { SELLER_IDS };
