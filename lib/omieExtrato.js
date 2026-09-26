// lib/omieExtrato.js
// Traz pro Fluxo de Caixa (Contas a Pagar) duas transferências específicas
// entre contas que hoje NÃO aparecem em Contas a Pagar — ListarContasPagar
// (lib/omieContasPagar.js) só cobre títulos formais, essas transferências
// são lançamentos de extrato/movimento financeiro de verdade, API bem
// diferente (Movimentação da Conta Corrente do Omie, ListarExtrato em
// financas/extrato/). Confirmado com dado real de produção via
// /api/debug?tipo=omie-extrato-test:
//   - Ricapet: "Transf. ITAÚ CORRENTE >> CARTÃO DE CRÉDITO - ITAÚ"
//   - Thapets: "Transf. BRADESCO C/C >> American Express"
// Decisão explícita do dono do projeto: contam em TODO dia em que
// aparecerem no extrato — sem o corte de vencimento/"só fim de semana
// dobra pra hoje" usado pros títulos de Contas a Pagar (ver
// atrasoEhSoDeFimDeSemana em omieContasPagar.js) — é dinheiro que já saiu
// de verdade da conta, a data do lançamento é real, não uma previsão. E são
// só essas duas transferências específicas, não qualquer "Saída de
// Transferência" que apareça no extrato.

// nCodCC das contas de ORIGEM (achados via ?tipo=omie-extrato-test&parte=
// contas → ListarContasCorrentes) — hardcoded de propósito, são só essas
// duas contas bancárias específicas, não algo genérico pra generalizar.
const TRANSFERENCIAS_ESPECIFICAS = {
  ricapet: { nCodCC: 11018034290, rotulo: 'Transf. ITAÚ CORRENTE >> CARTÃO DE CRÉDITO - ITAÚ' },
  thapets: { nCodCC: 5764723981, rotulo: 'Transf. BRADESCO C/C >> American Express' },
};

// Categoria "Saída de Transferência" na Omie — confirmado com dado real
// (cCodCategoria "0.01.02", cOrigem "Débito de Transferência").
const CATEGORIA_SAIDA_TRANSFERENCIA = '0.01.02';

// Janela pequena de propósito: transferência é lançamento de extrato REAL
// (não uma previsão futura como título a pagar), então só interessa o
// passado bem recente — a tela (projecao-financeira.html, gerarDatas()) só
// mostra "hoje" em diante mesmo, dias mais antigos que isso nunca aparecem
// na tabela de qualquer forma.
const DIAS_JANELA_PASSADO = 10;

// Não importa lib/omieContasPagar.js aqui de propósito (evita dependência
// circular — omieContasPagar.js importa este arquivo). Duplica o mesmo
// getOmieConfig pequeno, mesmo padrão já usado entre debug.js/
// omieContasPagar.js neste repo.
function getOmieConfig(conta) {
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

function dataOmieParaChave(dataOmie) {
  const [dd, mm, aaaa] = dataOmie.split('/');
  return `${aaaa}-${mm}-${dd}`;
}

// A Omie devolve cDesCliente com ">>" HTML-escapado ("&gt;&gt;") mesmo
// dentro da resposta JSON — confirmado com dado real via omie-extrato-test.
function decodificarEntidadesHtml(s) {
  return String(s || '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/**
 * Busca só as transferências específicas configuradas acima, dentro da
 * janela recente.
 * @param {'ricapet'|'thapets'} conta
 * @returns {Promise<Array<{data: string, valor: number, descricao: string|null, situacao: string|null, codigo_lancamento: number|null, rotulo: string}>>}
 */
async function coletarTransferenciasEspecificas(conta) {
  const config = TRANSFERENCIAS_ESPECIFICAS[conta];
  if (!config) return [];
  const { appKey, appSecret } = getOmieConfig(conta);

  const hoje = new Date();
  const passado = new Date(hoje.getTime() - DIAS_JANELA_PASSADO * 24 * 60 * 60 * 1000);

  const resp = await fetch('https://app.omie.com/api/v1/financas/extrato/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      call: 'ListarExtrato',
      app_key: appKey,
      app_secret: appSecret,
      param: [{
        nCodCC: config.nCodCC,
        dPeriodoInicial: fmtDataOmie(passado),
        dPeriodoFinal: fmtDataOmie(hoje),
      }],
    }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Erro Omie extrato (${conta}): ${JSON.stringify(data)}`);
  }

  const movimentos = data.listaMovimentos || [];
  const encontrados = [];
  for (const m of movimentos) {
    if (m.cCodCategoria !== CATEGORIA_SAIDA_TRANSFERENCIA) continue;
    if (decodificarEntidadesHtml(m.cDesCliente) !== config.rotulo) continue;
    if (!m.dDataLancamento || typeof m.nValorDocumento !== 'number') continue;
    encontrados.push({
      data: dataOmieParaChave(m.dDataLancamento),
      valor: Math.abs(m.nValorDocumento),
      descricao: m.cObservacoes || null,
      situacao: m.cSituacao || null,
      codigo_lancamento: m.nCodLancamento || null,
      rotulo: config.rotulo,
    });
  }
  return encontrados;
}

module.exports = { coletarTransferenciasEspecificas };
