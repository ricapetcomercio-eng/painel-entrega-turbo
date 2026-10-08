# Painel TV (`public/tv.html`) — identidade própria

A TV fica no galpão da expedição, é lida de 3 a 5 metros, por gente em
movimento, sem mouse nem teclado. Tudo aqui serve a uma pergunta: **"qual
pedido eu despacho agora?"**. Por isso ela tem regras diferentes das
páginas admin — não aplique o manual admin aqui, nem o contrário.

## Base

- Sempre tema escuro (fundo `--bg` #0a0d13, card `--card` #141925).
  Não tem botão de tema nem `tokens-admin.css` linkado como base de cor.
- Fontes: **Atkinson Hyperlegible** no texto (distingue 0/O, 1/l/I — ajuda
  a ler SKU) e **Barlow Condensed** nos números (contador, KPI, relógio).
- Texto secundário `--muted` #b9c1d0 (~9:1 sobre o card) — não escureça:
  cinza "elegante" some a 4 metros.
- Atualiza dados a cada 20s (`INTERVALO_BUSCA_MS`) e o relógio/contadores
  a cada 1s. Não aumente a frequência de busca: o endpoint é barato, mas
  o dado por trás só muda a cada 5 min (ver Restrição nº 1 no CLAUDE.md).

## Urgência por tempo até o prazo (`zonaPorPrazo`)

| Zona (nome interno) | Regra | Cor |
|---|---|---|
| `preto` = ATRASADO | prazo já passou | `--preto` #ff545c, fundo `--atrasado-fundo`, faixa `--atrasado-faixa` |
| `vermelho` | < 2h | `--vermelho` #ff7a45 (coral, não vermelho puro) |
| `laranja` | < 3h | `--laranja` #ffa53d |
| `amarelo` | vence hoje | `--amarelo` #ffd23f |
| `verde` | depois de hoje | `--verde` #2ee59d |
| `concluido` | coletado/entregue/cancelado | apagado |

Decisões do dono que não se desfazem sem ele pedir:
- **Atrasado sobressai mais que tudo** — vermelho cheio é reservado só
  para ele; nunca apagado/opaco, nem quando é de ontem (bug real #215).
- Todo card mostra **contagem regressiva**, nunca "há Xh" — inclusive os
  sem prazo real (Shopee/ML geral usam prazo sintético).
- Pedido de "dia seguinte" pode ficar mais apagado, **exceto** atrasado e
  os blocos "geral".

## Selos de canal

`--flex` azul, `--turbo` violeta, `--agora` rosa, `--shopee` laranja
(🛍️ SHOPEE), `--ml-geral` teal (📦 ML). Cada bloco tem seu botão de
mostrar/ocultar com estado em `localStorage` por tela.

## Ao mexer na TV

- Tamanho por distância: número principal grande o bastante para ler a
  5 m; use `clamp()` com `vw`/`vh` em vez de px fixo.
- Nada que dependa de hover ou clique para ser entendido.
- Cor nunca é o único sinal de urgência (texto "ATRASADO", ícone).
- Animação só para chamar atenção a algo novo/atrasado, discreta e
  respeitando `prefers-reduced-motion`. Pisca-pisca constante cansa e vira
  ruído em uma hora.
- Teste com muitos pedidos (40+) e com zero pedidos — os dois acontecem.
- O link da TV abre com `?token=` — nunca escreva o valor em texto.
