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
