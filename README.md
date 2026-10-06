# Painel Entrega Turbo/Expressa — Ricapet & Thapets

Painel que identifica pedidos do Mercado Livre e da Shopee com promessa de
entrega em poucas horas (ML: "entrega em poucas horas" via lead_time / Flex;
Shopee: modalidade **Entrega Turbo**, até 4h) e exibe em tempo real numa TV
no galpão de expedição. Deploy na Vercel (plano Hobby), produção em
`ricapetadministrativo.vercel.app`.

> Detalhes de arquitetura, decisões e histórico de correções ficam em
> [`CLAUDE.md`](CLAUDE.md). Este README é só a visão geral.

## Telas principais

- `/tv.html` — **tela da TV da expedição**: alto contraste, contagem
  regressiva por pedido (verde → âmbar → vermelho pulsante perto do prazo ou
  atrasado), faixa de alerta quando há pedido crítico, sem interação. Além de
  Flex/Turbo, mostra os blocos "Shopee geral" e "ML geral" (todo pedido ainda
  aguardando despacho). Busca dados a cada 20s e atualiza os contadores a
  cada 1s.
- `/index.html` — painel operacional (tabela), pra uso no navegador.
- Telas administrativas com login único (`/login.html`): Ponto, Bipagem,
  Estoque, Fluxo de Caixa (`projecao-financeira.html`) e Acessos.

## Fluxo de dados

Pensado para caber no orçamento de CPU do plano Hobby da Vercel (4h de
Fluid Active CPU por 30 dias):

```
cron-job.org (externo, 6h-18h, seg-sáb)
   │  GET /api/collect?secret=CRON_SECRET  (a cada 1 min)
   ▼
api/collect.js  ──► chama APIs do Mercado Livre + Shopee, processa e
   │                grava o resultado pronto no Turso
   ▼
Turso (SQLite cloud: kv_simples + tabelas de histórico)
   ▲
   │  só leitura (CPU ~zero)
api/dashboard-data.js
   ▲
   │  fetch periódico
public/tv.html  +  public/index.html
```

- `/api/collect.js` faz todo o trabalho pesado e nunca é chamado pelo
  navegador.
- `/api/dashboard-data.js` só lê dado já pronto do banco — **não colocar
  lógica pesada ali**.

### Throttles internos de `/api/collect.js`

O cron chama a cada minuto, mas cada bloco só roda de verdade no seu próprio
intervalo mínimo (constantes no topo de `api/collect.js`):

| Dado | Intervalo mínimo | Motivo |
|---|---|---|
| Pedidos Flex (ML, tempo real p/ TV) | 5 min | maior custo de CPU; TV aceita até 5 min de atraso |
| "Todos os pedidos" ML (BI/"ML geral") | 5 min | não precisa do ritmo do Flex |
| Shopee | 15 min | cota limitada do proxy Fixie (IP fixo) |
| Devoluções | 30 min | mudam devagar |
| Atraso total da semana (TV) | 30 min | só agrega dado já gravado, muda devagar |

## Armazenamento

- **Turso** (libSQL/SQLite cloud) é o banco principal: `lib/db.js` (cliente)
  e `lib/kv.js` (get/set/del genérico sobre a tabela `kv_simples`), além das
  tabelas de histórico (`historico_flex`, `historico_todos`, etc.).
- **Redis (Upstash)** é legado: `lib/redis.js` só é usado em `api/debug.js`.
  Não usar em código novo. (A migração aconteceu porque o Redis era
  compartilhado com outros projetos e estourou a cota de requisições.)

## Estrutura

```
api/
  collect.js              coleta (cron externo) — trabalho pesado
  dashboard-data.js       leitura para o frontend, CPU ~zero
  marcar-coletado.js      webhook da bipagem local (checkout_bipagem.py)
  pendencias-ml.js        perguntas/mensagens pendentes no ML
  analytics-todos-data.js aba "Desempenho" e visões de BI
  backfill-*.js           reprocessamento manual de períodos antigos
  shopee-auth-url.js / shopee-callback.js   OAuth Shopee (1x por loja)
  debug.js                rotas de diagnóstico/administração
lib/
  db.js, kv.js            Turso
  redis.js                Upstash legado (só debug.js)
  ml*.js, shopee*.js      integrações Mercado Livre / Shopee
  historico*.js           leitura/gravação de histórico no Turso
  mp*.js, omie*.js        Mercado Pago / Omie (Fluxo de Caixa)
public/                   telas (tv.html, index.html, admin)
scripts/                  utilitários locais (ex.: gerar_tabela_produtos.py)
vercel.json               {} — vazio de propósito (sem cron nativo)
```

## Variáveis de ambiente (Vercel → Project Settings)

