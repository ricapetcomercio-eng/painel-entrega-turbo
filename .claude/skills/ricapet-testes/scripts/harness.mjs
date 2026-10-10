// Harness de teste dos painéis Ricapet com Playwright.
//
// Sobe um servidor estático de public/, abre a página num Chromium real,
// injeta uma sessão FALSA de admin (sessionStorage) e responde as chamadas
// /api/* com dados FALSOS de um arquivo de mocks — nenhuma chamada chega à
// produção, ao Turso nem a marketplace. Recursos externos (fontes, Chart.js
// de CDN) passam pelo proxy do ambiente quando possível.
//
// Uso como biblioteca (testes de interação):
//   import { abrirPagina } from './harness.mjs';
//   const t = await abrirPagina({ pagina: 'fechamento.html', mocks: 'fixtures/fechamento.json' });
//   await t.page.click('text=Atualizar');
//   ... asserts ...
//   await t.fechar();            // imprime erros de console/rede e API sem mock
//
// Uso pela linha de comando (fumaça + prints em 3 larguras): ver testar_pagina.mjs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, '../../../..');
const PUBLIC = path.join(RAIZ, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/json' };

function servidorEstatico() {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const arq = path.join(PUBLIC, path.normalize(p));
    if (!arq.startsWith(PUBLIC) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arq)] || 'application/octet-stream' });
    fs.createReadStream(arq).pipe(res);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

// Token no mesmo formato que auth.js lê (base64url(JSON) + "." + assinatura).
// A assinatura é falsa: só o navegador lê o token aqui; nenhuma rota real
// recebe esse token, porque /api/* é sempre respondido pelos mocks.
export function sessaoFalsa({ nome = 'Teste', superAdmin = true, paginas = [] } = {}) {
  const miolo = Buffer.from(JSON.stringify({ id: 1, nome, emissao: Date.now() })).toString('base64url');
  return { token: `${miolo}.assinatura-falsa`, nome, super_admin: superAdmin, paginas };
}

// Datas relativas nos mocks, para o teste não "envelhecer":
//   "@agora"  "@agora-30m"  "@agora+2h"  "@agora-1d"  -> ISO
//   "@ms(@agora+2h)"                                    -> número em ms
let AGORA_BASE = null; // definido por abrirPagina({agora}) para teste determinístico
function resolverDatas(valor) {
  if (typeof valor === 'string') {
    const m = valor.match(/^@(ms\()?@?agora(?:([+-])(\d+)([mhd]))?\)?$/);
    if (!m) return valor;
    const mult = { m: 60e3, h: 3600e3, d: 86400e3 };
    const t = (AGORA_BASE ?? Date.now()) + (m[2] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) * mult[m[4]] : 0);
    return m[1] ? t : new Date(t).toISOString();
  }
  if (Array.isArray(valor)) return valor.map(resolverDatas);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, resolverDatas(v)]));
  return valor;
}

function carregarMocks(mocks) {
  if (!mocks) return [];
  if (Array.isArray(mocks)) return resolverDatas(mocks);
  const arq = path.isAbsolute(mocks) ? mocks : path.resolve(process.cwd(), mocks);
  const fallback = path.join(AQUI, '..', mocks);
  const usar = fs.existsSync(arq) ? arq : fallback;
  return resolverDatas(JSON.parse(fs.readFileSync(usar, 'utf-8')).rotas || []);
}

/**
 * @param {object} o
 * @param {string} o.pagina        arquivo em public/ (ex.: 'tv.html?token=x')
 * @param {string|Array} o.mocks   caminho do JSON de mocks ({rotas:[{url, metodo?, status?, body?, atrasoMs?}]}) ou array
 * @param {object|false} o.sessao  opções de sessaoFalsa, ou false para abrir sem sessão
 * @param {{width:number,height:number}} o.viewport
 * @param {boolean} o.bloquearExternos  true = aborta fontes/CDN (teste offline)
 * @param {string} o.agora  congela o relógio do navegador (ex.: '2026-10-07T14:00:00-03:00');
 *                          os "@agora" dos mocks passam a ser relativos a ele
 */
