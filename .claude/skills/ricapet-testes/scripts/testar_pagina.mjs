#!/usr/bin/env node
// Teste de fumaça de uma página: abre com sessão e dados falsos em 3
// larguras (celular, notebook, TV), salva prints e lista erros.
//
// Uso (na raiz do repo):
//   node .claude/skills/ricapet-testes/scripts/testar_pagina.mjs <pagina.html> [opções]
//
// Opções:
//   --mocks <arquivo.json>    mocks de /api (padrão: fixtures/<pagina>.json, se existir)
//   --saida <pasta>           onde salvar os prints (padrão: ./saida-testes)
//   --larguras 390,1366,1920  larguras a testar
//   --sem-sessao              abre sem login (deve cair no login / acesso negado)
//   --paginas a,b             páginas liberadas (e super_admin=false)
//   --offline                 bloqueia fontes/CDN (simula internet ruim)
//   --agora <data ISO>        congela o relógio (ex.: 2026-10-07T14:00:00-03:00)
//
// Sai com código 1 se houver erro de JavaScript ou /api sem mock.
import fs from 'node:fs';
import path from 'node:path';
import { abrirPagina, RAIZ } from './harness.mjs';

const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith('--')) {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 18).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(2);
}
const pagina = args[0];
const opt = (nome, padrao) => { const i = args.indexOf(`--${nome}`); return i >= 0 ? args[i + 1] : padrao; };
const flag = (nome) => args.includes(`--${nome}`);

const nomeBase = pagina.split('?')[0].replace(/\.html$/, '');
const fixturePadrao = path.join(RAIZ, '.claude/skills/ricapet-testes/fixtures', `${nomeBase}.json`);
const mocks = opt('mocks', fs.existsSync(fixturePadrao) ? fixturePadrao : undefined);
const saida = path.resolve(opt('saida', 'saida-testes'));
const larguras = opt('larguras', '390,1366,1920').split(',').map(Number);
const alturas = { 390: 844, 1366: 768, 1920: 1080 };
const paginasLib = opt('paginas');
const sessao = flag('sem-sessao') ? false
  : paginasLib ? { superAdmin: false, paginas: paginasLib.split(',') } : {};

fs.mkdirSync(saida, { recursive: true });
console.log(`Página: ${pagina}  |  mocks: ${mocks ? path.relative(RAIZ, mocks) : 'nenhum'}  |  sessão: ${sessao === false ? 'sem' : 'falsa'}`);
let falhou = false;
for (const w of larguras) {
  const t = await abrirPagina({ pagina, mocks, sessao, viewport: { width: w, height: alturas[w] || 900 }, bloquearExternos: flag('offline'), agora: opt('agora') });
  const larguraDoc = await t.page.evaluate(() => document.documentElement.scrollWidth);
  const titulo = await t.page.title();
  const arq = path.join(saida, `${nomeBase}-${w}.png`);
  await t.page.screenshot({ path: arq, fullPage: true });
  console.log(`\n== ${w}px  ·  título: "${titulo}"  ·  url final: ${t.page.url().replace(t.base, '')}`);
  console.log(`Rolagem horizontal: ${larguraDoc > w ? `SIM (${larguraDoc}px > ${w}px)` : 'não'}`);
  console.log(`Print: ${arq}`);
  const r = await t.fechar();
  if (r.paginaErros.length || r.apiSemMock.length) falhou = true;
  if (larguraDoc > w + 1) falhou = true;
}
console.log(falhou ? '\nRESULTADO: há problemas acima — investigue antes de declarar pronto.'
  : '\nRESULTADO: sem erro de JavaScript, sem /api sem mock, sem rolagem horizontal. (Isso é só a fumaça: ainda teste o comportamento pedido.)');
process.exit(falhou ? 1 : 0);
