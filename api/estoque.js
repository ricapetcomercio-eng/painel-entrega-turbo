// api/estoque.js
// Rotas do painel de Estoque (contagem física + registro na planilha),
// chamadas pelo navegador em public/estoque.html e estoque-atualizar.html.
// Antes viviam em painel-estoque-adesivo, direto do navegador pro JSONBin e
// pro Google Sheets com as credenciais em texto puro no JS público — aqui
// viram um proxy: o segredo fica só no servidor (env vars), e cada rota
// exige uma sessão de admin (mesmo login do resto do painel).
//
// Uso: /api/estoque?tipo=contagem-get|contagem-set|sheets-log&sessao=...

const { getDb } = require('../lib/db');
const { obterAdminSessao } = require('../lib/pontoAuth');

async function exigirAdmin(req, res) {
  const token = (req.body && req.body.sessao) || req.query.sessao;
  const resultado = await obterAdminSessao(token, getDb());
  if (resultado.erro) { res.status(resultado.status).json({ ok: false, error: resultado.erro }); return null; }
  return resultado.funcionario;
}

async function estoqueContagemGet(req, res) {
  if (!(await exigirAdmin(req, res))) return;
  const apiKey = process.env.JSONBIN_CONTAGEM_API_KEY;
  const binId = process.env.JSONBIN_CONTAGEM_BIN_ID;
  if (!apiKey || !binId) { res.status(200).json({ ok: true, record: null }); return; }
  try {
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, { headers: { 'X-Master-Key': apiKey } });
    if (!resp.ok) { res.status(200).json({ ok: true, record: null }); return; }
    const json = await resp.json();
    res.status(200).json({ ok: true, record: json.record || null });
  } catch (err) {
    res.status(200).json({ ok: true, record: null });
  }
}

async function estoqueContagemSet(req, res) {
  if (!(await exigirAdmin(req, res))) return;
  const apiKey = process.env.JSONBIN_CONTAGEM_API_KEY;
  const binId = process.env.JSONBIN_CONTAGEM_BIN_ID;
  if (!apiKey || !binId) { res.status(200).json({ ok: false, error: 'JSONBin não configurado no servidor.' }); return; }
  try {
    const resp = await fetch(`https://api.jsonbin.io/v3/b/${binId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': apiKey },
      body: JSON.stringify((req.body && req.body.record) || {}),
    });
    res.status(200).json({ ok: resp.ok });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}

async function estoqueSheetsLog(req, res) {
  if (!(await exigirAdmin(req, res))) return;
  const url = process.env.GOOGLE_SHEETS_CONTAGEM_WEBAPP_URL;
  if (!url) { res.status(200).json({ ok: false, error: 'Google Sheets não configurado no servidor.' }); return; }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      body: JSON.stringify({ rows: (req.body && req.body.rows) || [], data: new Date().toISOString() }),
    });
    let json = {};
    try { json = await resp.json(); } catch (e) { /* corpo vazio/inesperado */ }
    res.status(200).json({ ok: !!(resp.ok && json.ok) });
  } catch (err) {
    res.status(200).json({ ok: false, error: err.message });
  }
}

module.exports = async (req, res) => {
  try {
    if (req.query.tipo === 'contagem-get') return await estoqueContagemGet(req, res);
    if (req.query.tipo === 'contagem-set') return await estoqueContagemSet(req, res);
    if (req.query.tipo === 'sheets-log') return await estoqueSheetsLog(req, res);
    res.status(400).json({ error: 'Use ?tipo=contagem-get, contagem-set ou sheets-log' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
