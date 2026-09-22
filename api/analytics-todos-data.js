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
//
// ?visao=bipagem devolve o dashboard de bipagem (public/bipagem.html) — lê
// bipagem_diaria (alimentada 1x/dia pelo checkout_bipagem.py local) e cruza
// com registros_ponto pra calcular produtividade (bipagens/hora trabalhada).
// Diferente das outras visões deste arquivo, exige sessão de admin
// (?sessao=...) porque expõe desempenho por funcionário — dado sensível,
// não do mesmo jeito que volume de vendas por SKU.

const { buscarPorPeriodo } = require('../lib/historicoTodos');
const { buscarProdutoPorSku } = require('../lib/tabelaProdutos');
const { getDb } = require('../lib/db');
const { obterAdminSessao } = require('../lib/pontoAuth');
const { dataFusoLoja, isoDeDiaHoraLoja, resolverMarcacoes } = require('../lib/registrosPonto');

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

// Dashboard de bipagem (public/bipagem.html). Um SELECT por período (índice
// em `data`... na prática filtramos por bipado_em_ts, que já vem em epoch
// pronto pra isso, ver comentário no schema) + agregação em JS — mesmo
// espírito "CPU quase zero" de api/dashboard-data.js, nada de loop de rede.
async function responderVisaoBipagem(req, res) {
  const db = getDb();
  const resultadoSessao = await obterAdminSessao(req.query.sessao, db, 'bipagem');
  if (resultadoSessao.erro) { res.status(resultadoSessao.status).json({ error: resultadoSessao.erro }); return; }

  // ?data= (compat, 1 dia só) ou ?de=&ate= (período) -- "Ver histórico
  // completo" no frontend manda de=2020-01-01, bem antes de existir
  // qualquer registro, pra trazer tudo que já foi bipado.
  const ehData = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const hoje = dataFusoLoja(new Date());
  const dataUnica = ehData(req.query.data) ? req.query.data : null;
  const de = ehData(req.query.de) ? req.query.de : (dataUnica || hoje);
  const ate = ehData(req.query.ate) ? req.query.ate : (dataUnica || hoje);

  const inicioIso = isoDeDiaHoraLoja(de, '00:00');
  const fimIso = isoDeDiaHoraLoja(ate, '23:59');
  const inicioTs = Math.floor(new Date(inicioIso).getTime() / 1000);
  const fimTs = Math.floor(new Date(fimIso).getTime() / 1000) + 59;

  const rsPeriodo = await db.execute({
    sql: `SELECT empresa, data, hora, cliente, n_id_pedido, order_id_resolvido, marketplace_resolvido, tipo_envio, bipado_por, marcado_manualmente, bipado_em_ts
          FROM bipagem_diaria WHERE bipado_em_ts BETWEEN ? AND ? ORDER BY bipado_em_ts`,
    args: [inicioTs, fimTs],
  });

  const pedidos = rsPeriodo.rows;

  // Cruza com historico_todos pra saber quais desses pedidos bipados
  // acabaram devolvidos (campo `devolvido`, atualizado por um processo
  // separado em api/collect.js quando a devolução é detectada no ML/Shopee
  // — pode acontecer bem depois da bipagem, por isso a busca aqui NÃO filtra
  // por data, só pelo order_id). Junção por order_id_resolvido = order_id —
  // n_id_pedido (código interno da Omie) NUNCA bate com order_id de nenhum
  // marketplace, confirmado empiricamente (ver CLAUDE.md e
  // lib/bipagemResolver.js pra cadeia completa de tradução via Omie/ML).
  // order_id_resolvido só existe depois que alguém clica "Resolver
  // pendentes" em bipagem.html — até lá, esses pedidos ficam de fora do
  // cruzamento (contam em `nao_localizados`, não é bug).
  const idsPedidosUnicos = [...new Set(pedidos.map((p) => String(p.order_id_resolvido || '').trim()).filter(Boolean))];
  const devolucaoPorPedido = new Map(); // order_id -> { devolvido, status, motivo }
  const TAMANHO_LOTE = 300;
  for (let i = 0; i < idsPedidosUnicos.length; i += TAMANHO_LOTE) {
    const lote = idsPedidosUnicos.slice(i, i + TAMANHO_LOTE);
    const placeholders = lote.map(() => '?').join(',');
    const rsDevolucao = await db.execute({
      sql: `SELECT order_id, devolvido, devolucao_status, devolucao_reason_id FROM historico_todos WHERE order_id IN (${placeholders})`,
      args: lote,
    });
    rsDevolucao.rows.forEach((r) => devolucaoPorPedido.set(String(r.order_id), {
      devolvido: r.devolvido === 1,
      status: r.devolucao_status || null,
      motivo: r.devolucao_reason_id || null,
    }));
  }

  // Tendência diária vem do mesmo resultado acima (agrupado por dia), sem
  // precisar de uma segunda consulta -- o período já é o que o usuário
  // escolheu, não uma janela "últimos N dias" separada como antes.
  const porDia = new Map();
  pedidos.forEach((r) => {
    if (r.bipado_em_ts == null) return;
    const chave = dataFusoLoja(new Date(r.bipado_em_ts * 1000));
    porDia.set(chave, (porDia.get(chave) || 0) + 1);
  });

  const porOperadorMapa = new Map();
  const porEmpresa = {};
  const porTipo = {};
  const porHora = Array.from({ length: 24 }, () => 0);
  let manuais = 0;
  let localizadosTotal = 0;
  let devolvidosTotal = 0;
  const devolucoesDetalhadas = [];

  pedidos.forEach((p) => {
    const nome = p.bipado_por || '(não identificado)';
    if (!porOperadorMapa.has(nome)) {
      porOperadorMapa.set(nome, { nome, total: 0, ricapet: 0, thapets: 0, flex: 0, turbo: 0, outros: 0, manual: 0, localizados: 0, devolvidos: 0 });
    }
    const op = porOperadorMapa.get(nome);
    op.total++;
    if (p.empresa === 'Ricapet') op.ricapet++;
    else if (p.empresa === 'Thapets') op.thapets++;

    const tipo = String(p.tipo_envio || '').toLowerCase();
    if (tipo === 'flex') op.flex++;
    else if (tipo === 'turbo') op.turbo++;
    else op.outros++;

    if (p.marcado_manualmente) { op.manual++; manuais++; }

    const devolucao = devolucaoPorPedido.get(String(p.order_id_resolvido || '').trim());
    if (devolucao !== undefined) {
      op.localizados++;
      localizadosTotal++;
      if (devolucao.devolvido) {
        op.devolvidos++;
        devolvidosTotal++;
        devolucoesDetalhadas.push({
          data: p.data, hora: p.hora, empresa: p.empresa, cliente: p.cliente,
          n_id_pedido: p.n_id_pedido, order_id: p.order_id_resolvido, tipo_envio: p.tipo_envio,
          bipado_por: p.bipado_por || '(não identificado)', marcado_manualmente: !!p.marcado_manualmente,
          devolucao_status: devolucao.status, devolucao_motivo: devolucao.motivo,
        });
      }
    }

    porEmpresa[p.empresa] = (porEmpresa[p.empresa] || 0) + 1;
    porTipo[p.tipo_envio || 'Outros'] = (porTipo[p.tipo_envio || 'Outros'] || 0) + 1;
    if (p.hora) {
      const h = parseInt(String(p.hora).split(':')[0], 10);
      if (h >= 0 && h < 24) porHora[h]++;
    }
  });

  // Cruza com o Ponto: pra cada operador identificado (bipado_por casa com
  // funcionarios.nome, comparação sem acento/maiúscula não é feita aqui --
  // exige que o nome no relatório de bipagem bata com o cadastro do ponto),
  // soma o tempo trabalhado NESSE DIA e calcula bipagens/hora trabalhada.
  const nomesOperadores = [...porOperadorMapa.keys()].filter((n) => n !== '(não identificado)');
  const funcionariosPorNome = new Map();
  if (nomesOperadores.length) {
    const rsFunc = await db.execute('SELECT id, nome FROM funcionarios WHERE ativo = 1');
    rsFunc.rows.forEach((f) => funcionariosPorNome.set(String(f.nome).trim().toLowerCase(), f));
  }

  const operadores = [];
  for (const op of porOperadorMapa.values()) {
    const func = funcionariosPorNome.get(op.nome.trim().toLowerCase());
    let minutosTrabalhados = null;
    if (func) {
      const rsReg = await db.execute({
        sql: `SELECT tipo, registrado_em, origem, ref_nsr, nsr, motivo, editado_por, editado_em, metodo_validacao
              FROM registros_ponto
              WHERE funcionario_id = ? AND registrado_em >= ? AND registrado_em <= ?`,
        args: [func.id, inicioIso, fimIso],
      });
      const marcacoes = resolverMarcacoes(rsReg.rows);
      let ms = 0;
      let aberto = null;
      marcacoes.forEach((m) => {
        if (m.tipo === 'entrada') aberto = new Date(m.registrado_em);
        else if (aberto) { ms += new Date(m.registrado_em) - aberto; aberto = null; }
      });
      minutosTrabalhados = Math.round(ms / 60000);
    }
    operadores.push({
      ...op,
      funcionario_id: func ? func.id : null,
      minutos_trabalhados: minutosTrabalhados,
      bipagens_por_hora: minutosTrabalhados > 0 ? Number((op.total / (minutosTrabalhados / 60)).toFixed(2)) : null,
      taxa_devolucao: op.localizados > 0 ? Number(((op.devolvidos / op.localizados) * 100).toFixed(1)) : null,
    });
  }
  operadores.sort((a, b) => b.total - a.total);

  res.status(200).json({
    ok: true,
    tipo: 'bipagem-dashboard',
    de,
    ate,
    total: pedidos.length,
    manuais,
    localizados_total: localizadosTotal,
    devolvidos_total: devolvidosTotal,
    nao_localizados: pedidos.length - localizadosTotal,
    nao_resolvidos: pedidos.filter((p) => p.n_id_pedido && !p.order_id_resolvido).length,
    por_empresa: porEmpresa,
    por_tipo: porTipo,
    por_hora: porHora,
    operadores,
    pedidos,
    devolucoes: devolucoesDetalhadas.sort((a, b) => (b.data + b.hora).localeCompare(a.data + a.hora)),
    tendencia: [...porDia.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([data, total]) => ({ data, total })),
  });
}

module.exports = async (req, res) => {
  try {
    if (req.query && req.query.visao === 'bipagem') {
      await responderVisaoBipagem(req, res);
      return;
    }
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
