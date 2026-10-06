# Revisão do Painel TV (`public/tv.html`), out/2026

Revisão geral da tela da TV da expedição. Não é uma reescrita. Li `public/tv.html`
inteiro e `api/dashboard-data.js` (só para entender o formato do payload) e
abri a tela no Chromium headless (Playwright). Os arquivos de `public/` foram
servidos localmente e `/api/dashboard-data` foi interceptado com dados de
exemplo que cobrem FLEX, TURBO (Shopee e ML), AGORA, Shopee geral (com e sem
prazo real) e ML geral (com e sem prazo real), além de pedido atrasado,
coletado, entregue, não entregue, cancelado, listas vazias, API com 401, API
com 500 e API fora do ar. O relógio do navegador foi fixado em 06/out/2026
10:30 (Brasília) para o resultado ser reproduzível.

Decisões registradas no CLAUDE.md (contagem regressiva sempre, prazo sintético
de 24h, exceção do `diaSeguinte`, toggles em `localStorage`, ML geral
reativado, próximo 16h do ML geral) foram tratadas como intencionais e **não**
aparecem como bug aqui.

Screenshots em [`docs/revisao-painel-tv/`](revisao-painel-tv/):

| Arquivo | Cenário |
|---|---|
| `01-normal-1920x1080.png` | Dados realistas, TV Full HD (antes da correção) |
| `01-normal-1366x768.png` | Mesmos dados, 1366x768 |
| `03-listas-vazias-1920x1080.png` | Payload sem nenhum pedido (`aviso` da 1ª coleta) |
| `04-api-401-1920x1080.png` | **Antes**: API devolvendo 401 desde o carregamento |
| `05-api-fora-do-ar-1920x1080.png` | API caiu depois de já ter carregado (conexão recusada) |
| `06-api-ok-depois-401-1920x1080.png` | **Antes**: API ok e depois passa a devolver 401 |
| `07-depois-api-401-1920x1080.png` | **Depois** da correção: 401 desde o carregamento |
| `08-depois-ok-depois-401-1920x1080.png` | **Depois** da correção: ok e depois 401 (mantém os cards) |
| `09-depois-titulo-com-aspas-1920x1080.png` | **Depois** da correção: título com `"` e `<...>` |
| `10-antes-atrasado-de-ontem-apagado-1920x1080.png` | **Antes**: Flex e Shopee com prazo vencido ontem aparecem apagados |
| `11-depois-atrasado-de-ontem-destacado-1920x1080.png` | **Depois**: os mesmos pedidos em vermelho, como qualquer atrasado |

Console: **nenhum erro de JavaScript** (`pageerror`) em nenhum cenário. Os
únicos erros no console são os `Failed to load resource` esperados nos
cenários 401/500/offline.

---

## Corrigido neste PR (bug claro, pequeno e de baixo risco)

### 1. [Alta] 401 (e qualquer erro HTTP com corpo JSON) apagava a tela em silêncio, com ponto verde de "atualizado"

- **Onde**: `public/tv.html`, `buscarDados()` (antes: `const dados = await resp.json();` sem olhar `resp.ok`).
- **O que acontecia**: `/api/dashboard-data` responde 401 com corpo JSON válido
  (`{ "error": "Não autorizado" }`). Como o código não checava `resp.ok`,
  esse objeto ia direto para `montarCards`, virava zero cards e a tela mostrava
  "Nenhum pedido em aberto no momento 🎉", todos os KPIs em 0, **ponto verde** e
  "atualizado HH:MM". É exatamente a armadilha do `DASHBOARD_TOKEN` registrada no
  CLAUDE.md ("a tela fica com tudo zerado, 401 silencioso"): ninguém no galpão
  conseguia distinguir "não tem pedido" de "a TV perdeu o acesso". Pior ainda
  no meio do dia: se o token for trocado com a TV já ligada, os cards que
  estavam na tela **somem** na próxima busca (screenshot 06).
- **Como reproduzir (antes)**: configurar `DASHBOARD_TOKEN` na Vercel e abrir
  `tv.html` sem `?token=` (ou com token errado). Screenshots 04 e 06.
- **Correção**: se `!resp.ok`, lança erro e cai no `catch` que já existia. O
  `catch` mantém os últimos cards (mesmo comportamento que já existia para 500
  e para rede fora), pinta o ponto de vermelho e agora mostra o motivo:
  `erro 401 — confira o ?token= na URL da TV` ou `erro <status> ao atualizar`.
  Screenshots 07 e 08. Não muda frequência de chamada nem nada no backend.
