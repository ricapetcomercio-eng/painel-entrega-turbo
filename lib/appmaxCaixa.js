// lib/appmaxCaixa.js
// Soma, por dia, o valor líquido (merchant_total) dos pedidos pagos via
// Appmax (Loja Ricapet) -- alimenta a linha "Site" do Fluxo de Caixa. O
// dado já chega pronto em api/debug.js (?tipo=appmax-webhook, evento de
// pedido da própria Appmax gravado em appmax_pedidos assim que acontece),
// então essa leitura é uma soma simples já no Turso -- CPU quase zero,
// pode rodar direto em api/dashboard-data.js a cada carregamento da tela,
// sem precisar do botão "Atualizar agora" (diferente de Mercado Pago/
// Shopee/Omie, que chamam API externa sob demanda).
//
// `merchant_total` vem em centavos (padrão Appmax); convertido pra reais
// aqui, mesma unidade que o resto do Fluxo de Caixa usa (ver
// lib/mpProjecao.js).
async function somarAppmaxPorDia(db, deIso, ateIso) {
  try {
    const rs = await db.execute({
      sql: `SELECT substr(paid_at, 1, 10) AS dia, SUM(merchant_total) AS total_centavos
            FROM appmax_pedidos
            WHERE paid_at IS NOT NULL AND substr(paid_at, 1, 10) BETWEEN ? AND ?
            GROUP BY dia`,
      args: [deIso, ateIso],
    });
    return {
      por_dia: rs.rows.map((r) => ({ data: r.dia, total: Math.round(r.total_centavos || 0) / 100 })),
    };
  } catch (e) {
    // Tabela ainda não migrada (nenhum webhook recebido ainda) -- trata
    // como "sem dado automático nesse período", a tela cai pro manual
    // normalmente em vez de quebrar.
    return { por_dia: [] };
  }
}

module.exports = { somarAppmaxPorDia };
