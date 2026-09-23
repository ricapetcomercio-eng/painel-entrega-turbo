# painel-entrega-turbo — guia rápido para Claude Code

Painel que identifica pedidos com promessa de entrega expressa (ML: "entrega
em poucas horas" via lead_time; Shopee: modalidade Entrega Turbo, até 4h)
para Ricapet e Thapets, e exibe em tempo real numa TV no galpão de expedição.

Dono: Ricardo (`ricapetcomercio-eng`). Deploy: Vercel, projeto `ricapet1` (plano Hobby).

## Restrição de design nº 1: orçamento de CPU do plano Hobby

Isso guia praticamente toda decisão de arquitetura no repo — qualquer
mudança que aumente frequência de chamadas ou processamento pesado precisa
levar isso em conta:

- Limite: 4h de Fluid Active CPU por 30 dias (Vercel Hobby).
- Em set/2026 o projeto estava consumindo ~3h04m/4h (76,7%) — quase no limite.
  `painel-entrega-turbo` sozinho é ~99,7% de todo o uso da conta `ricapet1`.
- Causa: um scheduler externo (cron-job.org, ver abaixo) bate em `/api/collect`,
  e cada tipo de dado dentro dela roda em intervalos próprios (throttle
  interno) para não desperdiçar CPU. Medido em produção (log
  `[collect-timing]`, ver `medirTempo` em `api/collect.js`): Flex ~2s por
  execução, Todos ML ~1s — como o Flex roda muito mais vezes que os outros,
  ele é de longe o maior custo (frequência importa mais que custo por
  chamada aqui).
- Mitigações aplicadas:
  - cron-job.org restrito a **6h-18h, segunda a sábado** (72h/semana ativas
    em vez de 168h/semana) — redução estimada de ~57%.
  - Throttle do Flex alargado de 2 para **5 min** (`INTERVALO_MINIMO_MS` em
    `api/collect.js`) — é o bloco que mais pesa, então o que mais economiza,
    mas em troca a TV fica com até 5 min de atraso (era ~2 min). Trade-off
    aceito deliberadamente pelo dono do projeto.
- Se o consumo real (Vercel → Usage → Fluid Active CPU) continuar alto depois
  dessas duas mudanças, o próximo candidato é alargar "Todos os pedidos"
  (BI/Desempenho, hoje 5 min) — não é usado em tempo real, sobra folga ali.
- `/api/dashboard-data.js` (consumido pelo frontend) é, por design, CPU quase
  zero — só lê dado já pronto do banco. **NUNCA colocar lógica pesada ali.**

## Fluxo de dados

```
cron-job.org (externo, restrito a 6h-18h seg-sáb)
   │  GET /api/collect?secret=CRON_SECRET  (chamada a cada 1 min, mas o
   │  próprio endpoint só faz trabalho de verdade a cada 5 min - ver throttles)
   ▼
api/collect.js  ──► chama API do Mercado Livre + Shopee, processa em lotes
   │                 paralelos, grava resultado pronto no Turso (SQLite cloud)
   ▼
Turso (kv_simples + tabelas de histórico)
   ▲
   │  leitura simples (CPU ~zero)
api/dashboard-data.js
   ▲
   │  fetch a cada 30s (tv.html) / poll do index.html
public/tv.html (TV da expedição)  +  public/index.html (painel operacional)
```

Throttles internos em `api/collect.js` (constantes no topo do arquivo):

| Dado | Intervalo mínimo | Motivo |
|---|---|---|
| Pedidos Flex (ML, tempo real p/ TV) | 5 min (era 2 min) | é o que a TV mostra ao vivo, mas também o maior custo de CPU |
| "Todos os pedidos" ML (BI/dashboard) | 5 min | não precisa do ritmo do Flex |
| Shopee | 15 min | cota limitada do proxy Fixie (IP fixo) |
| Devoluções | 30 min | mudam devagar |

### Projeção Financeira: sob demanda, não automática (Mercado Pago + Shopee)

`lib/mpProjecao.js` e `lib/shopeeProjecao.js` alimentam a mesma tela
(`public/projecao-financeira.html`). Diferente de tudo mais nesta tabela,
essa coleta **NÃO roda no cron automático** — é cara demais (Shopee faz 1
chamada extra por pedido em aberto, ver custo abaixo) e o dado não precisa
estar sempre fresco. Em vez de throttle por tempo, é 100% sob demanda: o
botão "Atualizar agora" na tela chama `GET /api/collect?acao=projecao-
financeira-manual&sessao=...`, autenticado pela sessão de admin do login
único (não pelo `CRON_SECRET`) — ver `coletarProjecaoFinanceiraManual` no
topo de `api/collect.js`. Decisão explícita do dono do projeto pra manter o
custo de API o mais baixo possível.

Também importante não confundir os dois ao mexer nesse código:

- **Mercado Pago**: `money_release_date` é informado pela própria API
  (`/v1/payments/search`) — data real, confirmada com dado de produção.
- **Shopee**: a API **não** expõe nenhuma data de repasse pra pedidos ainda
  em aberto — confirmado empiricamente (`get_escrow_list` só devolve
  repasses já liberados; `get_escrow_detail` calcula o valor mas não tem
  nenhum campo de data). `lib/shopeeProjecao.js` portanto **estima** a data
  (pedidos `SHIPPED`/`TO_CONFIRM_RECEIVE`, usando o maior entre a previsão
  de entrega da Shopee — `edt_to` — e a última atualização de status, mais
  `DIAS_CONFIRMACAO_PADRAO` dias assumidos de prazo de confirmação do
  comprador). Por isso o retorno vem com `estimativa: true` e a tela mostra
  um aviso — **nunca remover esse aviso ou tratar o dado da Shopee aqui
  como se fosse tão confiável quanto o do Mercado Pago**.
- Custo: a estimativa da Shopee faz 1 chamada a `get_escrow_detail` por
  pedido em aberto encontrado (trava de segurança: no máximo 300 por
  loja/clique, `MAX_CONSULTAS_ESCROW`). Como só roda quando alguém clica no
  botão (não fica em loop nem em cron), o impacto na cota do proxy Fixie é
  bem menor que se fosse automático — mas se a cota apertar mesmo assim,
  este é um
  candidato claro pra revisar/reduzir primeiro.
- **"Atualizar agora" busca 1 peça por vez (`?fonte=mercado-pago|shopee|
  omie&conta=ricapet|thapets`), nunca as 6 numa chamada só.** Aconteceu de
  verdade em produção: a versão antiga (`coletarProjecaoFinanceiraManual`
  fazia MP×2 + Shopee×2 + Omie×2 sequencial numa função só) travava sem
  terminar — a Shopee Ricapet sozinha já bateu no teto de 300 chamadas
  (`truncado: true`), o que passa fácil do tempo de função da Vercel; o
  botão ficava "Atualizando…" e nunca voltava, sem erro visível nenhum.
  `coletarUmaPecaProjecaoFinanceira` (`api/collect.js`) faz merge (read-
  modify-write) no mesmo objeto salvo em `entrega_turbo:ultima_coleta_
  projecao_financeira`, então as 6 chamadas do frontend (`public/
  projecao-financeira.html`, loop `PECAS_PROJECAO`) podem terminar em
  qualquer ordem sem se sobrescrever. O caminho antigo (sem `?fonte=`, tudo
  numa chamada) continua existindo só por compatibilidade — a tela não usa
  mais.
- ✅ Thapets no Mercado Pago **voltou a funcionar** (confirmado em
  16/set/2026 via `/api/debug?tipo=mp-payments-test&conta=thapets`, dado
  real de produção: 82 pagamentos, 74 aprovados) — `coletarProjecaoFinanceiraManual`
  (`api/collect.js`) chegou a ter um placeholder fixo (`erro: "Conta
  Thapets ainda não autorizada..."`) por causa de uma restrição de escopo
  `payments` que existiu por um tempo sem causa conhecida; removido porque
  o teste ao vivo mostrou que a API já responde normalmente pra essa
  conta. Se voltar a falhar, reconferir primeiro com o mesmo endpoint de
  debug antes de reintroduzir qualquer placeholder — não assumir de novo
  que é bloqueio de escopo sem testar.

### `projecao-financeira.html` é na verdade um Fluxo de Caixa (planilha)

A tela evoluiu de "só entradas futuras" pra um fluxo de caixa dia a dia
inspirado numa planilha real do dono do projeto (dias nas colunas,
categorias nas linhas, saldo acumulado embaixo). Peças do modelo:

- **Entradas**: Shopee/Mercado Pago (ver seção acima) + **Site** (manual,
  nenhuma integração com o site próprio existe neste projeto — cada dia é
  um campo editável direto na tela).
- **Saldo bancário inicial**: campo manual (Ricapet + Thapets, um número
  cada, não por dia) — ponto de partida do saldo acumulado projetado.
  Guardado em `entrega_turbo:fluxo_caixa_saldo_manual`
  (kv). Editado via `/api/debug?tipo=fluxo-caixa-config-set`.
- **Saídas**: Contas a Pagar do Omie (`lib/omieContasPagar.js`), credenciais
  `OMIE_RICAPET_APP_KEY`/`_APP_SECRET` e `OMIE_THAPETS_APP_KEY`/`_APP_SECRET`
  (Omie trata as duas empresas como contas separadas). Soma, por dia de
  vencimento, todo título não-`PAGO` (`A VENCER`/`VENCIDO`) — sem
  discriminar por categoria (Aluguel/Fornecedores/FGTS etc., ainda não
  implementado). O filtro de data da própria API do Omie não é confiável
  pra isso (ver comentário no topo do arquivo), então a busca pagina um
  histórico bem mais largo e filtra `data_vencimento` no nosso lado.
  - **⚠️ "Hoje" tem que ser calculado no fuso de São Paulo, não no relógio
    do servidor**: o corte usado pra decidir se um título "já venceu"
    (`hojeChave` em `coletarContasPagar`) usa `dataFusoLoja` (mesmo helper
    já usado em `lib/registrosPonto.js`/Mercado Pago), nunca
    `new Date().getDate()` cru — o Vercel roda em UTC, então entre ~21h e
    23h59 em Brasília (já é madrugada em UTC) um cálculo ingênuo faz
    `hojeChave` ficar 1 dia à frente do calendário real do Brasil e
    descarta títulos que vencem HOJE de verdade. Bug real que já aconteceu
    em produção (títulos do dia sumindo da tela) — corrigido, mas é o tipo
    de erro fácil de reintroduzir se alguém trocar `dataFusoLoja` por
    `new Date()` direto num ajuste futuro nesse arquivo.
  - **✅ Só título vencido no fim de semana dobra pra "hoje" — set/2026**:
    causa raiz do "sumiço" confirmada com dado real (`omie-contas-pagar-
    dia`) — um título (INYLBRA, R$ 5.387,90) tinha `data_vencimento` de
    **domingo**, mas `status_titulo` já vinha da própria Omie como
    `"VENCE HOJE"` (status real da API, não só rótulo de UI). A Omie
    mostra atrasado-e-não-pago junto com "vence hoje" na Movimentação da
    Conta Corrente; nosso código agrupava estritamente por
    `data_vencimento`, então um título vencido no fim de semana caía num
    dia que já tinha passado do filtro (`diaStr < hojeChave`) e sumia da
    tela por completo. Não era só a INYLBRA: confirmado com o mesmo dado
    real que **todo título `"ATRASADO"` estava assim** (SABESP, CBC FLEX,
    COMPENSADOS, ENEL, ITAÚ, LEBIANCO, CAIXA/FGTS, RECEITA FEDERAL/INSS,
    todos faltando).
    - Primeira tentativa de fix dobrava QUALQUER título vencido no passado
      pra "hoje", sem olhar pra quantos dias fazia — **decisão explícita
      do dono do projeto reverteu isso**: só o vencimento que caiu em
      sábado/domingo (sem expediente bancário pra pagar) é absorvido pelo
      próximo dia útil; título vencido num dia útil de verdade (ex.: uma
      quarta-feira) e ainda não pago **volta a sumir da tela** — o
      controle desse tipo de atraso "de verdade" fica fora desta
      ferramenta, não empurrado indefinidamente pro "hoje".
    - `atrasoEhSoDeFimDeSemana(diaVencimento, diaHoje)`
      (`lib/omieContasPagar.js`): só retorna `true` se `diaVencimento` cai
      num sábado/domingo E não existe nenhum dia útil entre ele e
      `diaHoje` (ex.: sábado→domingo, sábado→segunda, domingo→segunda —
      mas NÃO sexta→segunda, mesmo passando pelo fim de semana no meio,
      porque sexta em si já era dia útil pra pagar). Testado com os casos
      reais do incidente.
    - `titulo.venceu_fim_de_semana` + `titulo.data_vencimento_original`
      marcam a origem só nesses casos; o popup de detalhe
      (`projecao-financeira.html`) mostra um badge neutro "FIM DE SEMANA"
      (não "ATRASADO" — não é um atraso de verdade, é só a ausência de
      expediente bancário) + "venceu DD/MM/AAAA".
    - Título com `status_titulo` "PAGO" continua excluído; título fora do
      horizonte futuro (`diaStr > futuroChave`) continua ignorado.
    - `status_titulo` da Omie tem pelo menos 4 valores reais confirmados
      (não só "PAGO"/"A VENCER" como o comentário original supunha):
      `"PAGO"`, `"A VENCER"`, `"VENCE HOJE"`, `"ATRASADO"` — o filtro
      nunca discriminou por esses três últimos além do critério de data
      acima, então não precisou de ajuste específico por status;
      documentando aqui só pra não assumir de novo que só existem dois
      valores.
    - `omie-contas-pagar-dia` (endpoint de debug, ver acima) continua útil
      pra investigações futuras — resolve nome do fornecedor e aceita
      `&janela=N` pra checar títulos com `data_vencimento` alguns dias
      antes/depois do dia pedido.
  - **Clique no valor abre um popup com o detalhe** ("Contas a pagar
    Ricapet/Thapets (Omie)" em `projecao-financeira.html`): cada dia
    guarda a lista de títulos que compõem o total (`por_dia[].titulos`),
    não só a soma — célula fica com `.clicavel` quando tem título (gate em
    `titulos.length > 0`, não em `qtd`, pra dado coletado num formato mais
    antigo — sem `titulos` — não virar clicável mostrando popup vazio), o
    clique lê de `omiePorDiaAtual` (montado a cada `carregar()`) e abre o
    modal `#modal-omie` com fornecedor/documento/valor de cada título.
  - **Nome do fornecedor**: a API de Contas a Pagar só devolve o código
    (`codigo_cliente_fornecedor`), não o nome — `resolverNomesFornecedores`
    (`lib/omieContasPagar.js`) resolve via API de Clientes/Fornecedores do
    Omie (`ConsultarCliente`, `geral/clientes/`), **1 chamada por
    fornecedor ÚNICO no período** (não por título — cacheado num `Map`
    dentro da própria coleta), trava de segurança
    `MAX_FORNECEDORES_RESOLVIDOS` (150). Testável isoladamente via
    `/api/debug?tipo=omie-cliente-test&conta=ricapet&codigo=...`. Falha
    silenciosa por fornecedor (não derruba a coleta): sem nome resolvido,
    a tela cai pro fallback `Fornecedor #<código>`. Ainda sob demanda (só
    no clique de "Atualizar agora"), mas é custo extra real por cima da
    paginação de títulos que já existia — se a cota do Omie apertar, esse
    é candidato a rever primeiro (ex.: cachear nomes já resolvidos entre
    coletas em vez de resolver tudo de novo a cada clique).
- **Saldo acumulado**: calculado no frontend (não vem pronto do backend) —
  `saldo do dia anterior + total de entradas do dia − total a pagar do
  dia`, começando do saldo bancário manual somado (Ricapet + Thapets).
- Duas novas rotas em `api/debug.js` (`fluxo-caixa-config-get`/`-set`),
  protegidas só pela sessão de admin (`exigirAdmin`), sem nenhum secret de
  app — mesmo padrão de "sessão pura" do `?acao=projecao-financeira-manual`
  em `api/collect.js` (ver `TIPOS_SESSAO_ADMIN`).
- `entrega_turbo:fluxo_caixa_site_manual` guarda o mapa `{ "AAAA-MM-DD":
  valor }` das vendas manuais do site.

## Bipagem (`public/bipagem.html`): n_id_pedido ≠ order_id, precisa resolver

`bipagem_diaria.n_id_pedido` (mandado pelo `checkout_bipagem.py`/RobotOmie)
**não é** o `order_id` nem o `shipment_id` de nenhum marketplace — é o
`codigo_pedido` **interno da Omie** (confirmado empiricamente, com dado
real de produção). Cruzar direto contra `historico_todos.order_id` (que é
o que "Bipado × Devolvido por operador" e "% devolução" precisam) sempre
dava zero batidas.

Cadeia de tradução confirmada (`lib/bipagemResolver.js`):
```
n_id_pedido (codigo_pedido da Omie)
  → Omie ConsultarPedido → cabecalho.origem_pedido:
      "SHP" (Shopee)        → informacoes_adicionais.numero_pedido_cliente
                               JÁ é o order_id — 1 chamada.
      "MLV" (Mercado Livre) → numero_pedido_cliente é, na verdade, o
                               shipment_id — precisa de mais 1 chamada
                               (GET /shipments/{id} na API do ML) pra
                               pegar o order_id de verdade — 2 chamadas.
  → resultado vai pra bipagem_diaria.order_id_resolvido
```
- Sob demanda (botão "Resolver pendentes" em `bipagem.html` → `?tipo=
  bipagem-resolver-pendentes` em `api/debug.js`, sessão pura via
  `TIPOS_SESSAO_ADMIN`, mesmo padrão do Fluxo de Caixa) — **nunca**
  automático: até 2 chamadas de API por linha é caro demais pra rodar em
  loop. Trava de segurança: no máximo `LIMITE_MAXIMO_RESOLVER_BIPAGEM`
  (50) linhas por clique.
- `responderVisaoBipagem` (`api/analytics-todos-data.js`) cruza contra
  `order_id_resolvido`, não mais `n_id_pedido` — pedidos ainda não
  resolvidos ficam de fora do cruzamento (contam em `nao_resolvidos` no
  retorno) até alguém clicar em "Resolver pendentes".
- Colunas `order_id_resolvido`/`marketplace_resolvido`/`resolvido_em`/
  `resolver_erro` em `bipagem_diaria` — migração idempotente já embutida em
  `?tipo=adicionar-coluna-tipo` (`api/debug.js`), não precisa de passo
  manual separado.
- **`resolver_erro`**: quando uma linha falha em resolver (pedido apagado
  na Omie, `numero_pedido_cliente` vazio, etc.), fica marcada aqui em vez
  de ficar só com `order_id_resolvido IS NULL` — sem isso o botão "Resolver
  todos os pendentes" reprocessava pra sempre o mesmo lote de 50 que falha
  por inteiro (ordenado por `bipado_em_ts DESC`, então é sempre o mesmo
  topo), o "restantes" nunca saía do lugar e parecia que o botão não fazia
  nada (aconteceu de verdade em produção — 1.741 pendentes praticamente
  parados após rodar o loop). A busca de pendentes (`bipagem-resolver-
  pendentes`) exclui `resolver_erro IS NOT NULL`; o resumo de erros
  agrupados (`resumo_erros` na resposta) aparece direto na tela de bipagem
  ao final do loop, sem precisar abrir o console do navegador. `nao_resolvidos`
  no dashboard continua contando essas linhas normalmente (ainda não
  entraram no cruzamento) — só param de ser retentadas automaticamente.

### Devoluções e reclamações na tela de Bipagem (set/2026)

`bipagem.html` tem uma tabela unificada no rodapé ("Devoluções e
reclamações localizadas no período") com filtro por Origem
(Devolução/Reclamação) e por Motivo — antes só existia devolução, sem
coluna de motivo nem filtro nenhum.

- **Devolução** = produto físico voltando (ML ou Shopee). **Reclamação** =
  claim do Mercado Livre de mediação/disputa que o cliente abriu mas que
  **nunca** envolveu devolução física — antes desse recurso, esses claims
  eram simplesmente descartados (nunca persistidos em lugar nenhum). Shopee
  não tem essa distinção nesta integração: `lib/shopeeReturns.js` só expõe
  devolução (não existe endpoint de "disputa sem devolução" sendo usado
  aqui), então reclamação hoje é exclusiva do Mercado Livre.
- **Zero custo extra de API**: `lib/mlClaims.js` já buscava todos os claims
  do período pra filtrar devolução (`claimEhDevolucao`, heurística baseada
  em `available_actions` tipo `return_review_*` — ver comentário no topo do
  arquivo, inferida empiricamente, não documentada pelo ML). Antes,
  qualquer claim que não batesse essa heurística era jogado fora;
  `buscarClaimsClassificadosPeriodo` (mesmo arquivo) reaproveita a MESMA
  busca (2 chamadas por conta: `opened` + `closed`) e só separa em dois
  mapas (`devolucoes`/`reclamacoes`) em vez de descartar um deles — não
  aumenta a frequência nem o número de chamadas do throttle de 30 min
  (`INTERVALO_MINIMO_DEVOLUCOES_MS`, `api/collect.js`).
- **Sem dicionário de motivo**: nem devolução nem reclamação têm hoje uma
  tradução de `reason_id`/`reason` pra texto legível — a coluna "Motivo"
  mostra o código cru que vem da API do marketplace (ML: código numérico
  tipo `reason_id`; Shopee: string tipo `reason`, só pra devolução). Se
  precisar de texto amigável no futuro, esse mapeamento ainda não existe em
  lugar nenhum do repo e precisaria ser construído (idealmente confirmado
  com dado real de produção antes, como o resto das heurísticas deste
  arquivo).
- **Persistência**: novas colunas em `historico_todos` — `reclamado`,
  `reclamacao_claim_id`, `reclamacao_status`, `reclamacao_motivo`,
  `reclamacao_tipo` (espelham as 4 colunas de devolução que já existiam).
  Migração **manual**, não roda sozinha: precisa de
  `POST /api/debug?tipo=adicionar-coluna-tipo&secret=CRON_SECRET` uma vez
  depois do deploy — sem isso `marcarReclamacao`/o cruzamento em
  `responderVisaoBipagem` falham (coluna inexistente).
- **Mutuamente exclusivas no mesmo pedido**: um claim é classificado como
  devolução OU reclamação a cada ciclo, nunca os dois. Se uma reclamação
  "gradua" pra devolução física depois (claim muda de estágio e passa a ter
  ação de devolução), `marcarDevolucao` (`lib/historicoTodos.js`) zera os
  4 campos de reclamação daquele pedido — evita ficar mostrando como
  "reclamação em aberto" um pedido que já virou devolução resolvida.
- `registrarHistoricoTodos` preserva os campos de reclamação entre
  re-sincronizações normais de pedido, do mesmo jeito que já fazia com
  devolução (o fluxo normal de coleta de pedidos não sabe nada sobre
  devolução/reclamação — só quem grava isso é `enriquecerDevolucoes`).

## Banco de dados

Turso (libSQL/SQLite cloud) é o banco principal — `lib/db.js` + `lib/kv.js`
(get/set/del genérico sobre a tabela `kv_simples`, imitando a API do Redis
antigo). Migração feita depois que o Redis (Upstash) compartilhado com
outros dois projetos (`concorrentes-ml`, `painelvendas-seven`) estourou a
cota de 500k req/mês.

`lib/redis.js` (Upstash) ainda existe só como referência legada, usado
apenas em `api/debug.js`. Não usar para código novo.

⚠️ O README na raiz ainda descreve o Redis como armazenamento principal —
está desatualizado nesse ponto; confie neste arquivo e em `lib/db.js`/`lib/kv.js`.

## Cargo do funcionário

Coluna `cargo` (texto livre, ex. "Auxiliar de Expedição") na tabela
`funcionarios` — usada só para exibição (Cartão de Ponto, ver abaixo) e
editável na tela Acessos (`public/acessos.html`, campo por linha). Sem
`cargo` preenchido, aparece "—" no cartão. Migra sozinha: faz parte de
`ALTERS_PONTO`/`garantirEsquemaPonto()` em `api/debug.js` — não precisa
rodar nada manualmente, a próxima chamada a qualquer rota de Ponto já
adiciona a coluna se ela não existir.

## Cartão de Ponto (impressão, aba "Por funcionário" do Ponto)

Botão "Cartão de Ponto" em `public/ponto.html` gera uma folha de impressão
no layout do cartão mensal usado pela empresa (cabeçalho, dados do
funcionário/cargo, horário semanal, tabela diária com 4 batidas + saldo
acumulado, legenda de origem da marcação, alterações administrativas e
linha de assinatura) — reaproveita a mesma chamada `ponto-admin-visao` já
usada pelas outras abas, só que com um `de` bem largo, para ter o
histórico completo de marcações do funcionário disponível no cliente
(cálculo de banco de horas acumulado é sempre client-side, feito sob
demanda só quando o botão é clicado — nunca em `dashboard-data.js` nem em
background).

BANCO SALDO (coluna de saldo acumulado de horas) é calculado do zero a
partir de `INICIO_HISTORICO_CARTAO = '2024-01-01'` (constante em
`ponto.html`), somando dia a dia até o fim do período impresso, usando a
MESMA fórmula de saldo diário já usada em `montarFolha()` (trabalhado vs.
previsto pela jornada, zerado dentro da tolerância de `tolerancia_min`,
zerado se negativo e abonado) — só que acumulando em vez de resetar a
cada filtro de período, e só exibindo as linhas a partir do início do
período impresso (dias antes disso entram só para compor o saldo inicial
arrastado). É uma fórmula própria, não uma tentativa de bater número por
número com nenhum sistema de ponto eletrônico de terceiros — o objetivo é
o layout do cartão ser fiel ao modelo, não os valores serem idênticos aos
de outro software (que costuma ter regras de arredondamento por marcação
não documentadas).

TOTAL NOTURNO fica sempre em branco por decisão do dono do produto — não
há cálculo de adicional noturno implementado.

## Controle de acesso por página (tela Acessos, só super_admin)

Além da flag `admin` (que sozinha sempre controlou 100% do acesso ao login
do painel — quem não tem `admin = 1` nem consegue entrar, só bate ponto),
existe agora uma camada mais fina: **quais páginas** cada admin pode ver
depois de logado.

- `funcionarios.super_admin` (0/1) — nível acima do admin comum, ignora
  todo o controle abaixo (acesso total sempre). Só o Ricardo tem essa
  flag, por decisão do dono do projeto. Setado via
  `POST /api/debug?tipo=ponto-definir-super-admin&secret=CRON_SECRET`
  (`{ "nomes": ["Ricardo"] }`), mesmo padrão do `ponto-definir-admins` já
  existente. **Nunca** é setável pela própria tela Acessos — só por esse
  endpoint com CRON_SECRET, pra a tela que concede acesso não virar um
  jeito de alguém se autopromover.
- `funcionarios_paginas` (Turso, `funcionario_id + pagina`) — presença de
  linha = acesso liberado àquela página. Sem linha nenhuma = sem acesso a
  nada. **Default-deny de propósito**: todo admin que já existia antes
  desta feature fica sem acesso a qualquer página até o Ricardo entrar em
  `/acessos.html` e marcar manualmente o que cada um pode ver — decisão
  explícita do dono do projeto, não um bug.
- Páginas controláveis (`PAGINAS_PAINEL` em `lib/pontoAuth.js`, mesmas
  chaves do `data-menu-key` da barra lateral): `ponto`, `dashboard`,
  `bipagem`, `estoque`, `projecao-financeira`, `concorrencia`, `tv`.
- `public/acessos.html`: tela nova, só super_admin, lista todo funcionário
  ativo com a flag admin + quais páginas tem liberadas, editável por
  linha. Backend `acessos-listar`/`acessos-definir` em `api/debug.js`
  (`TIPOS_SESSAO_ADMIN` — sessão pura, sem CRON_SECRET, mesmo padrão do
  `fluxo-caixa-config-get/-set`).
- `obterAdminSessao(token, db, pagina)` (`lib/pontoAuth.js`) ganhou um 3º
  parâmetro opcional: se informado, também confere se aquela página está
  liberada pro funcionário (super_admin sempre passa). Call sites que já
  existiam e não passam esse parâmetro continuam com o comportamento
  antigo (só confere `admin`) — só quem precisava de página própria foi
  atualizado: `api/dashboard-data.js` (`dashboard`, ou
  `projecao-financeira` se `?pagina=projecao-financeira`),
  `api/analytics-todos-data.js` visao=bipagem (`bipagem`),
  `api/collect.js` projeção financeira manual (`projecao-financeira`), e
  `exigirAdmin`/`exigirSuperAdmin` em `api/debug.js` (`ponto` por
  default, `projecao-financeira` nos endpoints de Fluxo de Caixa).
- **Limitação conhecida, aceita de propósito**: `concorrencia` e `tv` não
  têm endpoint próprio pra travar de verdade — só escondem o link na
  barra lateral (`RicapetAuth.aplicarVisibilidadeMenu()` em
  `assets/auth.js`). "Análise de Concorrência" é um `<iframe>` pra
  `ricapet-concorrencia.vercel.app` (projeto/repo separado, sem SSO com
  este); "Painel TV" é kiosk sem login por design (só o `DASHBOARD_TOKEN`
  opcional protege de verdade). `estoque-saldo.html` (balanço mensal) lê
  via `ESTOQUE_PUBLIC_SECRET` compartilhado, não sessão por usuário —
  também fica de fora do controle real, só o link é escondido.
- **Auto-migração e ordem de execução importam aqui**: `super_admin` e
  `funcionarios_paginas` entram no mesmo mecanismo de auto-migração de
  `garantirEsquemaPonto` (roda na 1ª chamada que precisar, ver comentário
  no topo da função em `api/debug.js`). Pra não quebrar em produção logo
  após o deploy (1ª chamada tocando a coluna/tabela nova, antes da
  migração rodar), `funcionarioEhSuperAdmin`/`funcionarioTemAcessoPagina`
  (`lib/pontoAuth.js`) engolem erro de coluna/tabela ausente e devolvem
  "sem acesso" em vez de derrubar a rota com 500 — e
  `exigirAdmin`/`exigirSuperAdmin`/`debugPontoLogin`/
  `debugPontoDefinirSuperAdmin` chamam `garantirEsquemaPonto` **antes** de
  qualquer SELECT que dependa das colunas novas (não depois, como o
  padrão antigo). Sem isso o próprio login quebraria pra todo mundo até
  alguém disparar a migração manualmente.

**Depois do deploy desta feature, rodar uma vez** (o dono do projeto, com
o CRON_SECRET):
```
POST /api/debug?tipo=ponto-definir-super-admin&secret=CRON_SECRET
{ "nomes": ["Ricardo"] }
```
Sem isso `/acessos.html` fica inacessível pra todo mundo (inclusive o
Ricardo) — e, como o padrão é negar por página, todo admin que não seja
super_admin perde acesso a todas as páginas até o Ricardo entrar em
Acessos e liberar manualmente.

## Estrutura de arquivos

```
api/
  collect.js               rota de coleta (cron externo) — o trabalho pesado
  dashboard-data.js        lida pelo frontend, CPU ~zero, só lê Turso
  marcar-coletado.js       webhook chamado por checkout_bipagem.py (local,
                           C:\RobotOmie) quando uma etiqueta é bipada no galpão
  pendencias-ml.js         perguntas/mensagens pendentes no ML — chamado
                           por checkout_bipagem.py a cada ~15min, sem cron próprio
  analytics-todos-data.js  aba "Desempenho" (vendas por produto/SKU)
  backfill-*.js            reprocessa período retroativo (rodar manualmente
                           quando faltar histórico ou mudar schema)
  concorrentes.js          endpoint de outro projeto (ricapet-concorrencia)
                           aparentemente reaproveitado/leftover neste repo —
                           usa Redis direto, não Turso; confirmar se ainda é usado
  shopee-auth-url.js / shopee-callback.js   fluxo OAuth Shopee (rodar manualmente
                           1x por loja para gerar refresh_token)
  debug.js                 inspeção manual (usa o Redis legado)

lib/
  db.js            cliente Turso (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN)
  kv.js            get/set/del genérico sobre Turso
  redis.js         cliente Upstash legado (só debug.js)
  mlAuth.js        access_token/refresh_token do ML, 2 contas (Ricapet/Thapets)
  mlOrders.js / mlFlexOrders.js / mlAllOrders.js / mlClaims.js / mlAds.js / mlRespostaSugerida.js
                   busca e processamento de pedidos/devoluções/anúncios ML
  shopeeAuth.js    autenticação + assinatura Shopee Open API v2 (usa proxy
                   Fixie — variável FIXIE_URL — para IP fixo)
  shopeeOrders.js / shopeeReturns.js   pedidos e devoluções Shopee
  historicoFlex.js / historicoTodos.js / historicoTurboLive.js
                   grava/lê histórico no Turso para as diferentes abas
  estoqueSaldo.js  balanço mensal de estoque (integra JSONBin + Google Sheets)
  tabelaProdutos.js / tabelaProdutos.json
                   mapeamento SKU → produto/cor/tamanho, gerado a partir de
                   C:\FECHAMENTO\03 AUXILIARES\TABELA_AUXILIAR.xlsx (ver scripts/)

public/
  tv.html          tela para TV da expedição — alto contraste, contagem
                   regressiva por pedido, sem interação. Fetch a cada 20s
                   (INTERVALO_BUSCA_MS), relógio/contadores a cada 1s.
  index.html       painel operacional (tabela), uso normal no navegador
  backfill-runner.html   UI manual para disparar os backfills
  assets/
    auth.js              sessão de login único (sessionStorage), redireciona
                         pra login.html se não tiver sessão válida
    tema.js              alternador de tema claro/escuro — salva escolha em
                         localStorage['ricapet_tema2'], aplica data-theme no
                         <html>. Cada página também tem um <script> INLINE no
                         <head> (antes de qualquer CSS/imagem) que lê a mesma
                         chave e aplica data-theme antes de pintar, pra não
                         piscar — tema.js só cuida do botão depois que a
                         página carregou. Sem escolha salva, segue
                         prefers-color-scheme do sistema (não seta o atributo).
    tokens-admin.css     identidade visual compartilhada de todas as páginas
                         do admin. Migrada em set/2026 da identidade "Console
                         Ricapet" (roxo #5D4FA8/laranja #f5a623, Sora/Manrope)
                         pra identidade "portal" (teal #4FB8B9/terracota
                         #B5651D, Space Grotesk/Inter/IBM Plex Mono, claro+
                         escuro) — pacote de identidade visual fornecido pelo
                         dono do projeto, aplicado a pedido dele mesmo depois
                         de confirmado (a 1ª tentativa trocou a sidebar por um
                         cabeçalho horizontal, como o portal originalmente não
                         tem sidebar — revertido pra sidebar vertical de novo,
                         só recolorida, porque era isso que ele queria manter).
                         Os NOMES das variáveis (--page-bg, --ink, --sidebar-
                         bg, --accent...) continuam os mesmos de antes da
                         migração — só o VALOR mudou — pra não precisar
                         reescrever cada regra CSS espalhada pelas páginas;
                         por isso alguns nomes ficam "torcidos" (--teal agora
                         guarda o terracota, não um teal de verdade — é só o
                         2º acento da paleta). Linkar no <head> de toda página
                         admin, ANTES do próprio <style> da página. Cada
                         página continua livre pra ter tokens só dela no
                         próprio :root (cores de estado tipo --ok/--bad/
                         --danger-*, --radius, --surface-2, etc.) — este
                         arquivo cobre só o que é da marca (cor, sidebar,
                         fonte). `tv.html` e `backfill-runner.html` ficam de
                         fora de propósito (não são "admin" — TV é kiosk sem
                         menu, backfill é ferramenta interna avulsa).
                         `estoque-atualizar.html` (mobile, sem sidebar por
                         design) recebe só cor/fonte/tema, sem os tokens de
                         sidebar.
    logo-ricapet-teal.png  logo em teal sobre fundo TRANSPARENTE (a arte
                         BRANCA em `logo-ricapet.png` só funciona sobre fundo
                         escuro/roxo — invisível numa marca d'água sobre fundo
                         claro). Usada só como marca d'água (ver abaixo);
                         a sidebar/topo continua usando a versão branca,
                         porque ali o fundo é sempre o degradê teal escuro.

  **Marca d'água**: todas as páginas do admin (as 9 com sidebar + `estoque-
  atualizar.html`) têm `body::before` — logo grande, `min(72vmin, 760px)`,
  `opacity: 0.06`, `position: fixed` atrás do conteúdo — mesmo padrão já
  usado em `tv.html`. O wrapper de conteúdo de cada página (`.conteudo-
  principal` ou `main`) precisa de `position: relative; z-index: 1` pra
  ficar acima da marca d'água (sidebar/header já são positioned com z-index
  próprio, não precisam). `login.html` fica de fora (card centralizado
  pequeno, sem "fundo" de verdade pra mostrar a marca d'água).
scripts/
  gerar_tabela_produtos.py   regenera lib/tabelaProdutos.json a partir do
                             Excel local — rodar sempre que TABELA_AUXILIAR mudar

vercel.json        {} — vazio de propósito; cron nativo do Vercel não é usado
                    (ver seção de cron abaixo)
```

## Cron: por que NÃO usa o cron nativo do Vercel

O Vercel Cron no Hobby só permite 1x/dia, insuficiente para um SLA de 3-4h.
Solução: cron-job.org (externo, gratuito) chama
`GET /api/collect?secret=CRON_SECRET` por HTTP normal, que não tem essa
restrição. `vercel.json` fica vazio de propósito. Alternativa considerada e
descartada por ora: upgrade para Vercel Pro ($20/mês), que libera cron nativo
por minuto.

## ⚠️ Risco conhecido: deploy manual via Vercel CLI pode divergir do Git

O domínio de produção é `ricapetadministrativo.vercel.app` (migrado de
`painel-entrega-turbo.vercel.app`, que passou a redirecionar e quebrava
`fetch()` no Safari/iOS ao bater ponto). Essa migração foi feita rodando
`vercel` CLI direto (device-code login) a partir de uma pasta local do
projeto — **não** via push no GitHub.

Isso expõe um risco real, já registrado no próprio aviso da Vercel CLI:
*"Deploy sem `.vercel/project.json` linkado cria um projeto novo
silenciosamente em vez de dar erro"*. Na prática, qualquer `vercel deploy`
rodado a partir de um checkout local **desatualizado** (ex.: um clone
antigo, numa branch parada há dias) publica o código antigo daquele
checkout e pode acabar associado ao domínio de produção — sem que o
GitHub `main` mude uma linha. Isso já aconteceu: o domínio chegou a
servir uma versão de `index.html` anterior ao redesign "Console Ricapet"
(pré-#36), enquanto o `main` já estava várias PRs à frente.

**Regra**: não rodar `vercel deploy`/`vercel --prod` manualmente a partir
de um checkout local para mudanças de rotina — deixar o deploy automático
via GitHub (push/merge em `main`) ser a única fonte de verdade. Se um
deploy manual for mesmo necessário (ex. troca de domínio, que não dá pra
fazer só com push), rodar a partir de um clone **recém-sincronizado com
`origin/main`** e, depois, conferir no dashboard da Vercel (Deployments)
se o deployment de produção aponta pro commit correto do `main` — não
assumir que "deploy tocado com sucesso" pela CLI significa que o domínio
está servindo o código mais recente do Git.

## ✅ Functions Storage estourado (10GB/10GB) — resolvido em 14/set/2026

Diagnosticado e corrigido em 14/set/2026 (Vercel → Usage → Functions Storage): o total
da conta `ricapet1` bateu **10,35 GB / 10 GB** (Hobby), com quase tudo
concentrado em dois projetos que na prática são o **mesmo repositório**
(`painel-entrega-turbo`) deployado duas vezes:

| Projeto | Functions Storage |
|---|---|
| `ricapetadministrativo` (produção real) | 7,94 GB |
| `painel-entrega-turbo` (órfão, "No Production Deployment") | 2,25 GB |
| `analise-concorrencia` | 163,87 MB |
| `ricapet-admin-1789171214998-IH31` | 0 B |
| `painel-estoque-adesivo-1789171304197-HfSs` | 0 B |
| `ricapet-portal` | 0 B |

Causa: o projeto `painel-entrega-turbo` nunca foi desconectado do GitHub
depois da migração de domínio pra `ricapetadministrativo` (ver seção
acima) — então **todo push continua gerando deployment nos dois
projetos ao mesmo tempo** (confirmado na lista de Deployments: cada
commit aparece 2x, inclusive merges em `main`, que viram "Production"
nos dois). Com o ritmo de dezenas de PRs/dia que o projeto vem tendo
desde 10/set, o histórico de deployments nunca é limpo automaticamente
no Hobby e foi acumulando até estourar. `ricapet-admin-…-IH31` e
`painel-estoque-adesivo-…-HfSs` são projetos-fantasma criados sem querer
por `vercel deploy` sem `.vercel/project.json` linkado — mesmo risco já
descrito acima, só que já concretizado (estão vazios, mas poluem a lista
de projetos).

**Correção aplicada** (dono do projeto, via Vercel CLI local — Claude Code
não tem credencial de acesso à conta Vercel, só orientou os comandos):
```bash
vercel remove ricapetadministrativo --safe --yes   # limpa histórico, preserva o que está no ar
vercel remove painel-entrega-turbo --safe --yes
vercel project rm painel-entrega-turbo             # projeto duplicado apagado por completo
```
Os dois projetos-fantasma (`ricapet-admin-1789171214998-IH31`,
`painel-estoque-adesivo-1789171304197-HfSs`) já não existiam mais na
hora de tentar apagar — nada a fazer ali.

**Note pra não repetir**: o projeto `painel-entrega-turbo` não existe
mais na Vercel. Só `ricapetadministrativo` (produção,
`ricapetadministrativo.vercel.app`) deploya a partir de agora — não
esperar mais ver 2 deployments por push nem 2 comentários do
`vercel[bot]` em PRs futuras. Se isso reaparecer, é sinal de que um novo
projeto Vercel foi criado e linkado ao repo sem querer (ver seção
acima sobre `vercel deploy` sem link) — vale conferir Settings → Git de
cada projeto na conta antes de repetir a limpeza.

## Variáveis de ambiente (Vercel → Project Settings → Environment Variables)

```
# Turso (banco principal)
TURSO_DATABASE_URL
TURSO_AUTH_TOKEN

# Redis legado (só api/debug.js)
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

# Mercado Livre — uma conta = um prefixo
ML_RICAPET_CLIENT_ID / ML_RICAPET_CLIENT_SECRET / ML_RICAPET_REFRESH_TOKEN
ML_THAPETS_CLIENT_ID / ML_THAPETS_CLIENT_SECRET / ML_THAPETS_REFRESH_TOKEN

# Shopee — uma loja = um prefixo
SHOPEE_RICAPET_PARTNER_ID / SHOPEE_RICAPET_PARTNER_KEY / SHOPEE_RICAPET_SHOP_ID / SHOPEE_RICAPET_REFRESH_TOKEN
SHOPEE_THAPETS_PARTNER_ID / SHOPEE_THAPETS_PARTNER_KEY / SHOPEE_THAPETS_SHOP_ID / SHOPEE_THAPETS_REFRESH_TOKEN
SHOPEE_AMBIENTE          # "sandbox" (padrão) ou produção
FIXIE_URL                # proxy com IP fixo, exigido pela Shopee em produção

# Cron / segurança de rotas
CRON_SECRET              # protege /api/collect e /api/marcar-coletado
DASHBOARD_TOKEN          # opcional; protege /api/dashboard-data (?token=...)
                         # ⚠️ ARMADILHA: se isso estiver configurado, tv.html
                         # E index.html PRECISAM ser abertos com ?token=... na
                         # própria URL (eles repassam pro fetch sozinhos - ver
                         # `const TOKEN = new URLSearchParams(...)` nos dois
                         # arquivos), senão a tela fica com tudo zerado (401
                         # silencioso). Já aconteceu de verdade: alguém
                         # configurou essa variável sem atualizar o link/script
                         # que abre a TV, e ninguém percebeu até a tela mostrar
                         # 0 pedidos por dias. Marcado "Sensitive" na Vercel -
                         # o valor não é legível de volta nem pela CLI depois
                         # de criado; se precisar trocar, gera um valor novo
                         # (não tem como recuperar o antigo) e atualiza em
                         # TODO lugar que abre a URL com token: RobotOmie/
                         # abrir_painel_tv.ps1, bookmark de quem usa
                         # index.html, e o link "Painel TV" da barra lateral
                         # — este último está hardcoded com o token atual em
                         # TODAS as páginas de sessão (acessos.html,
                         # bipagem.html, estoque.html, estoque-saldo.html,
                         # ponto.html, projecao-financeira.html), porque
                         # essas páginas usam sessão de admin, não o token da
                         # URL, e não têm de onde "repassar" o valor —
                         # index.html é a única exceção, que já lê o próprio
                         # `?token=` da URL e repassa pro link (ver `const
                         # TOKEN` + `linkPainelTV`). Já aconteceu de verdade:
                         # o link da barra lateral ficou sem o token por um
                         # tempo e a TV abria com tudo zerado (401
                         # silencioso) até alguém notar.

# Integrações de estoque (lib/estoqueSaldo.js)
JSONBIN_ESTOQUE_API_KEY
JSONBIN_ESTOQUE_BIN_ID
GOOGLE_SHEETS_WEBAPP_URL

# api/concorrentes.js (possível leftover de outro projeto)
REDIS_URL
CONCORRENTES_WEBHOOK_SECRET
```

## Integrações externas / sistemas locais

- `checkout_bipagem.py` (`C:\RobotOmie`, local, não neste repo) chama
  `/api/marcar-coletado` ao bipar etiqueta e `/api/pendencias-ml` a cada
  ~15min para checar perguntas/mensagens pendentes no ML.
- `TABELA_AUXILIAR.xlsx` (`C:\FECHAMENTO\03 AUXILIARES\`, local) alimenta
  `lib/tabelaProdutos.json` via `scripts/gerar_tabela_produtos.py` — rodar e
  dar commit sempre que a planilha mudar.

## Pendências conhecidas (do README original)

- Campo exato do canal "Entrega Turbo" na Shopee em `lib/shopeeOrders.js`
  ainda não validado com um pedido real de produção.
- Autorização OAuth inicial do ML/Shopee: se já existirem refresh_tokens
  salvos em outro projeto (ex.: painelvendas-seven), copiar em vez de
  refazer o fluxo.
- `api/concorrentes.js` usa Redis direto e parece pertencer a outro
  projeto (`ricapet-concorrencia`) — confirmar se ainda é necessário aqui
  antes de mexer nele.

## Projetos relacionados (mesma conta Vercel `ricapet1` / GitHub `ricapetcomercio-eng`)

- `painel-estoque-adesivo` — estoque e planejamento de compras
- `painelvendas-seven` — dashboard de vendas (compartilhava o Redis antigo)
- `analise-concorrencia` (`ricapet-concorrencia.vercel.app`) — scraper de
  concorrentes (Python/Playwright)