- **Limitação que continua** (ver sugestão S2): se a TV já abre com 401, a
  área de cards continua com o texto "Nenhum pedido em aberto 🎉" da
  renderização inicial, só que agora com o ponto vermelho e a mensagem de erro
  no canto. Trocar esse texto é mudança visual, por isso ficou como sugestão.

### 2. [Média] Título ou SKU com aspas ou `<...>` quebrava o card (HTML sem escape)

- **Onde**: `public/tv.html`, `cardHtml()`: `itensSkuTxt`/`itensTxt` (e
  `conta`/`order_id`) eram interpolados crus em `innerHTML`, inclusive dentro de
  `title="..."`.
- **O que acontecia**: título de anúncio é texto livre da Shopee e do ML. Com
  `Tapete "Premium" 80x60 <Lavável> ...`, a primeira aspa fechava o atributo
  `title` e `<Lavável>` era interpretado como tag. A linha de SKU em destaque
  perdia o começo ("1x Tapete "Premium" 80x60") e mostrava só
  "Antiderrapante Para Cães...". Na prática, isso esconde o produto de quem está
  separando o pedido. Também é uma porta de injeção de HTML vinda de dado
  externo, ainda que de baixo risco (título do próprio anúncio).
- **Como reproduzir (antes)**: qualquer pedido cujo `itens[].titulo` (sem SKU)
  contenha `"` ou `<`. Compare o primeiro card de `01-normal-1920x1080.png`
  (antes) com `09-depois-titulo-com-aspas-1920x1080.png` (depois).
- **Correção**: nova função `escaparHtml()` (escapa `& < > " '`) aplicada a
  esses quatro campos. O texto exibido fica idêntico para títulos normais.

### 3. [Alta] Pedido atrasado desde ONTEM aparecia apagado (opacidade 0,4), não destacado

- **Onde**: `public/tv.html`, `montarCards()`, cálculo de `c.diaSeguinte`
  (antes: `!c.semPrazo && c.zona !== 'concluido' && !ehHojeBrasil(c.deadlineMs)`).
- **Causa**: a classe `.dia-seguinte` (opacidade 0,4, borda e fundo neutros e
  `animation: none`, tudo com `!important`) existe para apagar o card cujo prazo
  só vence **amanhã**. Mas o teste era só "o prazo não é hoje", e isso também é
  verdade para um prazo que venceu **ontem**. Resultado: o atrasado mais grave
  (vencido no dia anterior, ex. Flex de ontem que ninguém coletou, ou Shopee
  geral com `prazo_entrega` real de ontem) ia para o topo da lista (a ordenação
  por `msRestante` já estava certa), mas aparecia **apagado**, mais discreto
  que qualquer pedido no prazo. Atrasados de hoje não eram afetados, por isso o
  problema só aparece com atraso que passa da meia-noite. Shopee/ML geral **sem
  prazo real** (`semPrazo`) já ficavam fora do `diaSeguinte` e não eram
  afetados.
- **Como reproduzir (antes)**: pedido Flex com `deadline` no dia anterior e
  ainda `aguardando`. Screenshot 10: os dois primeiros cards.
- **Correção**: `diaSeguinte` agora também exige `c.zona !== 'preto'` (prazo
  ainda não vencido). Todo atrasado volta a ter o destaque normal de atrasado:
  borda e fundo vermelhos, contador vermelho, "🔴 ATRASADO" e pulso. Screenshot
  11. A exceção do `diaSeguinte` para pedidos sem prazo real continua igual.

---

## Achados não corrigidos (sugestões para o dono decidir)

Ordenados por gravidade. Todos são mudança de comportamento ou visual, ou têm
risco maior que o benefício para entrar numa revisão. Por isso ficaram só como
sugestão.

### S1. [Alta] "atualizado HH:MM" mede a hora do fetch, não a idade do dado

- **Onde**: `public/tv.html:869` (`'atualizado ' + new Date().toLocaleTimeString(...)`).
- **O que acontece**: o texto e o ponto verde dizem só que `/api/dashboard-data`
  respondeu, não que a **coleta** está em dia. Se o cron-job.org parar, se o
  `/api/collect` começar a falhar ou se a cota de CPU estourar só para a coleta,
  a TV continua com ponto verde e "atualizado" de 20 em 20 s, mostrando dado de
  horas atrás. Como o projeto está a ~77% da cota de CPU (CLAUDE.md), esse é o
  cenário de falha mais provável, e é invisível hoje.
- **Sugestão**: o payload já traz `atualizado_em_flex`, `atualizado_em` (turbo),
  `atualizado_em_shopee_todos` e `atualizado_em_ml_todos`. Dá para mostrar
  "dados de HH:MM" com a idade do Flex e pintar o ponto de amarelo/vermelho se
  passar de ~15 min (o throttle do Flex é 5 min), ignorando fora do horário do
  cron (18h-6h e domingo). Custo zero no backend.

