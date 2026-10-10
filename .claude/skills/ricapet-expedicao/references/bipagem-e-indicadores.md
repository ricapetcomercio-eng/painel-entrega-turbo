# Bipagem, indicadores e responsabilidades

## Bipagem: o único registro físico da expedição

Fora do repo, no PC do galpão (`C:\RobotOmie`), o `checkout_bipagem.py`
lê a etiqueta e faz duas coisas:

1. **Na hora** — `POST /api/marcar-coletado` com
   `{secret, tipo: "ml"|"shopee", identificador}`:
   - `ml`: identificador = `shipment_id`. Marca `coletado` em
     `historico_flex` (se estava `aguardando`) **e** em `historico_todos`
     (marketplace `mercado_livre`) — por isso o pedido sai do "ML geral"
     da TV imediatamente (5ª rodada).
   - `shopee`: identificador = `order_sn`. Marca `coletado` em
     `historico_turbo_live` e `historico_todos`.
   - Sem custo de API de marketplace.
2. **1x por dia (23:30)** — o relatório do dia vai para
   `POST /api/debug?tipo=registrar-bipagem-diaria` → tabela
   `bipagem_diaria` (uma linha por pedido bipado: empresa, data, hora,
   `n_id_pedido`, `tipo_envio`, `bipado_por`, `marcado_manualmente`…).

`n_id_pedido` é o código **interno da Omie**, não o número do pedido do
marketplace. Para cruzar com `historico_todos` é preciso resolver
(`lib/bipagemResolver.js`): Omie `ConsultarPedido` → `SHP` já dá o
order_id; `MLV` dá o shipment_id → `GET /shipments/{id}` → order_id. É
**sob demanda** (botão "Resolver pendentes", até 50 por clique) porque
custa até 2 chamadas por linha. Linhas que falham ficam com
`resolver_erro` e não são re-tentadas sozinhas.

## Telas de bipagem

- **`bipagem-v2.html`** (link "Expedição" da barra lateral):
  - *Performance*: Total bipado, Ricapet, Thapets, Operadores ativos,
    Bipagens/hora, Devoluções+reclamações ÷ localizados; ranking por
    operador; produtividade por hora; marketplaces; **Cobertura da
    expedição** = bipado ÷ total de pedidos do período (sem Full, sem
    cancelados); "Precisão" = 100 − (devolvidos + reclamados) ÷
    localizados.
  - *Reclamações*: devoluções localizadas, reclamações (mediação ML), taxa
    de devolução, pendentes de tradução.
- **`bipagem.html`** (versão anterior, ainda no ar): KPIs, ranking,
  tipo de envio, volume por hora, tendência diária, devoluções por
  operador, tabela de devoluções/reclamações, CSV.

Dados vêm de `api/analytics-todos-data.js?visao=bipagem` (sessão + página
`bipagem`).

## Indicadores existentes (e de onde saem)

| Indicador | Cálculo | Onde |
|---|---|---|
| Atraso 7 dias | nº de pedidos coletados/entregues depois do prazo nos últimos 7 dias (também guarda a soma em ms, não exibida) | `lib/atrasoSemanal.js`, gravado na coleta (30 min) |
| `atrasado` por pedido (`historico_todos`) | entregue depois do prazo, ou agora > prazo sem entrega | `lib/mlAllOrders.js` / reverificação |
| Bipagens/hora | total bipado ÷ horas trabalhadas (cruza `bipado_por` com `funcionarios.nome` e `registros_ponto`) | `analytics-todos-data.js` |
| Taxa de devolução | devolvidos ÷ localizados × 100 | idem |
| Cobertura | bipado ÷ pedidos do período | `bipagem-v2.html` |
| Eficiência de coleta (Flex) | (entregues + coletados) ÷ total | `index.html` aba Flex |
| Tempo médio até coleta/entrega (Flex) | média de `horas_ate_coleta` / `horas_ate_entrega` | idem |

**Não existem**: % entregue no prazo, tempo médio por operador, tempo de
separação/embalagem. Criar qualquer um deles é regra nova → confirmar
definição com o dono (o que conta como "no prazo"? qual prazo? qual
período?) antes de implementar.

`bipado_por` × `funcionarios.nome` é comparação **exata** (sem tratar
acento/maiúscula): nome escrito diferente no script e no cadastro faz o
operador ficar sem horas trabalhadas.

## Usuários e responsabilidades

| Quem | O que faz no sistema |
|---|---|
| Operador da expedição | bipa etiquetas no PC do galpão; aparece em `bipado_por`. Não precisa de login para isso. |
| Admin com página `bipagem` | vê as telas de bipagem, clica "Resolver pendentes" |
| Admin com página `dashboard` | painel operacional (`index.html`) |
| Página `tv` | só esconde/mostra o link; a TV em si é kiosk sem login |
| Super admin (só o Ricardo) | tudo, incluindo o relatório escondido da TV e a tela Acessos; decide regras de negócio |

Controle de acesso: `funcionarios.admin` + `funcionarios_paginas`
(default-deny) — ver "Controle de acesso por página" no `CLAUDE.md`. Não
existem papéis por função (separador, conferente, expedidor).

`api/pendencias-ml.js` também é chamado pelo `checkout_bipagem.py` (~15
min): lista perguntas/mensagens do ML e publica resposta **só depois de
aprovação humana** pelo WhatsApp ("SIM <id>"). Nunca automatize essa
publicação.
