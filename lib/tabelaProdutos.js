// lib/tabelaProdutos.js
// Tabela SKU -> PRODUTO/COR/TAMANHO/CUSTO, gerada a partir de
// C:\FECHAMENTO\03 AUXILIARES\TABELA_AUXILIAR.xlsx (aba TABELA_PRODUTOS)
// pelo script scripts/gerar_tabela_produtos.py. Ver README para como
// atualizar quando a planilha mudar.

const tabela = require('./tabelaProdutos.json');

const NAO_MAPEADO = { produto: 'Não mapeado', cor: '-', tamanho: '-', custo: null };

/**
 * Retorna { produto, cor, tamanho, custo } pro SKU informado, ou um bucket
 * "Não mapeado" se o SKU não existir na planilha (ou vier vazio) — usado
 * pra sinalizar na tela que a TABELA_AUXILIAR precisa ser atualizada.
 */
function buscarProdutoPorSku(sku) {
  if (!sku) return NAO_MAPEADO;
  return tabela[String(sku).trim()] || NAO_MAPEADO;
}

module.exports = { buscarProdutoPorSku, NAO_MAPEADO };
