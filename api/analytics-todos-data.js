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
//
// ?visao=produtos devolve, em vez do histórico cru, a agregação mensal por
// produto (aba "Desempenho") — dividindo o mesmo arquivo/rota em vez de
// criar um endpoint novo, pra não estourar o limite de 12 Serverless
// Functions do plano Hobby da Vercel (mesmo motivo documentado em
// api/pendencias-ml.js).

const { buscarPorPeriodo } = require('../lib/historicoTodos');
const { buscarProdutoPorSku } = require('../lib/tabelaProdutos');

const MES_LABELS_BASE = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function chaveMes(dataISO) {
  const d = new Date(dataISO);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function rotuloMes(chave) {
  const [ano, mes] = chave.split('-');
  return `${MES_LABELS_BASE[Number(mes) - 1]}/${ano}`;
}

// Gera a lista contígua de meses entre o primeiro e o último encontrado nos
// dados, preenchendo buracos — pra evolução mensal não pular meses sem venda.
function periodosContiguos(chaves) {
  if (!chaves.length) return [];
  const [anoIni, mesIni] = chaves[0].split('-').map(Number);
  const [anoFim, mesFim] = chaves[chaves.length - 1].split('-').map(Number);
  const resultado = [];
  let ano = anoIni;
  let mes = mesIni;
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    resultado.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes++;
    if (mes > 12) { mes = 1; ano++; }
  }
  return resultado;
}

// Converte "YYYY-MM" em timestamp de início (dia 1, 00:00) ou fim (último
// dia, 23:59:59) do mês — usado pelo filtro de período (mês De/Até) da aba
// Desempenho.
function inicioDoMes(chaveMesStr) {
  const [ano, mes] = chaveMesStr.split('-').map(Number);
  return new Date(ano, mes - 1, 1, 0, 0, 0).getTime();
}
function fimDoMes(chaveMesStr) {
  const [ano, mes] = chaveMesStr.split('-').map(Number);
  return new Date(ano, mes, 0, 23, 59, 59, 999).getTime();
}

async function responderVisaoProdutos(req, res) {
  const meses = parseInt(req.query.meses, 10) || null;
  const mesDe = req.query.mes_de || null; // "YYYY-MM"
  const mesAte = req.query.mes_ate || null;

  let desdeTs = 0;
  let ateTs = Date.now();
  if (mesDe || mesAte) {
    if (mesDe) desdeTs = inicioDoMes(mesDe);
    if (mesAte) ateTs = fimDoMes(mesAte);
  } else if (meses) {
    const agora = new Date();
    const desde = new Date(agora.getFullYear(), agora.getMonth() - meses + 1, 1);
    desdeTs = desde.getTime();
  }

  let pedidos = await buscarPorPeriodo(desdeTs, ateTs);

  // Filtros de marketplace/conta — mesmo espírito do forma_entrega/estado
  // já usado no modo padrão desta rota (filtra a lista já buscada, em vez
  // de mudar a query no banco).
  const marketplaceFiltro = req.query.marketplace;
  const contaFiltro = req.query.conta;
  if (marketplaceFiltro && marketplaceFiltro !== 'todos') {
    pedidos = pedidos.filter((p) => p.marketplace === marketplaceFiltro);
  }
  if (contaFiltro && contaFiltro !== 'todos') {
    pedidos = pedidos.filter((p) => p.conta === contaFiltro);
  }

  const produtos = {}; // nome -> { totalVendas, totalUnidades, porMes: {mes:{vendas,unidades}}, variacoes: {chave:{cor,tamanho,vendas,unidades}} }
  const mesesEncontrados = new Set();
  let itensSemPreco = 0;
  let itensSemMapeamento = 0;
  let itensTotal = 0;

  for (const pedido of pedidos) {
    if (!pedido.date_created || !Array.isArray(pedido.itens) || pedido.itens.length === 0) continue;
    const mes = chaveMes(pedido.date_created);
    mesesEncontrados.add(mes);

    for (const item of pedido.itens) {
      itensTotal++;
      const quantidade = Number(item.quantidade) || 0;
      const info = buscarProdutoPorSku(item.sku);
      if (info.produto === 'Não mapeado') itensSemMapeamento++;

      const temPreco = typeof item.valor_unitario === 'number';
      if (!temPreco) itensSemPreco++;
      const vendas = temPreco ? item.valor_unitario * quantidade : 0;

      if (!produtos[info.produto]) {
        produtos[info.produto] = { totalVendas: 0, totalUnidades: 0, porMes: {}, variacoes: {} };
      }
      const p = produtos[info.produto];
      p.totalVendas += vendas;
      p.totalUnidades += quantidade;
      if (!p.porMes[mes]) p.porMes[mes] = { vendas: 0, unidades: 0 };
      p.porMes[mes].vendas += vendas;
      p.porMes[mes].unidades += quantidade;

      const chaveVar = `${info.cor}|${info.tamanho}`;
      if (!p.variacoes[chaveVar]) p.variacoes[chaveVar] = { cor: info.cor, tamanho: info.tamanho, vendas: 0, unidades: 0 };
      p.variacoes[chaveVar].vendas += vendas;
      p.variacoes[chaveVar].unidades += quantidade;
    }
  }

  const periodos = periodosContiguos([...mesesEncontrados].sort());
  const mesLabels = {};
  periodos.forEach((m) => { mesLabels[m] = rotuloMes(m); });

  const produtosSaida = Object.entries(produtos)
    .map(([nome, p]) => ({
      nome,
      total_vendas: Math.round(p.totalVendas * 100) / 100,
      total_unidades: p.totalUnidades,
      por_mes: p.porMes,
      variacoes: Object.values(p.variacoes),
    }))
    .sort((a, b) => b.total_vendas - a.total_vendas);

  res.status(200).json({
    periodos,
    mes_labels: mesLabels,
    produtos: produtosSaida,
    meta: {
      total_pedidos: pedidos.length,
      itens_total: itensTotal,
      itens_sem_preco: itensSemPreco,
      itens_sem_mapeamento: itensSemMapeamento,
      cobertura_preco_pct: itensTotal ? Math.round(((itensTotal - itensSemPreco) / itensTotal) * 1000) / 10 : 0,
    },
  });
}

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
    if (req.query && req.query.visao === 'produtos') {
      await responderVisaoProdutos(req, res);
      return;
    }

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
