# Inconsistências conhecidas (out/2026)

Achadas ao criar esta skill comparando código e `CLAUDE.md`. **Nenhuma foi
corrigida aqui** — cada uma precisa de decisão ou de tarefa própria. Ao
mexer perto de uma delas, cite-a no PR; se corrigir, remova daqui.

## Podem afetar dado ou tela

1. **Backfill do "Todos ML" pode descancelar pedido.**
   `api/backfill-todos-api.js` monta o pedido com `montarPedidoGenerico`,
   que não preenche `cancelado` nem `status_pedido`; `registrarHistoricoTodos`
   grava `cancelado = 0` e o `ON CONFLICT` sobrescreve. Um pedido cancelado
   que passe pelo backfill pode voltar a aparecer no "ML geral" até a
   próxima reverificação. O `CLAUDE.md` recomenda esse backfill em várias
   rodadas sem citar o risco.
2. **AGORA pode aparecer duas vezes.** `listarMlAguardando` exclui só
   `%full%` e `%flex%`; "Agência (cross docking)" (Envios Agora) não é
   excluída, então um Agora pendente pode ter card AGORA **e** card ML
   geral. Não verificado com dado real.
3. **Full na Shopee usa comparação exata** (`forma_entrega = 'full'`) e no
   ML usa `LIKE '%full%'`. Se a Shopee gravar outro texto para Full, ele
   entraria no "Shopee geral".
4. **"Coletados hoje" na TV** usa `toDateString()` do navegador, sem fuso
   explícito (as outras contas de "hoje" usam America/Sao_Paulo). Na TV do
   galpão (fuso do Brasil) não diverge; em outro fuso, sim.
5. **Suspeita (não confirmada): fila de reconferência do ML geral pode
   travar nos mais antigos.** `reverificarPendentesMlTodos` tem 4 s por
   ciclo e lê `listarMlAguardando` em `date_created_ts ASC`. Se houver
   muitos pedidos antigos legitimamente pendentes (ex.: `printed`), eles
   podem consumir o orçamento todo ciclo e os novos demorarem a ser
   reconferidos. Confirmar com `aguardando-resumo` antes de mexer.

## Documentação × código

6. **Intervalo de busca da TV:** `CLAUDE.md` diz 30 s no fluxo de dados e
   20 s na estrutura de arquivos; o código usa 20 s.
7. **Prazo sintético do ML geral:** `CLAUDE.md` diz 24h para Shopee e ML
   geral; o código usa 24h só para Shopee — ML geral usa as próximas 16:00
   de Brasília (`calcularProximoDespachoMl16h`).
8. Comentários antigos ainda falam em prazo sintético de **30 dias**
   (`tv.html`, `api/collect.js`).
9. Comentário do relatório da TV (`index.html`) fala em "não deduplicar",
   mas o código deduplica (correção de out/2026).
10. Tabela de throttles do `CLAUDE.md` não lista o atraso semanal (30 min)
   nem deixa claro que o Flex roda no gate geral de 5 min.
11. Prazo do Turbo Shopee: comentário diz "4h após aprovação do pagamento";
    o cálculo usa `create_time`.
12. `historico_flex.status_envio` é inserido NULL e nunca atualizado; o
    substatus do Flex não é gravado.
13. `corrigir-shipment-id` aceita GET, apesar do `CLAUDE.md` dizer POST.
