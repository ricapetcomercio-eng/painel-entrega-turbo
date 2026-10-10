---
name: ricapet-expedicao
description: Conhecimento dos processos de expedição da Ricapet/Thapets neste repo — tipos de pedido (Flex, Turbo ML, Agora, Turbo Shopee, Shopee geral, ML geral, Full), status e como mudam, prazos, bipagem (marcar-coletado, bipagem_diaria), Painel TV (zonas, ordem, KPIs, alertas), painel operacional (abas Flex/Turbo), indicadores (cobertura, atraso, bipagens/hora, devolução), quem faz o quê e tratamento de exceções (cancelado depois de coletado, pedido sem shipment_id, zumbis, devolução/reclamação). Use SEMPRE que a tarefa tocar em pedido, prazo, status, coleta, bipagem, separação, conferência, despacho, "pedido sumiu da TV", "número não bate com o Mercado Livre/Shopee", atraso, cards da TV, KPIs de expedição, api/collect.js, api/marcar-coletado.js, lib/historico*.js, lib/mlFlexOrders.js, lib/shopeeOrders.js, public/tv.html, bipagem*.html ou aba Flex/Turbo do index.html — mesmo que a palavra "expedição" não apareça.
---

# Ricapet Expedição

Esta skill descreve **como a expedição funciona hoje no código**, para que
qualquer mudança preserve os fluxos existentes. Ela não cria regra nova.

## Antes de tudo: as 5 regras deste domínio

1. **Preserve o que existe.** Todo valor aqui (prazo, zona, filtro de
   "aguardando", ordem dos cards) foi decidido pelo dono do projeto
   (Ricardo), quase sempre depois de um incidente real em produção. O
   histórico está no `CLAUDE.md` ("rodadas" do ML geral, prazo sintético,
   atrasado destacado, ordem Turbo). Mudar um desses valores é mudar regra de
   negócio → **pergunte antes**, mesmo que pareça "só um ajuste".
2. **Não invente processo.** Separação, conferência de embalagem, "% no
   prazo" e tempo médio por operador **não existem** no sistema (ver
   "O que NÃO existe" abaixo). Se a tarefa pressupõe um deles, diga que não
   existe e pergunte como o Ricardo quer que funcione — não crie um status,
   tabela ou KPI por conta própria.
3. **Orçamento de CPU manda** (Restrição de design nº 1 do `CLAUDE.md`).
   Nada de diminuir intervalos de coleta (`INTERVALO_MINIMO_*`), aumentar
   chamadas de API por pedido, ou colocar lógica em `api/dashboard-data.js`
   (CPU ~zero por design). TV e painel só **leem** dado pronto.
4. **Rota que grava em produção não é chamada por agente.** Backfills,
   `corrigir-shipment-id`, `ml-recuperar-sem-shipment-id`, `reabrir-pedido`,
   migrações: só o Ricardo roda, com o `CRON_SECRET` (que nunca vai para o
   repo, PR ou chat). Você pode **sugerir** o comando; não execute. Rotas de
   leitura estão listadas em `references/excecoes-e-diagnostico.md`.
5. **Achou inconsistência? Sinalize, não "conserte de passagem".** Já há
   divergências conhecidas entre código e `CLAUDE.md`
   (`references/inconsistencias.md`). Ao achar uma nova, descreva com
   arquivo:linha e pergunte qual lado vale — e, se a correção estiver fora
   do escopo da tarefa, proponha como tarefa separada.

## Mapa do fluxo

```
Marketplace (ML/Shopee)
   │  cron-job.org → GET /api/collect (gate 5 min; Shopee 15; devoluções 30)
   ▼
Descoberta + reverificação pela API ──► Turso
   • historico_flex        (Flex, Turbo ML, Agora)
   • historico_turbo_live  (Turbo Shopee ao vivo) + historico_turbo (log)
   • historico_todos       (todos os pedidos; base do "Shopee/ML geral")
   │
   │  Galpão: etiqueta bipada → checkout_bipagem.py (PC local, fora do repo)
   │     → POST /api/marcar-coletado  ⇒ categoria = 'coletado' (na hora)
   │     → 23:30: registrar-bipagem-diaria ⇒ tabela bipagem_diaria
   ▼
/api/dashboard-data (só lê, CPU ~zero)
   ├─► public/tv.html          TV do galpão: cards com contagem regressiva
   ├─► public/index.html       painel operacional (abas Flex, Turbo/Expressa)
   └─► bipagem-v2.html / bipagem.html  (via analytics-todos-data?visao=bipagem)
```

Ciclo de vida de um pedido: **criado no marketplace → aparece como
`aguardando` (card na TV) → bipado no galpão ou confirmado pela API como
despachado → `coletado` → `entregue`** (ou `cancelado` / `nao_entregue` a
qualquer momento). O status só "anda para frente": as tabelas têm proteção
para nunca voltar de resolvido para `aguardando`.

## Onde está cada assunto

