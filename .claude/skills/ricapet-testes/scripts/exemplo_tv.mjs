#!/usr/bin/env node
// EXEMPLO de teste de comportamento (modelo para copiar): Painel TV com
// dados inventados e relógio congelado. Confere dados, ordem, filtro,
// busca, KPI e estado de erro — não só "abriu sem erro".
// Uso: node .claude/skills/ricapet-testes/scripts/exemplo_tv.mjs
import assert from 'node:assert/strict';
import { abrirPagina } from './harness.mjs';

const AGORA = '2026-10-07T14:00:00-03:00'; // quarta, 14h em Brasília
const resultados = [];
async function caso(nome, fn) {
  try { await fn(); resultados.push(`ok    ${nome}`); }
  catch (e) { resultados.push(`FALHOU ${nome}: ${e.message.split('\n')[0]}`); }
}

// 1) Dados + ordem + KPIs
let t = await abrirPagina({ pagina: 'tv.html', mocks: 'fixtures/tv.json', agora: AGORA, viewport: { width: 1920, height: 1080 } });
const p = t.page;
await caso('primeiro card é o atrasado', async () => {
  const primeiro = await p.locator('.card-pedido').first().innerText();
  assert.match(primeiro, /ATRASADO/);
});
await caso('Turbo/Agora vêm logo depois dos atrasados', async () => {
  const textos = await p.locator('.card-pedido').allInnerTexts();
  const iAgora = textos.findIndex((x) => /AGORA/.test(x));
  const iFlex = textos.findIndex((x) => /TESTE-ML-FLEX/.test(x));
  assert.ok(iAgora > 0 && iAgora < iFlex, `AGORA em ${iAgora}, FLEX em ${iFlex}`);
});
await caso('KPI Atrasados = 1', async () => {
  assert.equal((await p.locator('#kpiAtrasados').innerText()).trim(), '1');
});
await caso('filtro "Atrasados" deixa só o atrasado', async () => {
  await p.getByRole('button', { name: 'Atrasados', exact: true }).click();
  const textos = await p.locator('.card-pedido').allInnerTexts();
  const pendentes = textos.filter((x) => /Aguardando coleta/.test(x));
  assert.equal(pendentes.length, 1);
  assert.match(pendentes[0], /TESTE-ML-ATRASADO/);
  await p.getByRole('button', { name: 'Todos', exact: true }).click();
});
await caso('busca por SKU encontra o pedido', async () => {
  await p.getByPlaceholder(/Buscar/).fill('SKU-TESTE-06');
  const textos = (await p.locator('.card-pedido').allInnerTexts()).filter((x) => /Aguardando/.test(x));
  assert.equal(textos.length, 1);
  assert.match(textos[0], /TESTE-SHP-GERAL/);
});
let r = await t.fechar({ silencioso: true });
await caso('sem erro de JavaScript', async () => assert.deepEqual(r.paginaErros, []));

// 2) Estado de erro: API fora do ar -> a tela avisa e não quebra
t = await abrirPagina({ pagina: 'tv.html', mocks: [{ url: '/api/dashboard-data', status: 500, body: { error: 'falha simulada' } }], agora: AGORA });
await caso('API com erro não derruba a página', async () => assert.deepEqual(t.relatorio.paginaErros, []));
await caso('erro aparece para quem olha a TV', async () => {
  const corpo = await t.page.locator('body').innerText();
  assert.match(corpo, /erro|falha|sem conex/i);
});
await t.fechar({ silencioso: true });

console.log(resultados.join('\n'));
process.exit(resultados.some((x) => x.startsWith('FALHOU')) ? 1 : 0);
