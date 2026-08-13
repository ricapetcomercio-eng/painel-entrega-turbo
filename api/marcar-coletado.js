// api/marcar-coletado.js
// Chamada pelo checkout_bipagem.py (sistema local, C:\RobotOmie) assim que
// uma etiqueta é bipada de verdade no galpão — marca o pedido como
// "coletado" no painel imediatamente, sem esperar o próximo ciclo de
// verificação contra a API do ML/Shopee (a bipagem é uma confirmação
// interna do galpão, que pode acontecer bem antes da transportadora
// registrar a coleta do lado dela).
//
// Uso (POST, JSON body):
//   { "secret": "SEU_CRON_SECRET", "tipo": "ml", "identificador": "47536039614" }
//   { "secret": "SEU_CRON_SECRET", "tipo": "shopee", "identificador": "260716SAEW323D" }
//
// "identificador" é o shipment_id (ML) ou order_sn (Shopee) — ambos já
// aparecem direto no texto da etiqueta ("Envio:XXXXX" / "Pedido: XXXXX"),
// então o checkout_bipagem.py não precisa saber nada além do que já lê.

const { getDb } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const body = req.body || {};
  if (!cronSecret || body.secret !== cronSecret) {
    res.status(401).json({ error: 'Não autorizado' });
    return;
  }

  const tipo = body.tipo;
  const identificador = body.identificador ? String(body.identificador).trim() : '';
  if (!identificador || (tipo !== 'ml' && tipo !== 'shopee')) {
    res.status(400).json({ error: 'Use {tipo: "ml"|"shopee", identificador: "..."}' });
    return;
  }

  try {
    const db = getDb();
    const agora = new Date().toISOString();

    let rs;
    if (tipo === 'ml') {
      rs = await db.execute({
        sql: `UPDATE historico_flex SET categoria = 'coletado', coletado_em = ?
              WHERE shipment_id = ? AND categoria = 'aguardando'`,
        args: [agora, identificador],
      });
    } else {
      rs = await db.execute({
        sql: `UPDATE historico_turbo_live SET categoria = 'coletado', resolvido_em = ?
              WHERE order_id = ? AND categoria = 'aguardando'`,
        args: [agora, identificador],
      });
    }

    const atualizou = (rs.rowsAffected || 0) > 0;
    res.status(200).json({ ok: true, tipo, identificador, atualizou });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
