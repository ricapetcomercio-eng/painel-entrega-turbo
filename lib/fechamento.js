// lib/fechamento.js
// Painel de Fechamento Mensal (public/fechamento.html). O fechamento é
// calculado FORA daqui, no computador do Ricardo (sistema em C:\FECHAMENTO,
// planilha Excel) — scripts/fechamento/enviar_fechamento.py lê a aba do mês
// e manda um JSON pronto pra /api/debug?tipo=fechamento-enviar (CRON_SECRET).
// Aqui só validamos/normalizamos esse JSON e guardamos no Turso (kv_simples):
//   entrega_turbo:fechamento:AAAA-MM   -> fechamento completo de 1 mês
//   entrega_turbo:fechamento_indice    -> [{ mes, aba, resumo... }] de todos
//                                         os meses (alimenta o seletor e a
//                                         evolução de 12 meses sem precisar
//                                         ler cada mês)
// A tela só LÊ isso (fechamento-dados) — CPU ~zero, nada de cron nem API
// externa (ver CLAUDE.md, Restrição de design nº 1).
//
// Normalização por lista de permissão: só os campos conhecidos passam, com
// tamanho limitado. OBS dos lançamentos nunca é aceita (às vezes tem CPF), e
// CPF/CNPJ é removido dos textos livres de novo aqui, mesmo o script local
// já fazendo isso — defesa em profundidade, os dados são sensíveis.

const { kvGet, kvSet } = require('./kv');

const PREFIXO_CHAVE = 'entrega_turbo:fechamento:';
const CHAVE_INDICE = 'entrega_turbo:fechamento_indice';
const RE_MES = /^\d{4}-(0[1-9]|1[0-2])$/;

const LIMITES = { canais: 20, categorias: 120, produtos: 200, variacoes: 200, lancamentos: 2000, investimentos: 200, metas: 20, conferencias: 50 };

function chaveMes(mes) { return PREFIXO_CHAVE + mes; }