### S2. [Média] Mensagem "Nenhum pedido em aberto 🎉" antes da primeira resposta e quando a API nunca respondeu

- **Onde**: `aplicarVisibilidadeShopeeTodos()`/`aplicarVisibilidadeMlTodos()`
  chamam `renderizarCards()` no carregamento, com `cardsAtuais = []`.
- **O que acontece**: até a primeira resposta (e para sempre, se a primeira
  resposta for erro) a área mostra "Nenhum pedido em aberto no momento 🎉".
  Com a correção 1 o canto já fica vermelho, mas a mensagem grande no centro
  continua dizendo "tudo certo".
- **Sugestão**: enquanto não houver nenhuma resposta OK, mostrar
  "Carregando…" ou "Sem conexão com o servidor" no lugar do 🎉.

### S3. [Média] Em 1366x768 só cabem ~3 cards. Em qualquer resolução, cards abaixo da dobra nunca aparecem

- **Onde**: `.topo-fixo` (sticky) com faixa de emergência, header, heatmap, KPIs
  e controles: 292 px em 1920x1080 e **331 px em 1366x768** (a barra de
  controles quebra em 2 linhas). Medido: 15 cards inteiros visíveis em
  1920x1080, só **3** em 1366x768 (`01-normal-1366x768.png`).
- **O que acontece**: a TV é kiosk sem interação, então não há quem role a
  página. Com o volume real citado no CLAUDE.md (~237 aguardando), quase tudo
  fica abaixo da dobra, inclusive toda a seção "Coletados hoje". A ordenação por
  urgência ameniza, mas um pedido FLEX com 3h de prazo pode ficar atrás de
  dezenas de cards Shopee/ML geral com prazo menor.
- **Sugestões** (escolher uma ou combinar):
  - esconder a barra `.controles` em modo kiosk (ex.: `?kiosk=1`), já que na TV
    ninguém clica nela (toggles continuam salvos no `localStorage`);
  - auto-rolagem lenta ou paginação automática dos cards;
  - cards mais compactos para Shopee/ML geral, ou uma linha-resumo em vez de
    cards individuais.

### S4. [Média] Legibilidade a distância: vários textos entre 10 e 13 px

- **Onde**: `.kpi .l` 10px (`:75`), `.card-conta` 11px (`:164`), `.selo-tipo`
  11px (`:145`), `.conexao` 11px, `.card-itens` 12px (`:174`), `.card-status`
  12px (`:186`), `.heatmap-fatia` 12px (`:63`), `.header .sub` 12px.
- **O que acontece**: a 3-5 m de uma TV Full HD, textos abaixo de ~18-20 px
  ficam ilegíveis. Os contadores (32px) e o número dos KPIs estão bons. Os
  rótulos dos KPIs, o selo do tipo (FLEX/TURBO/SHOPEE/ML) e a conta
  (ricapet/thapets), que diferenciam os cards, estão pequenos demais.
- **Sugestão**: subir os rótulos de KPI para ~14-16px, selo e conta para
  ~14px e status para ~15px. Se o espaço for o problema, ganhar altura com S3.

### S5. [Baixa-média] Contraste do heatmap: branco sobre laranja 2,35:1 e branco sobre vermelho 3,27:1

- **Onde**: `.heatmap-30` (branco em `#ff8a3d`) e `.heatmap-15` (branco em
  `#ff4d4f`). A faixa amarela usa texto escuro (9,7:1) e está ótima. A faixa de
  emergência (branco em `#ff4d4f`, piscando até 55% de opacidade) tem o mesmo
  problema.
- **Sugestão**: texto escuro (`#2a0d00`) na faixa laranja, como já é feito na
  amarela. Na vermelha, um vermelho mais escuro de fundo ou o número maior e em
  negrito.

### S6. [Baixa-média] KPIs, heatmap e modo emergência mudam com filtro/busca, mas os contadores por tipo não

- **Onde**: `atualizarKpis()` (`:790` em diante). Aguardando, Críticos,
  Atrasados, heatmap e `body.emergencia` usam `pendentes` (já filtrado por
  filtro, busca e toggles Shopee/ML geral). Flex, Turbo, Shopee (geral) e ML
  (geral) usam `cardsAtuais` sem filtro.
- **O que acontece**: com "🛍️ Shopee geral: oculto", o KPI "Shopee (geral)"
  continua mostrando o total, mas "Aguardando" não o inclui. Digitar algo na
  busca pode desligar a faixa de emergência. Isso pode ser intencional (KPI por
  tipo = visão global), mas hoje a faixa mistura as duas semânticas.
