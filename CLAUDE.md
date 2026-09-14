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
- Thapets no Mercado Pago fica como placeholder (`erro: "Conta Thapets
  ainda não autorizada..."`) — a conta não recebe o escopo `payments` do
  Mercado Livre apesar de duas apps OAuth criadas com config idêntica à da
  Ricapet; investigação aponta pra restrição de conta, não de config do
  app. Shopee funciona normalmente para as duas lojas (não depende desse
  escopo).

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
- **Saídas**: **pendente de integração com o Omie** ("contas a pagar",
  categoria por categoria — Aluguel, Fornecedores, FGTS/INSS, etc.). Até
  isso existir, a tela mostra uma linha zerada e um aviso. Vai precisar de
  `lib/omieContasPagar.js` (novo) + credenciais `OMIE_RICAPET_APP_KEY`/
  `_APP_SECRET` e `OMIE_THAPETS_APP_KEY`/`_APP_SECRET` (Omie trata as duas
  empresas como contas separadas) — seguir o mesmo padrão empírico já usado
  pro Mercado Pago/Shopee: endpoint de debug primeiro, confirmar o formato
  real da resposta com dado de produção, só depois escrever o código final.
- **Saldo acumulado**: calculado no frontend (não vem pronto do backend) —
  `saldo do dia anterior + total de entradas do dia − total a pagar do
  dia`, começando do saldo bancário manual somado (Ricapet + Thapets).
- Duas novas rotas em `api/debug.js` (`fluxo-caixa-config-get`/`-set`),
  protegidas só pela sessão de admin (`exigirAdmin`), sem nenhum secret de
  app — mesmo padrão de "sessão pura" do `?acao=projecao-financeira-manual`
  em `api/collect.js` (ver `TIPOS_SESSAO_ADMIN`).
- `entrega_turbo:fluxo_caixa_site_manual` guarda o mapa `{ "AAAA-MM-DD":
  valor }` das vendas manuais do site.

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
                         # TODO lugar que abre a URL com token (RobotOmie/
                         # abrir_painel_tv.ps1, bookmark de quem usa
                         # index.html, link "Painel TV" da barra lateral).

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
