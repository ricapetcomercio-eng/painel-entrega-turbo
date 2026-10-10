#!/usr/bin/env node
// Chama uma rota de api/*.js LOCALMENTE, contra um banco SQLite de arquivo
// (nunca o Turso de produção), com CRON_SECRET de teste. Serve para testar
// mudança de backend com dado real de banco, sem deploy.
//
// Uso (na raiz do repo):
//   node .claude/skills/ricapet-testes/scripts/chamar_api.mjs <api/arquivo.js> [query] [corpoJSON] [--metodo POST] [--banco caminho.db]
//
// Exemplos:
//   ... chamar_api.mjs api/debug.js "tipo=criar-tabelas&secret=teste"
//   ... chamar_api.mjs api/marcar-coletado.js "" '{"secret":"teste","tipo":"ml","identificador":"123"}' --metodo POST
//
// - Banco padrão: <tmp>/ricapet-teste.db (some a cada reboot; apague para começar do zero).
// - Dependências (package.json) são instaladas FORA do repo, em <tmp>/ricapet-testes-deps,
//   para nunca criar node_modules/ dentro do projeto (não está no .gitignore).
// - Variáveis de ambiente de marketplace NÃO são definidas: rota que tentar
//   chamar Mercado Livre/Shopee/Omie falha — de propósito.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import Module, { createRequire } from 'node:module';
import { RAIZ } from './harness.mjs';

const args = process.argv.slice(2);
if (!args[0]) { console.log('Uso: chamar_api.mjs <api/arquivo.js> [query] [corpoJSON] [--metodo POST] [--banco arquivo.db]'); process.exit(2); }
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const posicionais = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const [arquivo, query = '', corpo] = posicionais;

const deps = path.join(os.tmpdir(), 'ricapet-testes-deps');
if (!fs.existsSync(path.join(deps, 'node_modules', '@libsql', 'client'))) {
  fs.mkdirSync(deps, { recursive: true });
  fs.copyFileSync(path.join(RAIZ, 'package.json'), path.join(deps, 'package.json'));
  console.error('Instalando dependências fora do repo (1ª vez)...');
  execSync('npm install --silent --no-audit --no-fund', { cwd: deps, stdio: 'inherit' });
}
process.env.NODE_PATH = path.join(deps, 'node_modules');
Module._initPaths();

const banco = path.resolve(opt('banco', path.join(os.tmpdir(), 'ricapet-teste.db')));
process.env.TURSO_DATABASE_URL = `file:${banco}`;
process.env.TURSO_AUTH_TOKEN = 'teste-local';
process.env.CRON_SECRET = process.env.CRON_SECRET_TESTE || 'teste';

const require = createRequire(import.meta.url);
const handler = require(path.resolve(RAIZ, arquivo));
const req = {
  method: opt('metodo', corpo ? 'POST' : 'GET'),
  query: Object.fromEntries(new URLSearchParams(query)),
  body: corpo ? JSON.parse(corpo) : undefined,
  headers: { 'content-type': 'application/json' },
};
let status = 200;
const res = {
  status(c) { status = c; return res; },
  setHeader() { return res; },
  json(o) { console.log(JSON.stringify({ status, resposta: o }, null, 2)); return res; },
  send(o) { console.log(JSON.stringify({ status, resposta: o }, null, 2)); return res; },
  end(o) { if (o) console.log(o); return res; },
};
await handler(req, res);
console.error(`(banco local: ${banco})`);
