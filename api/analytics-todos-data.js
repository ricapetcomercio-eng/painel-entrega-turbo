// api/analytics-todos-data.js
// Lê o histórico geral (todos os pedidos, qualquer forma de entrega) e
// filtra por período, forma de entrega E estado ANTES de devolver ao
// navegador. Query params:
//   ?de=YYYY-MM-DD&ate=YYYY-MM-DD&forma_entrega=Mercado%20Envios%20Flex&estado=São%20Paulo
// forma_entrega/estado omitidos ou "todas"/"todos" = sem filtro.
//
// Migrado do Redis (ZSET+HASH) para Turso — a consulta por período agora é
// um SELECT direto com WHERE, sem precisar do padrão de score/paginação
// manual que o Redis exigia.

const { buscarPorPeriodo } = require('../lib/historicoTodos');

function calcularIntervaloPadrao() {
  const agora = new Date();
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1, 0, 0, 0);
  return { de: inicioMes, ate: agora };
}

function parseData(valor, horaPadrao) {
  if (!valor) return null;
  // Se já vier com hora embutida (ex: "2026-07-16T11:58:00.000Z"), é uma
  // janela rolante (como "últimas 24 horas") — usa exatamente como veio,
  // sem arredondar para início/fim do dia.
  if (valor.includes('T')) return new Date(valor);
  // Caso contrário, é só uma data (YYYY-MM-DD) — comportamento original,
  // dia inteiro (00:00:00 até 23:59:59).
  return new Date(valor + horaPadrao);
}

function parseIntervalo(query) {
  if (!query.de && !query.ate) return calcularIntervaloPadrao();
  const de = parseData(query.de, 'T00:00:00') || new Date(0);
  const ate = parseData(query.ate, 'T23:59:59') || new Date();
  return { de, ate };
}

module.exports = async (req, res) => {
  try {
    const { de, ate } = parseIntervalo(req.query || {});
    const formaEntregaFiltro = req.query.forma_entrega;
    const estadoFiltro = req.query.estado;

    let pedidos = await buscarPorPeriodo(de.getTime(), ate.getTime());

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
