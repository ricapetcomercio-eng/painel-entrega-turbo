// lib/omieContasPagar.js
// Projeção Financeira (Saídas): soma, por dia de vencimento, os títulos em
// aberto (status_titulo diferente de "PAGO") na API de Contas a Pagar do
// Omie — confirmado por teste manual (endpoint de debug
// api/debug.js?tipo=omie-contas-pagar-test) que:
//   - filtrar_por_data_de/ate NÃO filtra por data_vencimento — filtra por
//     algo como data de alteração do registro (dAlt). Confirmado
//     empiricamente: um título "A VENCER" com dAlt=15/09 e
//     data_vencimento=30/09 sumia de uma janela filtrar_por_data_de=16/09
//     (começando 1 dia depois do dAlt), mas aparecia numa janela mais larga
//     que começasse antes do dAlt — mesmo a data de vencimento estando
//     dentro das duas janelas. Ou seja, não dá pra confiar nesse filtro pra
//     recortar "títulos vencendo nos próximos N dias".
//   - Por isso a estratégia aqui é: pedir uma janela BEM ampla pro lado da
//     Omie (JANELA_PASSADO_DIAS pra trás, cobre qualquer dAlt histórico) e
//     filtrar de verdade por data_vencimento no nosso próprio código.
//   - status_titulo vem como "PAGO", "A VENCER" (visto) e provavelmente
//     "VENCIDO" (não visto na amostra, mas documentado pela Omie) — os dois
//     últimos ainda representam dinheiro que vai sair da conta, então ambos
//     contam; só "PAGO" é excluído.
//   - Omie trata Ricapet e Thapets como contas/apps separados (OMIE_<CONTA>_
//     APP_KEY/_APP_SECRET), mesmo padrão do Mercado Pago/Shopee neste repo.
//
// Chamado sob demanda (botão "Atualizar agora" em projecao-financeira.html),
// nunca no cron automático — mesmo motivo do Mercado Pago/Shopee (ver
// CLAUDE.md): dado não precisa estar sempre fresco.

const { dataFusoLoja } = require('./registrosPonto');

const CONTAS = ['ricapet', 'thapets'];
const HORIZONTE_DIAS = 45;
const JANELA_PASSADO_DIAS = 1000; // ~2,7 anos — cobre todo o histórico observado nas duas contas (desde ~jan/2024)
const REGISTROS_POR_PAGINA = 100;
// Trava de segurança: no máximo 6.000 títulos por conta/execução. Medido em
// produção: a Ricapet tem ~4.150 títulos no histórico total (~2 anos), a
// Thapets ~1.400 — como não dá pra confiar no filtro de data da Omie (ver
// nota acima), precisamos paginar por boa parte do histórico e filtrar por
// data_vencimento no nosso lado. 6.000 cobre com folga o volume atual.
const MAX_PAGINAS = 60;
// Trava de segurança equivalente pra resolução de nome de fornecedor (ver
// resolverNomesFornecedores): 1 chamada extra por FORNECEDOR ÚNICO (não por
// título) na janela de HORIZONTE_DIAS — bem menos que MAX_PAGINAS porque o
// número de fornecedores distintos ativos numa empresa é muito menor que o
// número de títulos.
const MAX_FORNECEDORES_RESOLVIDOS = 150;

function getOmieConfig(conta) {
  if (!CONTAS.includes(conta)) {
    throw new Error(`Conta Omie inválida: ${conta}. Use 'ricapet' ou 'thapets'.`);
  }
  const prefix = `OMIE_${conta.toUpperCase()}`;
  const appKey = process.env[`${prefix}_APP_KEY`];
  const appSecret = process.env[`${prefix}_APP_SECRET`];
  if (!appKey || !appSecret) {
    throw new Error(`Faltam variáveis de ambiente ${prefix}_APP_KEY / ${prefix}_APP_SECRET.`);
  }
  return { appKey, appSecret };
}

