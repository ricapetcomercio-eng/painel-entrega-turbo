#!/usr/bin/env node
// Gera fixtures/fechamento.json a partir da planilha 100% INVENTADA de
// scripts/fechamento/exemplo (nunca da planilha real). Usa o código real
// (enviar_fechamento.py + lib/fechamento.js) com um kv em memória, então o
// formato do mock acompanha o que a rota fechamento-dados devolve de verdade.
// Uso: node .claude/skills/ricapet-testes/scripts/gerar_fixture_fechamento.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { RAIZ } from './harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fech-'));
const ex = path.join(RAIZ, 'scripts/fechamento/exemplo');
execFileSync('python3', ['gerar_exemplo.py'], { cwd: ex, stdio: 'ignore' });
const xlsx = fs.readdirSync(ex).find((f) => f.endsWith('.xlsx'));
const json = path.join(tmp, 'meses.json');
execFileSync('python3', [path.join(RAIZ, 'scripts/fechamento/enviar_fechamento.py'), '--arquivo', path.join(ex, xlsx),
  '--todos', '--simular', '--salvar-json', json], { stdio: 'ignore' });

// kv em memória no lugar do Turso
const mem = new Map();
const kvPath = path.join(RAIZ, 'lib/kv.js');
const req = createRequire(import.meta.url);
req.cache[req.resolve(kvPath)] = { id: kvPath, filename: kvPath, loaded: true,
  exports: { kvGet: async (k) => mem.get(k) ?? null, kvSet: async (k, v) => { mem.set(k, v); }, kvDel: async (k) => mem.delete(k) } };
const { normalizarFechamento, gravarFechamento, lerFechamentos } = req(path.join(RAIZ, 'lib/fechamento.js'));

let meses = JSON.parse(fs.readFileSync(json, 'utf-8'));
if (!Array.isArray(meses)) meses = meses.meses || [meses];
for (const m of meses) {
  const { fechamento, erro } = normalizarFechamento(m.fechamento || m);
  if (erro) throw new Error(erro);
  await gravarFechamento(fechamento);
}
const dados = await lerFechamentos();
const saida = path.join(RAIZ, '.claude/skills/ricapet-testes/fixtures/fechamento.json');
fs.writeFileSync(saida, JSON.stringify({
  descricao: 'Gerado de scripts/fechamento/exemplo (dados inventados). Não editar à mão: rode gerar_fixture_fechamento.mjs.',
  rotas: [{ url: 'tipo=fechamento-dados', body: { ok: true, tipo: 'fechamento-dados', ...dados } }],
}, null, 1));
console.log(`ok: ${meses.length} meses -> ${path.relative(RAIZ, saida)}`);
