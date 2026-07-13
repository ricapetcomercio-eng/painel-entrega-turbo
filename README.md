# Painel Entrega Turbo/Expressa — Ricapet & Thapets

Painel que identifica pedidos do Mercado Livre e da Shopee com promessa de
entrega em poucas horas (ML: "entrega em poucas horas" via lead_time;
Shopee: modalidade **Entrega Turbo**, até 4h).

## Telas disponíveis

- `/index.html` — painel operacional (tabela), pra uso no navegador normal.
- `/tv.html` — **tela pensada pra TV da expedição**: alto contraste, anel de
  contagem regressiva por pedido (verde → âmbar <45% do prazo → vermelho
  pulsante nos últimos 20% do prazo ou atrasado), faixa de alerta piscante
  quando há pedido crítico/atrasado, sem necessidade de interação. Deixe essa
  URL aberta em tela cheia no navegador/Chromecast/Fire TV Stick conectado
  na TV. Atualiza os dados a cada 30s e os contadores a cada 1s.

 (pensada para não estourar limites de CPU do Vercel)

```
/api/collect.js         -> rodado pelo cron. Chama ML + Shopee, processa,
                            grava resultado pronto no Redis. NUNCA chamado
                            diretamente pelo navegador.
/api/dashboard-data.js  -> chamado pelo frontend. Só lê o Redis. CPU ~zero.
/public/index.html      -> painel visual, consome /api/dashboard-data.
/lib/redis.js           -> cliente Upstash Redis (REST).
/lib/mlAuth.js          -> gerencia access_token/refresh_token do ML (2 contas).
/lib/mlOrders.js        -> busca pedidos ML e verifica lead_time (entrega expressa).
/lib/shopeeAuth.js      -> autenticação e assinatura Shopee Open API v2.
/lib/shopeeOrders.js    -> busca pedidos Shopee e filtra por canal "Turbo".
```

## Variáveis de ambiente necessárias (configurar na Vercel)

### Redis (reaproveitar do painelvendas-seven, se preferir o mesmo banco)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### Mercado Livre (uma conta = uma app)
- `ML_RICAPET_CLIENT_ID`
- `ML_RICAPET_CLIENT_SECRET`
- `ML_RICAPET_REFRESH_TOKEN` (gerado uma vez via fluxo OAuth; depois o sistema renova sozinho)
- `ML_THAPETS_CLIENT_ID`
- `ML_THAPETS_CLIENT_SECRET`
- `ML_THAPETS_REFRESH_TOKEN`

### Shopee (uma loja = um shop_id)
- `SHOPEE_RICAPET_PARTNER_ID`
- `SHOPEE_RICAPET_PARTNER_KEY`
- `SHOPEE_RICAPET_SHOP_ID`
- `SHOPEE_RICAPET_REFRESH_TOKEN`
- `SHOPEE_THAPETS_PARTNER_ID`
- `SHOPEE_THAPETS_PARTNER_KEY`
- `SHOPEE_THAPETS_SHOP_ID`
- `SHOPEE_THAPETS_REFRESH_TOKEN`

### Cron
- `CRON_SECRET` — string aleatória, usada pra você testar a rota `/api/collect`
  manualmente (`/api/collect?secret=...`) sem precisar do cabeçalho do Vercel Cron.

## ⏱️ Como a coleta é disparada (sem depender do Vercel Cron)

O SLA de entrega expressa é de 3-4h, então "1x por dia" (limite do Vercel Cron
no plano Hobby) não serve. A solução usada aqui: **um scheduler externo
gratuito chama a rota `/api/collect` diretamente por HTTP** — o Vercel não
restringe requisições HTTP normais recebidas por uma function, só o cron
nativo dele.

**Passo a passo com [cron-job.org](https://cron-job.org) (gratuito, sem cartão, até 1x/min):**

1. Crie uma conta gratuita em cron-job.org.
2. Crie um novo cronjob:
   - URL: `https://SEU-DOMINIO.vercel.app/api/collect?secret=SEU_CRON_SECRET`
   - Método: GET
   - Intervalo: a cada 1 ou 2 minutos (o `/api/collect` já tem um throttle
     interno de 2 min, então chamar mais rápido que isso não gera trabalho
     duplicado nem gasta CPU à toa)
3. Pronto — o cron-job.org vai bater nessa URL sozinho, 24/7, de graça.

A rota `/api/collect` já valida o `?secret=` contra a variável de ambiente
`CRON_SECRET`, então só quem souber o segredo consegue disparar a coleta.

**Alternativa**: se preferir manter tudo dentro do ecossistema Vercel, o
plano Pro ($20/mês) libera cron nativo com frequência de minutos — mas não é
necessário só por causa disso, o cron-job.org resolve sem custo.

## ⚠️ Outras pendências / TODOs antes de ir pra produção

1. **Campo exato do canal "Entrega Turbo" na Shopee**: `lib/shopeeOrders.js`
   descobre automaticamente o `logistics_channel_id` via `get_channel_list`
   procurando um nome com "Turbo", e depois compara com o campo
   `logistics_channel_id` no pedido — mas esse nome de campo no
   `get_order_detail` ainda não foi validado com um pedido real. Rodar uma vez
   e conferir/ajustar em `shopeeOrders.js` se necessário.

2. **Limite de horas do ML** (`LIMITE_HORAS_EXPRESSA` em `mlOrders.js`, hoje 4h)
   — ajustar conforme o que você observar nos pedidos reais.

3. **Autorização OAuth inicial**: se você já tem os refresh_tokens salvos em
   outro Redis (ex: painelvendas), copie os valores pra cá. Se não, rode o
   fluxo de autorização (ver conversa anterior) uma vez por conta.