function fmtDataOmie(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Omie devolve datas como "DD/MM/AAAA" — converte pra "AAAA-MM-DD", mesmo
// formato de chave usado em por_dia no Mercado Pago/Shopee. `t.data_vencimento`
// em si já é uma data de calendário (sem hora/fuso) — não precisa de
// dataFusoLoja aqui. Quem precisa é o "hoje" do SERVIDOR usado como corte
// (ver hojeChave em coletarContasPagar): esse sim carrega hora real e tem
// que ser convertido pro fuso de São Paulo antes de virar chave AAAA-MM-DD.
function dataOmieParaChave(dataOmie) {
  const [dd, mm, aaaa] = dataOmie.split('/');
  return `${aaaa}-${mm}-${dd}`;
}

// Resolve nome (razão social/nome fantasia) de um fornecedor via API de
// Clientes/Fornecedores do Omie — a Contas a Pagar só devolve o código
// (codigo_cliente_fornecedor), não o nome. Testável isoladamente em
// /api/debug?tipo=omie-cliente-test&conta=ricapet&codigo=... antes de
// confiar cegamente no formato da resposta (mesmo padrão empírico do resto
// deste arquivo). Devolve null (não lança) em qualquer falha — um
// fornecedor sem nome resolvido não pode derrubar a coleta inteira, a tela
// já tem fallback pra mostrar "Fornecedor #<código>" nesse caso.
async function resolverNomeFornecedor(appKey, appSecret, codigo) {
  try {
    const resp = await fetch('https://app.omie.com/api/v1/geral/clientes/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call: 'ConsultarCliente',
        app_key: appKey,
        app_secret: appSecret,
        param: [{ codigo_cliente_omie: codigo }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok || data.faultstring) return null;
    return data.nome_fantasia || data.razao_social || null;
  } catch (e) {
    return null;
  }
}

// Resolve, no máximo uma vez por fornecedor ÚNICO (não por título), os
// nomes de todos os codigo_cliente_fornecedor presentes em `porDiaMap` —
// preenche `titulo.fornecedor_nome` in-place. Sequencial (não Promise.all)
// de propósito, pro mesmo motivo de MAX_PAGINAS/paginação acima: evitar
// estourar a cota de chamadas/segundo da API do Omie de uma vez só.
async function resolverNomesFornecedores(appKey, appSecret, porDiaMap) {
  const codigosUnicos = new Set();
  porDiaMap.forEach((dia) => dia.titulos.forEach((t) => {
    if (t.codigo_cliente_fornecedor) codigosUnicos.add(t.codigo_cliente_fornecedor);
  }));

  const codigos = Array.from(codigosUnicos);
  const nomesPorCodigo = new Map();
  let truncadoFornecedores = false;
  for (let i = 0; i < codigos.length; i++) {
    if (i >= MAX_FORNECEDORES_RESOLVIDOS) { truncadoFornecedores = true; break; }
    const nome = await resolverNomeFornecedor(appKey, appSecret, codigos[i]);
    if (nome) nomesPorCodigo.set(codigos[i], nome);
  }

  porDiaMap.forEach((dia) => dia.titulos.forEach((t) => {
    t.fornecedor_nome = t.codigo_cliente_fornecedor ? (nomesPorCodigo.get(t.codigo_cliente_fornecedor) || null) : null;
  }));

  return truncadoFornecedores;
}

/**
 * Busca e agrega, por dia de vencimento, os títulos em aberto (não pagos)
 * entre agora e HORIZONTE_DIAS à frente.
 * @param {'ricapet'|'thapets'} conta
 */
async function coletarContasPagar(conta) {
  const { appKey, appSecret } = getOmieConfig(conta);

  const agora = new Date();
  const passado = new Date(agora.getTime() - JANELA_PASSADO_DIAS * 24 * 60 * 60 * 1000);
  const futuro = new Date(agora.getTime() + HORIZONTE_DIAS * 24 * 60 * 60 * 1000);
  // Chaves AAAA-MM-DD comparáveis como string (ordem lexicográfica = ordem
  // cronológica) pro filtro real de data_vencimento, já que o filtro da
  // própria Omie não é confiável pra isso (ver nota no topo do arquivo).
  // dataFusoLoja (não fmtDataOmie/getDate) É OBRIGATÓRIO aqui: o servidor
  // (Vercel) roda em UTC, então perto da virada do dia em Brasília (21h-
  // 23h59 já é madrugada em UTC) um `new Date().getDate()` cru devolve o
  // dia SEGUINTE ao calendário real do Brasil — hojeChave ficava 1 dia à
  // frente e títulos vencendo hoje de verdade eram descartados
  // (diaStr < hojeChave). Bug real reportado em produção: valores de
  // 21/09 sumidos da Projeção Financeira.
  const hojeChave = dataFusoLoja(agora);
  const futuroChave = dataFusoLoja(futuro);

  const porDiaMap = new Map(); // 'AAAA-MM-DD' -> { total, qtd, titulos }
  let totalAPagar = 0;
  let totalTitulos = 0;
  let truncado = false;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const resp = await fetch('https://app.omie.com/api/v1/financas/contapagar/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call: 'ListarContasPagar',
        app_key: appKey,
        app_secret: appSecret,
        param: [{
          pagina,
          registros_por_pagina: REGISTROS_POR_PAGINA,
          apenas_importado_api: 'N',
          filtrar_por_data_de: fmtDataOmie(passado),
          filtrar_por_data_ate: fmtDataOmie(futuro),
        }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Erro Omie (${conta}): ${JSON.stringify(data)}`);
    }

    const titulos = data.conta_pagar_cadastro || [];
    for (const t of titulos) {
      if (t.status_titulo === 'PAGO') continue;
      if (!t.data_vencimento) continue;
      const diaStr = dataOmieParaChave(t.data_vencimento);
      if (diaStr < hojeChave || diaStr > futuroChave) continue;
      const atual = porDiaMap.get(diaStr) || { total: 0, qtd: 0, titulos: [] };
      atual.total += t.valor_documento || 0;
      atual.qtd += 1;
      // Guarda o título individual (não só o total) pra tela poder detalhar
      // "quais contas compõem esse valor" ao clicar no dia. A API de Contas
      // a Pagar não devolve nome de fornecedor, só o código
      // (codigo_cliente_fornecedor) — fornecedor_nome é preenchido depois,
      // in-place, por resolverNomesFornecedores() (1 chamada extra por
      // fornecedor ÚNICO, não por título).
      atual.titulos.push({
        valor: Math.round((t.valor_documento || 0) * 100) / 100,
        numero_documento: t.numero_documento || null,
        observacao: t.observacao || null,
        status: t.status_titulo || null,
        codigo_lancamento: t.codigo_lancamento_omie || null,
        codigo_cliente_fornecedor: t.codigo_cliente_fornecedor || null,
      });
      porDiaMap.set(diaStr, atual);
      totalAPagar += t.valor_documento || 0;
      totalTitulos += 1;
    }

    const totalPaginas = data.total_de_paginas || 0;
    if (pagina >= totalPaginas || titulos.length === 0) break;
    if (pagina === MAX_PAGINAS) truncado = true;
  }

  const truncadoFornecedores = await resolverNomesFornecedores(appKey, appSecret, porDiaMap);

  const porDia = Array.from(porDiaMap.entries())
    .map(([data, v]) => ({ data, total: Math.round(v.total * 100) / 100, qtd: v.qtd, titulos: v.titulos }))
    .sort((a, b) => (a.data < b.data ? -1 : 1));

  return {
    atualizado_em: new Date().toISOString(),
    horizonte_dias: HORIZONTE_DIAS,
    total_a_pagar: Math.round(totalAPagar * 100) / 100,
    total_titulos: totalTitulos,
    por_dia: porDia,
    truncado,
    truncado_fornecedores: truncadoFornecedores,
    erro: null,
  };
}

/**
 * Debug: varre a MESMA paginação/janela de coletarContasPagar, mas sem
 * filtrar por status (inclui PAGO) nem agregar — devolve todo título cujo
 * data_vencimento bate com `diaAlvo` ('AAAA-MM-DD'). Usado só por
 * /api/debug?tipo=omie-contas-pagar-dia pra comparar direto com o que a
 * Omie mostra como "Vence hoje" na Movimentação da Conta Corrente e achar
 * títulos que somem da Projeção Financeira sem explicação óbvia (ex.: um
 * título fica de fora do total mas não aparece aqui = nunca chegou nesta
 * paginação, problema de janela/volume; aparece aqui mas com status_titulo
 * inesperado = problema no filtro de status).
 * @param {'ricapet'|'thapets'} conta
 * @param {string} diaAlvo 'AAAA-MM-DD'
 */
async function listarTitulosPorDia(conta, diaAlvo) {
  const { appKey, appSecret } = getOmieConfig(conta);

  const agora = new Date();
  const passado = new Date(agora.getTime() - JANELA_PASSADO_DIAS * 24 * 60 * 60 * 1000);
  const futuro = new Date(agora.getTime() + HORIZONTE_DIAS * 24 * 60 * 60 * 1000);

  const encontrados = [];
  let paginasVarridas = 0;
  let truncado = false;

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const resp = await fetch('https://app.omie.com/api/v1/financas/contapagar/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        call: 'ListarContasPagar',
        app_key: appKey,
        app_secret: appSecret,
        param: [{
          pagina,
          registros_por_pagina: REGISTROS_POR_PAGINA,
          apenas_importado_api: 'N',
          filtrar_por_data_de: fmtDataOmie(passado),
          filtrar_por_data_ate: fmtDataOmie(futuro),
        }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(`Erro Omie (${conta}): ${JSON.stringify(data)}`);
    }
    paginasVarridas = pagina;

    const titulos = data.conta_pagar_cadastro || [];
    for (const t of titulos) {
      if (!t.data_vencimento) continue;
      if (dataOmieParaChave(t.data_vencimento) !== diaAlvo) continue;
      encontrados.push({
        codigo_lancamento_omie: t.codigo_lancamento_omie || null,
        codigo_cliente_fornecedor: t.codigo_cliente_fornecedor || null,
        valor_documento: t.valor_documento != null ? t.valor_documento : null,
        status_titulo: t.status_titulo || null,
        numero_documento: t.numero_documento || null,
        data_vencimento: t.data_vencimento || null,
        observacao: t.observacao || null,
      });
    }

    const totalPaginas = data.total_de_paginas || 0;
    if (pagina >= totalPaginas || titulos.length === 0) break;
    if (pagina === MAX_PAGINAS) truncado = true;
  }

  return { dia: diaAlvo, paginas_varridas: paginasVarridas, truncado, encontrados };
}

module.exports = { coletarContasPagar, listarTitulosPorDia, getOmieConfig, CONTAS, HORIZONTE_DIAS };
