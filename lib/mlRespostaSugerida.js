// lib/mlRespostaSugerida.js
// Tenta gerar uma resposta pronta pra perguntas simples e recorrentes
// (medidas, cor, material) usando os atributos já cadastrados no próprio
// anúncio (attributes/variations vindos de GET /items) — só sugere quando
// encontra um valor legível de verdade; senão devolve null e a pergunta
// segue pro fluxo normal (aviso sem sugestão, resposta manual).
//
// Não posta nada sozinho — só monta o texto. A publicação de verdade é
// feita por api/responder-pergunta-ml.js, depois de aprovação humana (ver
// checkout_bipagem.py, fluxo "SIM <question_id>" no WhatsApp).

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(RE_DIACRITICOS, '');
}

const RE_MEDIDAS  = /medid|tamanho|dimens|largura|altura|comprimento|profund|quanto pesa|quantos? *cm|quantos? *kg/;
const RE_COR      = /\bcor(es)?\b|colorid/;
const RE_MATERIAL = /material|composicao|tecido|feito de|\be de que\b/;

function classificar(textoPergunta) {
  const t = normalizar(textoPergunta);
  if (RE_MEDIDAS.test(t))  return 'medidas';
  if (RE_COR.test(t))      return 'cor';
  if (RE_MATERIAL.test(t)) return 'material';
  return null;
}

function acharAtributo(attrs, id) {
  const attr = (attrs || []).find((a) => a.id === id && a.value_name);
  return attr ? attr.value_name : null;
}

function sugerirMedidas(item) {
  const attrs = item.attributes || [];
  const comprimento = acharAtributo(attrs, 'PACKAGE_LENGTH');
  const largura     = acharAtributo(attrs, 'PACKAGE_WIDTH');
  const altura       = acharAtributo(attrs, 'PACKAGE_HEIGHT');
  const peso         = acharAtributo(attrs, 'PACKAGE_WEIGHT');

  const partes = [];
  if (comprimento) partes.push(`comprimento de ${comprimento}`);
  if (largura)      partes.push(`largura de ${largura}`);
  if (altura)        partes.push(`altura de ${altura}`);
  if (!partes.length) return null;

  let texto = `A embalagem tem ${partes.join(', ')}`;
  if (peso) texto += `, pesando ${peso}`;
  texto += '.';
  return texto;
}

function sugerirCor(item) {
  const cores = new Set();
  for (const v of item.variations || []) {
    for (const attr of v.attribute_combinations || []) {
      if (attr.id === 'COLOR' && attr.value_name) cores.add(attr.value_name);
    }
  }
  if (!cores.size) {
    const cor = acharAtributo(item.attributes, 'COLOR');
    if (cor) cores.add(cor);
  }
  if (!cores.size) return null;
  const listaCores = [...cores];
  return listaCores.length === 1
    ? `Esse produto está disponível na cor ${listaCores[0]}.`
    : `Esse produto está disponível nas cores: ${listaCores.join(', ')}.`;
}

function sugerirMaterial(item) {
  const material = acharAtributo(item.attributes, 'MATERIAL');
  if (!material) return null;
  return `O material desse produto é ${material}.`;
}

/**
 * @param {string} textoPergunta
 * @param {object} item - resultado de GET /items (com attributes e variations incluídos)
 * @returns {{categoria: string, texto: string} | null}
 */
function gerarRespostaSugerida(textoPergunta, item) {
  const categoria = classificar(textoPergunta);
  if (!categoria || !item) return null;

  let texto = null;
  if (categoria === 'medidas')  texto = sugerirMedidas(item);
  if (categoria === 'cor')      texto = sugerirCor(item);
  if (categoria === 'material') texto = sugerirMaterial(item);

  return texto ? { categoria, texto } : null;
}

module.exports = { gerarRespostaSugerida, classificar };
