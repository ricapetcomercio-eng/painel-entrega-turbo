// api/analytics-todos-data.js
// Lê o histórico geral (todos os pedidos, qualquer forma de entrega) e
// filtra por período, forma de entrega E estado ANTES de devolver ao
// navegador. Query params:
//   ?de=YYYY-MM-DD&ate=YYYY-MM-DD&forma_entrega=Mercado%20Envios%20Flex&estado=São%20Paulo
// forma_entrega/estado omitidos ou "todas"/"todos" = sem filtro.
//
// IMPORTANTE: com o histórico crescendo (dezenas de milhares de pedidos),
// buscar o HASH inteiro (hgetall) a cada chamada fica pesado demais e pode
// até estourar limite de tamanho de resposta do Redis/Vercel. Por isso,
// usamos o ZSET (indexado por data) para pegar só os IDs do período pedido,
// e buscamos só esses registros específicos (hmget), não o hash inteiro.

const { getRedis } = require('../lib/redis');

const HISTORICO_TODOS_HASH_KEY = 'entrega_turbo:historico_todos_hash';
const HISTORICO_TODOS_ZSET_KEY = 'entrega_turbo:historico_todos_zset';

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
  try {
    const redis = getRedis();
    const { de, ate } = parseIntervalo(req.query || {});
    const formaEntregaFiltro = req.query.forma_entrega;
    const estadoFiltro = req.query.estado;

    // 1) Pega só os IDs cujo timestamp está dentro do período pedido.
    const ids = await redis.zrange(HISTORICO_TODOS_ZSET_KEY, de.getTime(), ate.getTime(), { byScore: true });

    // 2) Busca só esses registros específicos, não o hash inteiro.
    let pedidos = [];
    if (ids.length > 0) {
      const TAMANHO_LOTE = 500; // hmget também tem limite prático por chamada
      for (let i = 0; i < ids.length; i += TAMANHO_LOTE) {
        const lote = ids.slice(i, i + TAMANHO_LOTE);
        const valores = await redis.hmget(HISTORICO_TODOS_HASH_KEY, ...lote);
        if (valores) {
          pedidos.push(...Object.values(valores).filter(Boolean));
        }
      }
    }

    // Calcula as formas de entrega e estados disponíveis ANTES dos filtros
    // específicos, para popular os controles da tela com valores reais.
    const formasDisponiveis = [...new Set(pedidos.map((p) => p.forma_entrega || 'Não identificado'))].sort();
    const estadosDisponiveis = [...new Set(pedidos.map((p) => p.estado || 'Não identificado'))].sort();

    if (formaEntregaFiltro && formaEntregaFiltro !== 'todas') {
      pedidos = pedidos.filter((p) => p.forma_entrega === formaEntregaFiltro);
    }
    if (estadoFiltro && estadoFiltro !== 'todos') {
      pedidos = pedidos.filter((p) => p.estado === estadoFiltro);
    }

    res.status(200).json({
      periodo: { de: de.toISOString(), ate: ate.toISOString() },
      total: pedidos.length,
      pedidos,
      formas_entrega_disponiveis: formasDisponiveis,
      estados_disponiveis: estadosDisponiveis,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
