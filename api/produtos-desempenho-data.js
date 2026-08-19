// api/produtos-desempenho-data.js
// Agrega o histórico geral de pedidos (lib/historicoTodos.js) por mês e por
// produto/variação, cruzando o SKU de cada item com a planilha
// TABELA_AUXILIAR (lib/tabelaProdutos.js) — alimenta a aba "Desempenho" do
// painel (evolução mensal, matriz mês x produto, variações, ranking).
//
// Só devolve o agregado (pequeno) pro navegador, nunca os pedidos crus —
// o histórico pode ter dezenas de milhares de linhas.
//
// Query params: ?meses=N limita aos últimos N meses (default: todo o
// histórico).

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

module.exports = async (req, res) => {
  try {
    const meses = parseInt(req.query.meses, 10) || null;
    let desdeTs = 0;
    const ateTs = Date.now();
    if (meses) {
      const agora = new Date();
      const desde = new Date(agora.getFullYear(), agora.getMonth() - meses + 1, 1);
      desdeTs = desde.getTime();
    }

    const pedidos = await buscarPorPeriodo(desdeTs, ateTs);

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
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