- **Sugestão**: decidir uma regra. A mais segura para a TV parece ser
  emergência, Críticos e Atrasados sempre globais (sem filtro/busca), e só a
  lista de cards respeitando o filtro.

### S7. [Baixa-média] Faixa "MUITOS PEDIDOS CRÍTICOS" pode ficar ligada o dia inteiro por causa do Shopee/ML geral

- **Onde**: `document.body.classList.toggle('emergencia', criticos > 5)`
  (`:823`). Críticos = zona vermelha (< 2h) ou atrasado, de **qualquer** tipo.
- **O que acontece**: pedido Shopee geral sem `prazo_entrega` usa o prazo
  sintético de 24h (decisão registrada) e, passadas 24h desde a criação, vira
  "ATRASADO" e conta como crítico. Também vai para o **topo** da lista
  (ordenação por `msRestante`), à frente de FLEX atrasado de verdade (primeiro
  card do screenshot 01). Com o volume do Shopee geral, a faixa vermelha piscando
  pode virar ruído permanente, e o time para de reagir a ela. O código diz que
  "sem prazo" deve ser raro (pedido antigo sem o campo coletado). Vale conferir
  em produção quantos são.
- **Sugestão**: limiar de emergência só com FLEX/TURBO/AGORA, ou ordenar os
  "geral" sem prazo real depois dos tipos com prazo real.

### S8. [Baixa] Som e voz disparam para Shopee/ML geral mesmo com o bloco oculto, e podem enfileirar muitas falas

- **Onde**: `detectarEventosSonoros()` (`:660`) roda sobre todos os cards, sem
  olhar `mostrarShopeeTodos`/`mostrarMlTodos`. `falar()` chama
  `speechSynthesis.speak` uma vez por pedido novo.
- **O que acontece**: (a) com "Shopee geral: oculto", a TV continua falando
  "Novo pedido Shopee". (b) A coleta da Shopee geral roda a cada 15 min, então
  uma leva de 20 pedidos novos vira 20 "Novo pedido Shopee." seguidos na fila de
  voz (e 20 bipes sobrepostos). Do mesmo jeito, vários cards mudando de zona no
  mesmo ciclo disparam vários `somCritico()` ao mesmo tempo. (c) Pedido AGORA é
  anunciado como "Turbo".