| Preciso de… | Leia |
|---|---|
| Tipos de pedido, como são identificados, prazo de cada um, status e o filtro exato de "aguardando" | `references/tipos-e-status.md` |
| Regras de negócio da TV (zonas, ordem, prazo sintético, dia seguinte, KPIs, sons, filtros) e do painel operacional | `references/paineis.md` (visual da TV: skill `ricapet-paineis`, `references/painel-tv.md`) |
| Bipagem, `bipagem_diaria`, indicadores (cobertura, bipagens/hora, precisão, devolução, atraso 7 dias) e quem faz o quê | `references/bipagem-e-indicadores.md` |
| Exceções conhecidas, como investigar "pedido sumiu / número não bate", rotas de leitura × escrita | `references/excecoes-e-diagnostico.md` |
| Divergências já conhecidas entre código e documentação | `references/inconsistencias.md` |

Para conferir se os números desta skill ainda batem com o código (prazos,
zonas, intervalos, listas de status), rode:

```bash
python3 .claude/skills/ricapet-expedicao/scripts/conferir_constantes.py
```

Ele só lê. Se apontar diferença, o código mudou depois da skill: confie no
código, avise e atualize a skill no mesmo PR.

## O que NÃO existe (e não deve ser inventado)

- **Separação e conferência** como etapas: não há status, tabela nem tela.
  O único evento físico registrado é a **bipagem** (que vira `coletado`). A
  própria `bipagem-v2.html` diz que "não existe uma etapa separada de
  'confirmar embalagem' hoje". O mais perto é o selo "🚚 Hora de coletar"
  da TV (Flex, a partir das 12:00 do dia do prazo).
- **"% entregue no prazo"** e **tempo médio por operador**: não calculados.
  Existe só a contagem de atrasados em 7 dias e o tempo médio até coleta/
  entrega da aba Flex (geral, não por operador).
- **Dicionário de motivos** de devolução/reclamação: a tela mostra o código
  cru da API.
- **Perfis por função** (separador, conferente, expedidor): o controle de
  acesso é por página (`PAGINAS_PAINEL`), e quem bipou é um texto livre
  (`bipado_por`) vindo do script local.

Se o pedido do usuário depende de algo desta lista, responda com o que
existe hoje e pergunte como ele quer que funcione antes de implementar.

## Como trabalhar numa tarefa de expedição

1. **Localize o tipo de pedido e a tabela** envolvidos (tabela de
   `tipos-e-status.md`). Muitos bugs vêm de olhar a tabela errada: a TV
   mistura `historico_flex`, `historico_turbo_live` e `historico_todos`.
2. **Ache a regra no código antes de opinar** — os números desta skill são
   um mapa, o código é a verdade. Rode `conferir_constantes.py`.
3. **Classifique a mudança:**
   - *Visual* (cor, tamanho, texto, layout) → siga `ricapet-paineis`; não
     mexa em zona, prazo, ordem nem filtro.
   - *Correção de bug* que faz o código obedecer a uma regra já
     documentada → pode fazer; cite a regra no PR.
   - *Mudança de regra* (prazo, zona, o que conta como aguardando/atrasado,
     ordem, o que entra num KPI, intervalo de coleta) → **pare e pergunte**
     com o modelo abaixo.
4. **Pense nos dois lados da tela:** um pedido some da TV por causa do
   *filtro de exibição* (ex.: teto de 15 dias, exclusão de Full/Flex) ou por
   *nunca ter sido gravado* (falha na descoberta). São correções diferentes.
5. **No PR:** diga qual tipo de pedido/tabela muda, se muda o que aparece na
   TV, se precisa de migração/backfill depois do deploy (e quem roda), e o
   impacto de CPU/API (deve ser zero ou menor).

## Modelo de pergunta ao dono do projeto

Use quando a tarefa exigir decidir uma regra. Linguagem simples, sem jargão
— o Ricardo não é programador.

> **Preciso da sua decisão antes de continuar.**
> **Hoje:** <o que o sistema faz, com o efeito na tela — ex.: "pedido ML
> geral sem prazo conta até as próximas 16h">.
> **O pedido pede:** <a mudança>.
> **Efeito:** <o que muda na TV/KPI/relatório e para quem>.
> **Opções:** (a) … (b) … — eu recomendaria (x) porque ….

## Lembretes rápidos

- Contas: ML Ricapet e Thapets são **separadas** (comparar com o painel
  nativo sempre da mesma conta e mesma aba — "hoje" × "qualquer dia").
- Hora: tudo que é "hoje" usa o fuso **America/Sao_Paulo**, nunca o relógio
  do servidor (Vercel roda em UTC).
- `shipment_id` é texto (`String(...)`): número cru vira `"123.0"` no
  SQLite e quebra a reverificação (3ª rodada do ML geral).
- Repo público: nada de nome de cliente, de funcionário, CPF ou valor real
  em código, teste, print ou PR.
