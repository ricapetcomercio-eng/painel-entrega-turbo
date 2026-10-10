# Regras de negócio dos painéis de expedição

Aqui fica **o que** cada painel mostra e **por quê**. Cores, fontes e
layout ficam na skill `ricapet-paineis` (`references/painel-tv.md`).

## Painel TV (`public/tv.html`)

TV na expedição, sem login (protegida só por `?token=` quando
`DASHBOARD_TOKEN` está configurado), sem interação além de filtros/botões.
Busca `/api/dashboard-data` a cada `INTERVALO_BUSCA_MS = 20000` (20 s);
relógio e contadores a cada 1 s. Erro 401 mantém os cards antigos e mostra
"confira o ?token=".

### O que entra

| Bloco | Origem | Prazo quando falta o real |
|---|---|---|
| FLEX / TURBO / AGORA (ML) | `pedidosFlex` (`historico_flex`) | criação + 21h |
| TURBO (Shopee) | `pedidos` (`historico_turbo_live`) | criação + 4h |
| 🛍️ SHOPEE geral | `entrega_turbo:ultima_coleta_shopee_todos` | **sintético: criação + 24h** |
| 📦 ML geral | `entrega_turbo:ultima_coleta_ml_todos` | **sintético: próximas 16:00 de Brasília** (`calcularProximoDespachoMl16h`) |

"Geral" = todo pedido ainda aguardando despacho que **não** tem card
próprio (Turbo/Flex já excluídos na consulta — não duplicar). Cada bloco
geral tem botão próprio (localStorage `tv_mostrar_shopee_todos` /
`tv_mostrar_ml_todos`, padrão: mostrar). `ML_TODOS_DESATIVADO` existe como
chave de emergência (hoje `false`); a orientação do dono é **não** desligar
o bloco como primeira resposta a um problema de status.

### Zonas (`zonaPorPrazo`)

| Zona | Quando |
|---|---|
| `preto` (atrasado) | prazo vencido |
| `vermelho` (coral) | faltam < 2h |
| `laranja` | faltam < 3h |
| `amarelo` | vence hoje (data de Brasília) |
| `verde` | depois |
| `concluido` | coletado/entregue/cancelado |

**Atrasado é o que mais se destaca, nunca apagado** (decisão do dono):
faixa "⚠ ATRASADO", borda grossa, fundo vermelho, contador maior, brilho
lento. Nenhuma outra zona pode usar esse mesmo destaque.

**Dia seguinte** (`diaSeguinte`): card com prazo real que não vence hoje
fica com opacidade 0,4. Nunca se aplica a atrasado nem a pedido sem prazo
real (`semPrazo`) — senão o "geral" ficaria invisível.

**Contagem regressiva sempre**, nunca "há Xh", inclusive para pedido sem
prazo real (usa o sintético). Acima de 24h vira `"Nd HH:MM:SS"`.

### Ordem dos cards (`renderizarCards`)

1. todo **atrasado** (qualquer tipo);
2. **TURBO e AGORA** no prazo;
3. todo o resto (Flex, Shopee geral, ML geral).

Dentro de cada grupo, menor tempo restante primeiro. Decisão explícita:
"sempre priorizar o turbo depois dos atrasados".

### KPIs (faixa do topo)

Aguardando (depois de filtros/busca) · Flex · Turbo (TURBO + AGORA) ·
Shopee geral · ML geral · Críticos (vermelho + preto) · Atrasados (vira
bloco vermelho cheio quando > 0) · Coletados hoje · Atraso total (7 dias) =
**quantidade** de pedidos atrasados (não horas) · heatmap vence em ≤15 /
15-30 / 30-60 min. Modo emergência quando Críticos > 5.

### Filtros e alertas

Filtros: todos, flex, turbo, urgentes (laranja+vermelho+preto), atrasados,
aguardando, busca por pedido/SKU/item.

Sons: pedido novo (voz "Novo pedido X"), entrou em vermelho, entrou em
atrasado, virou coletado/entregue. Selo "🚚 Hora de coletar" no Flex a
partir das 12:00 do dia do prazo.

## Painel operacional (`public/index.html`)

Abas: Executivo, Produtos, Desempenho, Todos os pedidos, **Flex**,
**Turbo / Expressa**. Período padrão: últimas 24h. Atualiza a cada 30 s
(`carregar`) e 60 s (`carregarAnalytics`), e **pausa com a aba escondida**
(economia de CPU, #278).

- **Aba Flex** (dados de `historico_todos`, `forma_entrega = Mercado Envios
  Flex`): Total, Entregues, Coletados não entregues, A coletar; "Eficiência
  de coleta" = (entregues + coletados) ÷ total; tempo médio até coleta e
  até entrega; tabela "Processo de expedição Flex agora" (Coletado /
  Aguardando coleta).
- **Aba Turbo**: totais e tabela do Turbo Shopee.
- **Relatório escondido da TV**: botão `btnExportarRelatorioTV`, só para
  super_admin. CSV dos pedidos pendentes, deduplicado por pedido+SKU.

## Princípio de custo

TV e painel **só leem** o que `/api/collect` já gravou. Qualquer novo
número na TV deve sair do que `dashboard-data` já entrega ou ser calculado
no navegador; se exigir dado novo, ele é calculado na coleta (dentro de um
throttle existente) e gravado pronto — nunca em `dashboard-data.js`.
