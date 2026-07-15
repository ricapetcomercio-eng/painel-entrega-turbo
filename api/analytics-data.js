// api/analytics-data.js
// Rota chamada PELO FRONTEND do painel de analytics (public/index.html).
// Lê os históricos acumulados no Redis e filtra por período ANTES de
// devolver ao navegador — isso mantém o payload pequeno e o carregamento
// rápido, mesmo com o histórico crescendo ao longo dos meses.
//
// Query params opcionais:
//   ?de=YYYY-MM-DD&ate=YYYY-MM-DD
// Se não informados, o padrão é o mês atual (dia 1 até hoje).

const { getRedis } = require('../lib/redis');

const HISTORICO_KEY = 'entrega_turbo:historico_pedidos';
const HISTORICO_FLEX_KEY = 'entrega_turbo:historico_pedidos_flex';

function calcularIntervaloPadrao() {
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0);
  return { de: inicioMes, ate: agora };
}

function parseIntervalo(query) {
  if (!query.de && !query.ate) {
    return calcularIntervaloPadrao();
  }
  const de = query.de ? new Date(query.de + 'T00:00:00') : new Date(0);
  const ate = query.ate ? new Date(query.ate + 'T23:59:59') : new Date();
  return { de, ate };
}

function filtrarPorPeriodo(pedidos, de, ate) {
  return pedidos.filter((p) => {
    const dataCriacao = new Date(p.date_created);
    return dataCriacao >= de && dataCriacao <= ate;
  });
}

module.exports = async (req, res) => {
  const redis = getRedis();
  const { de, ate } = parseIntervalo(req.query || {});

  const pedidosBrutos = await redis.lrange(HISTORICO_KEY, 0, -1);
  const pedidosFlexBrutos = await redis.lrange(HISTORICO_FLEX_KEY, 0, -1);

  const pedidos = filtrarPorPeriodo(pedidosBrutos || [], de, ate);
  const pedidosFlex = filtrarPorPeriodo(pedidosFlexBrutos || [], de, ate);

  res.status(200).json({
    periodo: { de: de.toISOString(), ate: ate.toISOString() },
    total: pedidos.length,
    pedidos,
    totalFlex: pedidosFlex.length,
    pedidosFlex,
  });
};
