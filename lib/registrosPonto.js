// lib/registrosPonto.js
// Helpers de fuso horário e resolução de marcações de ponto, extraídos de
// api/debug.js pra poder ser reaproveitados por outras rotas (ex.: o
// dashboard de bipagem em api/analytics-todos-data.js) sem duplicar a
// lógica nem "importar" api/debug.js inteiro (isso inflaria o bundle da
// função que só precisa de umas poucas dezenas de linhas daqui).

// O servidor roda em UTC; a loja opera no fuso de São Paulo (UTC-3 fixo desde
// o fim do horário de verão em 2019). Estas duas funções convertem entre um
// "AAAA-MM-DD / HH:MM de São Paulo" e o ISO em UTC que vai pro banco.
function dataFusoLoja(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(d));
}

function isoDeDiaHoraLoja(diaAAAAMMDD, horaHHMM) {
  const [h, m] = String(horaHHMM || '').split(':').map((x) => parseInt(x, 10));
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) {
    throw new Error('Hora inválida (use HH:MM).');
  }
  const d = new Date(`${diaAAAAMMDD}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-03:00`);
  if (isNaN(d)) throw new Error('Data/hora inválida.');
  return d.toISOString();
}

// Reduz as linhas cruas (batida + ajustes) às marcações vigentes.
// Cada marcação carrega o `nsr` da linha que a originou -- é por ele que as
// correções seguintes referenciam (ref_nsr).
function resolverMarcacoes(rows) {
  const ordenadas = [...rows].sort((a, b) => (Number(a.nsr) || 0) - (Number(b.nsr) || 0));
  const efetivas = new Map();
  for (const r of ordenadas) {
    const origem = r.origem || 'batida';
    if (origem === 'batida' || origem === 'ajuste_inclusao') {
      efetivas.set(Number(r.nsr), {
        nsr: Number(r.nsr), tipo: r.tipo, registrado_em: r.registrado_em,
        metodo_validacao: r.metodo_validacao, editado: origem !== 'batida', origem,
        motivo: origem === 'batida' ? null : (r.motivo || null),
        editado_por: origem === 'batida' ? null : (r.editado_por || null),
        editado_em: origem === 'batida' ? null : (r.editado_em || null),
      });
    } else if (origem === 'ajuste_alteracao') {
      const alvo = efetivas.get(Number(r.ref_nsr));
      if (alvo) {
        alvo.tipo = r.tipo; alvo.registrado_em = r.registrado_em; alvo.editado = true;
        alvo.motivo = r.motivo || null; alvo.editado_por = r.editado_por || null; alvo.editado_em = r.editado_em || null;
      }
    } else if (origem === 'ajuste_exclusao') {
      efetivas.delete(Number(r.ref_nsr));
    }
  }
  return [...efetivas.values()].sort((a, b) => new Date(a.registrado_em) - new Date(b.registrado_em));
}

module.exports = { dataFusoLoja, isoDeDiaHoraLoja, resolverMarcacoes };
