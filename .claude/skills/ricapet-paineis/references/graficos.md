# Gráficos nos painéis Ricapet

## Antes: precisa mesmo de gráfico?

- 1 número → KPI, não gráfico.
- Poucos valores para comparar com precisão (≤ 6) → tabela ou barras
  horizontais simples em HTML/CSS (padrão `.barras` do Fechamento).
- Evolução no tempo → linha (ou barras se forem poucos períodos).
- Partes de um todo → barra empilhada 100% ou barras ordenadas. Evite
  pizza com mais de 3 fatias.

## Biblioteca

Chart.js 4 por CDN com versão fixa (o que já está no repo):
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
```
Plugin de rótulos, quando precisar:
`https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0`.
Não traga outra biblioteca de gráfico para uma página nova.

## Cores vêm dos tokens

```js
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
const SERIES = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'].map(cssVar);
```
- `--chart-1` (turquesa) é sempre a série principal.
- Dois lados comparados (Ricapet×Thapets, ML×Shopee): `--chart-1` e `--chart-2`, sempre na mesma ordem em todas as telas.
- Vermelho (`--danger`) só para série que é "ruim" por natureza (custo,
  atraso, devolução), não como 3ª cor qualquer.
- Grade/eixos: `--border` e `--text-secondary`.
- Leia as cores **na hora de desenhar** e redesenhe quando o tema mudar
  (o botão de tema troca `data-theme` no `<html>`) — senão o gráfico fica
  com as cores do tema anterior.

## Formatação

- Eixo e tooltip em pt-BR: `v.toLocaleString('pt-BR')`, moeda com
  `{ style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }` no
  eixo (sem centavos) e com centavos no tooltip.
- Datas no eixo como `dd/mm`; mês como `out/26`.
- Legenda só quando há 2+ séries; título do gráfico fica no `.card-head`,
  não dentro do canvas.
- `maintainAspectRatio: false` com altura fixa no container (220-300px),
  para o gráfico não "pular" quando a tela muda de tamanho.

## Acessibilidade

- `<canvas role="img" aria-label="Faturamento diário de outubro, pico de R$ 9.800 no dia 12">`.
- O número principal que o gráfico mostra também aparece em texto (KPI ou
  nota) — gráfico complementa, não é a única fonte.
- Séries distinguíveis sem cor quando possível (traço tracejado na série
  de comparação/meta).