function numero(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function semDocumento(s) {
  return String(s)
    .replace(/\b\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-.\s]?\d{2}\b/g, '')
    .replace(/\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}\b/g, '')
    .replace(/\d[\d.\-/\s]{9,}\d/g, (m) => (m.replace(/\D/g, '').length >= 11 ? '' : m))
    .replace(/\b(cpf|cnpj)\s*[:.-]?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function texto(v, max = 80) {
  if (v === null || v === undefined) return '';
  return semDocumento(v).slice(0, max);
}

function lista(v, max) {
  return Array.isArray(v) ? v.slice(0, max) : [];
}

const CAMPOS_PRODUTO = ['unidades', 'valor_unitario', 'valor_entrada', 'custo_unitario', 'custo_total', 'lucro_unitario', 'lucro_total', 'margem'];

function valoresProduto(o) {
  const out = {};
  if (!o || typeof o !== 'object') return null;
  CAMPOS_PRODUTO.forEach((k) => { out[k] = numero(o[k]); });
  return out;
}

function normalizarCanaisCategoria(v) {
  return lista(v, LIMITES.canais).map((c) => ({
    canal: texto(c && c.canal, 40),
    total: numero(c && c.total),
    categorias: lista(c && c.categorias, LIMITES.categorias)
      .map((x) => ({ categoria: texto(x && x.categoria, 80), valor: numero(x && x.valor) }))
      .filter((x) => x.categoria && x.valor !== null),
  })).filter((c) => c.canal);
}

// Valida e reconstrói o fechamento só com os campos conhecidos. Devolve
// { fechamento } ou { erro }.
function normalizarFechamento(bruto) {
  if (!bruto || typeof bruto !== 'object') return { erro: 'Corpo vazio. Envie { fechamento: {...} }.' };
  const mes = String(bruto.mes || '');
  if (!RE_MES.test(mes)) return { erro: 'Campo "mes" inválido (esperado AAAA-MM).' };
  const r = bruto.resumo || {};
  const resumo = {
    faturamento_bruto: numero(r.faturamento_bruto),
    lucro_bruto: numero(r.lucro_bruto),
    custos_mensais: numero(r.custos_mensais),
    lucro_liquido: numero(r.lucro_liquido),
    lucro_empresa: numero(r.lucro_empresa),
    retirada_socios: numero(r.retirada_socios),
    retirada_socios_texto: texto(r.retirada_socios_texto, 80),
    bonus: lista(r.bonus, 10).map((b) => ({ rotulo: texto(b && b.rotulo, 60), valor: numero(b && b.valor) })),
  };
  if (resumo.faturamento_bruto === null) return { erro: 'Resumo sem "faturamento_bruto" numérico — nada foi gravado.' };

  const fechamento = {
    versao_formato: numero(bruto.versao_formato) || 1,
    mes,
    aba: texto(bruto.aba, 40),
    arquivo: texto(bruto.arquivo, 120),
    gerado_em: texto(bruto.gerado_em, 40),
    // Quem enviou (hoje 'script-local', o PC do Ricardo). A rota não depende
    // disso: um servidor que rode o fechamento no futuro manda o mesmo JSON.
    origem: texto(bruto.origem, 40),
    recebido_em: new Date().toISOString(),
    resumo,
    metas: lista(bruto.metas, LIMITES.metas).map((m) => ({
      linha: texto(m && m.linha, 40),
      tipo: m && m.tipo === 'custo' ? 'custo' : 'resultado',
      valor: numero(m && m.valor),
      porcentagem: numero(m && m.porcentagem),
      meta: numero(m && m.meta),
      resultado_planilha: numero(m && m.resultado_planilha),
    })).filter((m) => m.linha),
    conferencias: lista(bruto.conferencias, LIMITES.conferencias).map((c) => ({
      celula: texto(c && c.celula, 10),
      status: c && c.status === 'erro' ? 'erro' : 'ok',
      rotulo: texto(c && c.rotulo, 80),
    })),
    faturamento_canais: normalizarCanaisCategoria(bruto.faturamento_canais),
    faturamento_total: numero(bruto.faturamento_total),
    lucro_canais: normalizarCanaisCategoria(bruto.lucro_canais),
    lucro_total: numero(bruto.lucro_total),
    produtos: lista(bruto.produtos, LIMITES.canais).map((c) => ({
      canal: texto(c && c.canal, 40),
      total: valoresProduto(c && c.total),
      produtos: lista(c && c.produtos, LIMITES.produtos).map((p) => ({
        nome: texto(p && p.nome, 80),
        tipo_variacao: texto(p && p.tipo_variacao, 20),
        total: valoresProduto(p && p.total),
        variacoes: lista(p && p.variacoes, LIMITES.variacoes).map((v) => ({
          nome: texto(v && v.nome, 60),
          subgrupo: v && v.subgrupo ? texto(v.subgrupo, 40) : null,
          ...valoresProduto(v),
        })),
      })).filter((p) => p.nome),
    })).filter((c) => c.canal),
    produtos_total_geral: valoresProduto(bruto.produtos_total_geral),
    lancamentos: lista(bruto.lancamentos, LIMITES.lancamentos).map((l) => ({
      data: texto(l && l.data, 20),
      valor: numero(l && l.valor),
      referencia: texto(l && l.referencia, 60),
      categoria: texto(l && l.categoria, 60),
      onde: texto(l && l.onde, 80),
      // l.obs é descartado de propósito (ver comentário no topo).
    })).filter((l) => l.valor !== null),
    investimentos: lista(bruto.investimentos, LIMITES.investimentos)
      .map((i) => ({ valor: numero(i && i.valor), descricao: texto(i && i.descricao, 100) }))
      .filter((i) => i.valor !== null),
    avisos: lista(bruto.avisos, 20).map((a) => texto(a, 160)),
  };
  return { fechamento };
}

function resumoParaIndice(f) {
  return {
    mes: f.mes,
    aba: f.aba,
    recebido_em: f.recebido_em,
    faturamento_bruto: f.resumo.faturamento_bruto,
    lucro_bruto: f.resumo.lucro_bruto,
    custos_mensais: f.resumo.custos_mensais,
    lucro_liquido: f.resumo.lucro_liquido,
    conferencia_erro: f.conferencias.some((c) => c.status === 'erro'),
  };
}

async function gravarFechamento(fechamento) {
  await kvSet(chaveMes(fechamento.mes), fechamento);
  const indice = (await kvGet(CHAVE_INDICE)) || [];
  const semEste = (Array.isArray(indice) ? indice : []).filter((x) => x && x.mes !== fechamento.mes);
  semEste.push(resumoParaIndice(fechamento));
  semEste.sort((a, b) => (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0));
  await kvSet(CHAVE_INDICE, semEste);
  return semEste;
}

function mesAnterior(mes, passos) {
  const [a, m] = mes.split('-').map(Number);
  const total = a * 12 + (m - 1) - passos;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// Leitura pra tela: o índice + o mês pedido (padrão: o mais recente) + o
// mês anterior e o mesmo mês do ano anterior, quando existirem. No máximo 4
// leituras simples de kv.
async function lerFechamentos(mesPedido) {
  const indice = (await kvGet(CHAVE_INDICE)) || [];
  if (!indice.length) return { indice: [], atual: null, anterior: null, ano_anterior: null };
  const mes = mesPedido && RE_MES.test(mesPedido) && indice.some((x) => x.mes === mesPedido)
    ? mesPedido
    : indice[indice.length - 1].mes;
  const existe = (m) => indice.some((x) => x.mes === m);
  const mAnt = mesAnterior(mes, 1);
  const mAno = mesAnterior(mes, 12);
  const [atual, anterior, anoAnterior] = await Promise.all([
    kvGet(chaveMes(mes)),
    existe(mAnt) ? kvGet(chaveMes(mAnt)) : null,
    existe(mAno) ? kvGet(chaveMes(mAno)) : null,
  ]);
  return { indice, atual, anterior, ano_anterior: anoAnterior };
}

module.exports = { normalizarFechamento, gravarFechamento, lerFechamentos, mesAnterior, semDocumento, CHAVE_INDICE, PREFIXO_CHAVE };