- **Sugestão**: pular som/voz para tipos ocultos. Agrupar por ciclo ("5 pedidos
  novos: 1 Flex, 4 Shopee"), um som por tipo de evento por ciclo e "Agora" no
  texto.

### S9. [Baixa] Sem proteção contra fetch pendurado nem respostas fora de ordem

- **Onde**: `setInterval(buscarDados, INTERVALO_BUSCA_MS)` (`:882`), `fetch`
  sem timeout.
- **O que acontece**: em 10h simuladas com API normal foram exatamente 1801
  chamadas (1 a cada 20 s, sem acumular) e o DOM ficou estável (293 → 305
  nós; a variação vem só de cards mudando de estado). Ou seja, **não** encontrei
  vazamento de memória nem timer acumulando. Mas se a API demorar mais de 20 s
  (cold start ou Turso lento), o próximo `setInterval` dispara outra busca em
  paralelo. Uma resposta antiga pode chegar depois de uma nova e sobrescrevê-la,
  e `detectarEventosSonoros` pode tocar o mesmo evento duas vezes.
- **Sugestão**: flag `buscando` (pula o ciclo se ainda tem um em andamento) e
  `AbortController` com timeout de ~15 s. Isso **reduz** chamadas, nunca aumenta.

### S10. [Baixa] "Coletados hoje" e relógio usam o fuso do navegador, o resto usa Brasília

- **Onde**: `new Date().toDateString()` em `renderizarCards()` (`:776`) e
  `atualizarRelogio()`. `ehHojeBrasil`/`calcularHoraColeta` usam
  `America/Sao_Paulo` explicitamente.
- **O que acontece**: hoje a TV está no Brasil, então não muda nada. Se o
  Windows da TV ficar com fuso errado (já acontece em PC reinstalado), o relógio
  e a virada de "Coletados hoje" ficam errados enquanto as cores continuam
  certas.
- **Sugestão**: usar o mesmo `Intl.DateTimeFormat(..., { timeZone: 'America/Sao_Paulo' })`.

### S11. [Baixa] Primeiro pedido do dia não toca som se a TV abriu sem nenhum card

- **Onde**: `detectarEventosSonoros()`,
  `if (Object.keys(estadoAnterior).length > 0)` (`:668`).
- **O que acontece**: a proteção para "não tocar tudo no primeiro load" usa
  "o estado anterior tem algum card?". Se a TV abre (ou recarrega pelo
  `vigiar_painel_tv.bat`) num momento sem nenhum card, nem aberto nem coletado
  hoje, os pedidos novos da leva seguinte são tratados como "primeiro load" e
  não tocam.
- **Sugestão**: usar uma flag `primeiraCargaFeita` em vez de contar chaves.

### S12. [Baixa, visual] Detalhes de layout

- `.btn-icone { margin-left: auto }` (`:109`) está em **todos** os 4 botões, e
  cada um empurra o próximo. Por isso os botões ficam espalhados pela barra
  (Som no meio, ML geral no canto) em vez de agrupados à direita. Em 1366 o
  "ML geral" vai para uma segunda linha sozinho. Bastaria `margin-left: auto` só
  no primeiro (`#btnSom`).
- `.kpi-destaque` tem borda de 2px que os outros KPIs não têm, então o bloco
  "Atraso total" fica ~4px mais alto e desalinhado da faixa
  (`01-normal-1920x1080.png`, canto direito). `box-sizing` já é border-box,
  então dá para usar `outline`/`box-shadow: inset` no lugar de `border`.
- `body.emergencia` pinta só a altura da viewport (`html, body { height: 100% }`).
  Ao rolar, o fundo abaixo da primeira tela volta ao normal. Na TV sem rolagem
  não aparece.
- `novo-flash` usa a propriedade `animation` e, por 2,4 s, substitui a
  animação `piscaCard` de um card vermelho/atrasado novo. Além disso,
  `_flashNovo` fica no objeto do card até a próxima busca, então qualquer
  re-render nesse intervalo (filtro, busca, toggle) faz o flash piscar de novo.
- Subtítulo "Flex e Turbo" e `<title>` "Expedicao" (sem acento) não citam
  Shopee/ML geral.

### S13. [Nit] Comentários desatualizados ("30 dias")

`public/tv.html:356`, `:425` e `:652` ainda falam em prazo sintético de 30 dias,
mas desde out/2026 ele é de 24h (Shopee) e "próximo 16h" (ML), como registrado no
CLAUDE.md e no próprio código logo abaixo. Só documentação, não afeta
comportamento.

---

## O que foi verificado e está OK

- **Contagem regressiva**: valores corretos para todos os tipos (ex.: Flex com
  prazo daqui a 50 min → `00:49:58`; atrasado de 40 min → `-00:40:01`; prazo
  amanhã → `1d 01:59:58`). Atualiza a cada 1 s só no texto, sem re-render.
- **Ordenação**: estritamente por `msRestante` crescente (atrasados no topo e
  `dia-seguinte` no fim), como esperado.
- **Cores por zona**: < 2h vermelho, < 3h laranja, hoje amarelo, amanhã verde,
  vencido "preto" (vermelho piscante + "🔴 ATRASADO"). Bate com `zonaPorPrazo`.
- **ML geral sem prazo** → próximo 16h de Brasília (às 10:30 = `05:29:58`
  amarelo). **Shopee geral sem prazo** → criação + 24h. **diaSeguinte** não se
  aplica a `semPrazo`. Tudo conforme o CLAUDE.md.
- **Coletados hoje**: coletado, entregue e não entregue aparecem; cancelado não
  aparece em nenhuma das duas seções (também excluído dos KPIs, conforme a 10ª
  rodada do CLAUDE.md).
- **Listas vazias**: mensagens de vazio nas duas seções, KPIs em 0 e "Atraso
  total" em "-" (screenshot 03).
- **API 500 e fora do ar**: mantém os últimos cards e o ponto fica vermelho com
  "erro ao atualizar" (comportamento que já existia, screenshot 05).
- **Longa duração** (10h simuladas com relógio falso): 1801 chamadas (exatamente
  1 a cada 20 s), nenhum `pageerror`, DOM estável, sem timers acumulando. Os
  `setTimeout` de som e de flash são de vida curta e os osciladores param
  sozinhos (`osc.stop`).
- Sem rolagem horizontal em 1920x1080 nem em 1366x768. Textos longos de SKU e
  título truncam com reticências dentro do card, sem sobreposição.

## O que não foi tocado

- `api/dashboard-data.js`: nenhuma mudança (precisa continuar com CPU quase
  zero).
- Frequência de chamadas: continua 20 s (`INTERVALO_BUSCA_MS`).
- Nenhuma mudança visual ou de comportamento além das duas correções acima.