### Banco
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` — banco principal.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — Redis legado, só
  `api/debug.js`.

### Mercado Livre (uma conta = um prefixo)
- `ML_RICAPET_CLIENT_ID` / `ML_RICAPET_CLIENT_SECRET` / `ML_RICAPET_REFRESH_TOKEN`
- `ML_THAPETS_CLIENT_ID` / `ML_THAPETS_CLIENT_SECRET` / `ML_THAPETS_REFRESH_TOKEN`

### Shopee (uma loja = um prefixo)
- `SHOPEE_RICAPET_PARTNER_ID` / `_PARTNER_KEY` / `_SHOP_ID` / `_REFRESH_TOKEN`
- `SHOPEE_THAPETS_PARTNER_ID` / `_PARTNER_KEY` / `_SHOP_ID` / `_REFRESH_TOKEN`
- `SHOPEE_AMBIENTE` — `sandbox` (padrão) ou produção.
- `FIXIE_URL` — proxy com IP fixo, exigido pela Shopee em produção.

### Mercado Pago e Omie (Fluxo de Caixa)
- `MP_RICAPET_CLIENT_ID` / `MP_RICAPET_CLIENT_SECRET`
- `MP_THAPETS_CLIENT_ID` / `MP_THAPETS_CLIENT_SECRET`
- `OMIE_RICAPET_APP_KEY` / `OMIE_RICAPET_APP_SECRET`
- `OMIE_THAPETS_APP_KEY` / `OMIE_THAPETS_APP_SECRET`

### Segurança de rotas
- `CRON_SECRET` — protege `/api/collect`, `/api/marcar-coletado` e as rotas
  de gestão de `/api/debug`.
- `DASHBOARD_TOKEN` — opcional; protege `/api/dashboard-data`. Se estiver
  configurado, `tv.html` e `index.html` **precisam** ser abertos com
  `?token=...` na URL (o front repassa pra API), senão a tela fica zerada
  (401 silencioso).
- `PENDENCIAS_ML_SECRET` — secret próprio de `/api/pendencias-ml`.
- `ESTOQUE_PUBLIC_SECRET` — secret das rotas públicas de estoque.
- `APPMAX_WEBHOOK_SECRET` — webhook da Appmax.

### Ponto
- `PONTO_PUBLIC_SECRET` — embutido no app nativo de ponto (diferente do
  `CRON_SECRET`); libera só listar funcionários, login e bater ponto.
- `PONTO_TOKEN_SECRET` — assina (HMAC) o token de sessão.
- `PONTO_PIN_SALT` — salt do hash do PIN.
- `PONTO_EMPRESA_NOME` / `PONTO_EMPRESA_CNPJ` / `PONTO_EMPRESA_ENDERECO` —
  opcionais, cabeçalho do Cartão de Ponto.

### Estoque
- `JSONBIN_ESTOQUE_API_KEY`, `JSONBIN_ESTOQUE_BIN_ID`, `GOOGLE_SHEETS_WEBAPP_URL`

### Leftover de outro projeto
- `REDIS_URL`, `CONCORRENTES_WEBHOOK_SECRET` — só `api/concorrentes.js`
  (aparentemente do projeto `ricapet-concorrencia`).

## ⏱️ Por que não usa o cron nativo da Vercel

O SLA de entrega expressa é de poucas horas, e o Vercel Cron no plano Hobby
só permite execução **1x por dia**. Por isso a coleta é disparada por um
scheduler externo gratuito, o [cron-job.org](https://cron-job.org), que faz
um GET HTTP normal — a Vercel não restringe requisições comuns a uma
function, só o cron nativo. `vercel.json` fica vazio de propósito.

Configuração do cronjob:
- URL: `https://ricapetadministrativo.vercel.app/api/collect?secret=SEU_CRON_SECRET`
- Método: GET
- Frequência: a cada 1 min, **só 6h-18h, segunda a sábado** (economia de
  CPU). Chamar com frequência maior que os throttles acima não gera trabalho
  duplicado.

A rota valida `?secret=` contra `CRON_SECRET`. Alternativa descartada por
ora: Vercel Pro ($20/mês), que libera cron nativo por minuto.

## Deploy

O deploy é automático via GitHub (merge em `main` → projeto
`ricapetadministrativo` na Vercel). Evite `vercel deploy` manual a partir de
checkout local — pode publicar código desatualizado (ver `CLAUDE.md`).

## Aba "Desempenho" e TABELA_AUXILIAR

A aba Desempenho agrupa o histórico de pedidos por produto/cor/tamanho
cruzando o SKU com `lib/tabelaProdutos.json`, gerado a partir de
`C:\FECHAMENTO\03 AUXILIARES\TABELA_AUXILIAR.xlsx`. **Sempre que a planilha
mudar**:

```
python scripts/gerar_tabela_produtos.py
git add lib/tabelaProdutos.json
git commit -m "Atualiza tabela SKU->Produto"
git push
```

SKUs sem correspondência aparecem como "Não mapeado" — sinal de que a
planilha precisa ser atualizada.

## Pendências conhecidas

1. **Campo do canal "Entrega Turbo" na Shopee**: `lib/shopeeOrders.js`
   descobre o `logistics_channel_id` via `get_channel_list` (nome com
   "Turbo"), mas o campo correspondente no `get_order_detail` ainda não foi
   validado com pedido real de produção.
2. **Autorização OAuth inicial**: se já existirem refresh_tokens em outro
   projeto, copiar os valores; senão, rodar o fluxo OAuth uma vez por conta
   (Shopee: `api/shopee-auth-url.js` / `api/shopee-callback.js`).
3. **`api/concorrentes.js`** usa Redis direto e parece pertencer a outro
   projeto — confirmar se ainda é necessário antes de mexer.