export async function abrirPagina({ pagina, mocks, sessao = {}, viewport = { width: 1366, height: 768 },
  bloquearExternos = false, aguardarMs = 800, agora = null } = {}) {
  AGORA_BASE = agora ? new Date(agora).getTime() : null;
  const srv = await servidorEstatico();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch({
    ...(proxy && !bloquearExternos ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {}),
  });
  const context = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  const relatorio = { consoleErros: [], paginaErros: [], redeFalhas: [], apiSemMock: [], apiChamadas: [] };

  if (agora) await context.clock.install({ time: new Date(agora) });

  if (sessao !== false) {
    const s = sessaoFalsa(sessao);
    await context.addInitScript((v) => { try { sessionStorage.setItem('ricapet_sessao', v); } catch (e) {} }, JSON.stringify(s));
  }

  const rotas = carregarMocks(mocks);
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    // Arquivo local: servido direto do disco (o proxy do ambiente não
    // aceita HTTP puro, então nada local passa por ele).
    if (url.startsWith(base) && !url.includes('/api/')) {
      let p = decodeURIComponent(new URL(url).pathname);
      if (p === '/') p = '/index.html';
      const arq = path.join(PUBLIC, path.normalize(p));
      if (!arq.startsWith(PUBLIC) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) return route.fulfill({ status: 404, body: '404' });
      return route.fulfill({ status: 200, contentType: TIPOS[path.extname(arq)] || 'application/octet-stream', body: fs.readFileSync(arq) });
    }
    if (url.includes('/api/')) {
      const metodo = req.method();
      relatorio.apiChamadas.push(`${metodo} ${url.replace(base, '')}`);
      const r = rotas.find((x) => url.includes(x.url) && (!x.metodo || x.metodo === metodo));
      if (!r) {
        relatorio.apiSemMock.push(`${metodo} ${url.replace(base, '')}`);
        return route.fulfill({ status: 599, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'API sem mock no teste' }) });
      }
      if (r.atrasoMs) await new Promise((ok) => setTimeout(ok, r.atrasoMs));
      if (r.abortar) return route.abort('failed');
      return route.fulfill({ status: r.status || 200, contentType: 'application/json',
        body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? { ok: true }) });
    }
    if (bloquearExternos) return route.abort('blockedbyclient');
    // Externo (fontes, Chart.js de CDN): o Chromium daqui não confia no
    // certificado do proxy do ambiente, então baixamos com curl (que usa o
    // CA bundle do proxy, com verificação TLS normal) e guardamos em cache.
    const baixado = baixarExterno(url);
    if (!baixado) return route.abort('failed');
    return route.fulfill({ status: 200, contentType: baixado.tipo, body: baixado.corpo });
  });

  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') relatorio.consoleErros.push(m.text()); });
  page.on('pageerror', (e) => relatorio.paginaErros.push(String(e.message || e)));
  page.on('requestfailed', (r) => {
    const f = r.failure();
    if (!bloquearExternos || r.url().startsWith(base)) relatorio.redeFalhas.push(`${r.url()} — ${f && f.errorText}`);
  });

  await page.goto(`${base}/${pagina.replace(/^\//, '')}`, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  if (aguardarMs) await page.waitForTimeout(aguardarMs);

  async function fechar({ silencioso = false } = {}) {
    await browser.close();
    srv.close();
    if (!silencioso) imprimirRelatorio(relatorio);
    return relatorio;
  }
  return { page, context, browser, base, relatorio, fechar };
}

const CACHE = path.join(os.tmpdir(), 'ricapet-testes-cache');
function baixarExterno(url) {
  try {
    fs.mkdirSync(CACHE, { recursive: true });
    const h = crypto.createHash('sha1').update(url).digest('hex');
    const arq = path.join(CACHE, h), tipoArq = arq + '.tipo';
    if (!fs.existsSync(arq)) {
      const ca = fs.existsSync('/root/.ccr/ca-bundle.crt') ? ['--cacert', '/root/.ccr/ca-bundle.crt'] : [];
      const tipo = execFileSync('curl', ['-sSL', '--max-time', '20', ...ca,
        '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
        '-o', arq, '-w', '%{content_type}', url], { encoding: 'utf-8' });
      fs.writeFileSync(tipoArq, tipo || 'application/octet-stream');
    }
    return { corpo: fs.readFileSync(arq), tipo: fs.readFileSync(tipoArq, 'utf-8') };
  } catch { return null; }
}

export function imprimirRelatorio(r) {
  const bloco = (titulo, itens) => {
    console.log(`${titulo}: ${itens.length ? '' : 'nenhum'}`);
    [...new Set(itens)].slice(0, 15).forEach((i) => console.log(`  - ${i.slice(0, 200)}`));
  };
  bloco('Erros de JavaScript na página', r.paginaErros);
  bloco('Erros no console', r.consoleErros);
  bloco('Falhas de rede', r.redeFalhas);
  bloco('Chamadas /api SEM mock (responderam 599)', r.apiSemMock);
}
