// api/analytics-todos-data.js
// Lê o histórico geral (todos os pedidos, qualquer forma de entrega) e
// filtra por período E por forma de entrega ANTES de devolver ao
// navegador. Query params:
//   ?de=YYYY-MM-DD&ate=YYYY-MM-DD&forma_entrega=Mercado%20Envios%20Flex
// forma_entrega omitido ou "todas" = sem filtro de forma de entrega.

const { getRedis } = require('../lib/redis');

const HISTORICO_TODOS_HASH_KEY = 'entrega_turbo:historico_todos_hash';

function calcularIntervaloPadrao() {
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0);
  return { de: inicioMes, ate: agora };
}

function parseIntervalo(query) {
  if (!query.de && !query.ate) return calcularIntervaloPadrao();
  const de = query.de ? new Date(query.de + 'T00:00:00') : new Date(0);
  const ate = query.ate ? new Date(query.ate + 'T23:59:59') : new Date();
  return { de, ate };
}

module.exports = async (req, res) => {
  const redis = getRedis();
  const { de, ate } = parseIntervalo(req.query || {});
  const formaEntregaFiltro = req.query.forma_entrega;

  const hash = await redis.hgetall(HISTORICO_TODOS_HASH_KEY);
  let pedidos = hash ? Object.values(hash) : [];

  pedidos = pedidos.filter((p) => {
    const dataCriacao = new Date(p.date_created);
    return dataCriacao >= de && dataCriacao <= ate;
  });

  // Calcula as formas de entrega disponíveis ANTES do filtro específico,
  // para popular o <select> da tela com as opções reais que existem.
  const formasDisponiveis = [...new Set(pedidos.map((p) => p.forma_entrega || 'Não identificado'))].sort();

  if (formaEntregaFiltro && formaEntregaFiltro !== 'todas') {
    pedidos = pedidos.filter((p) => p.forma_entrega === formaEntregaFiltro);
  }

  res.status(200).json({
    periodo: { de: de.toISOString(), ate: ate.toISOString() },
    total: pedidos.length,
    pedidos,
    formas_entrega_disponiveis: formasDisponiveis,
  });
};
