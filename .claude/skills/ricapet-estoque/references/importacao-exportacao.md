# Importação, exportação, validações e erros

O que já existe, para reaproveitar o formato em vez de inventar outro.
Planilha que chega com formato diferente do daqui: **pergunte** antes de
adaptar o parser — uma coluna trocada de lugar vira estoque errado sem
erro nenhum.

## Entradas

### Relatórios de venda → tela de reposição (`estoque.html`, Passo 1)
- Dois `.xlsx` obrigatórios (ML e Shopee), lidos no navegador com SheetJS.
- Aba obrigatória: **`Base Final`** (nos dois).
- ML: descarta linha com `MANTER === 'Não'`; data em `Data da venda`
  ("D de mês de AAAA HH:MM"); linha sem data válida é descartada.
- Shopee: descarta `TOTAL UNIDADES <= 0`; data em `Data de criação do pedido`.
- Colunas usadas: `PRODUTO`, `COR`, `TAMANHO`, `TOTAL UNIDADES`, `Total (BRL)`.
- Só entram produtos de `TARGET_PRODUCTS`.
- Número inválido vira 0 (silencioso).
- Mensagens de erro existentes: 'Aba "Base Final" não encontrada no
  relatório do …', 'Nenhuma linha válida encontrada nos dois relatórios.',
  'Nenhum mês válido encontrado para os produtos selecionados.',
  'Erro ao processar: …'.

### Estoque Full (`estoque.html`, Passo 3)
- Dois `.xlsx`, aba **`Resumo Unificado`**; colunas localizadas pelo nome
  em maiúsculas: `PRODUTO`, `COR`, `TAMANHO`, `QUANTIDADE_TOTAL`
  (PRODUTO e QUANTIDADE_TOTAL obrigatórias).
- Soma ML+Shopee por produto/cor/tamanho e **substitui** o `full` da
  contagem (cria a combinação com próprio 0 se não existir).
- ❓ Sem filtro de produto e sem normalizar maiúsculas do tamanho.

### Tabela de SKU (`scripts/gerar_tabela_produtos.py`, roda no PC do dono)
- Ver `modelo-de-dados.md`. Colunas esperadas, na ordem: Código do
  anúncio, Número do produto, Número da variação, SKU, Título, PRODUTO,
  COR, TAMANHO, UNIDADE, CUSTO.

### Contagem digitada (`estoque-atualizar.html`)
- Inputs `type=number min=0`, lidos com `parseFloat(v) || 0`.
- ❓ Negativo não é bloqueado no JavaScript (`min=0` é só do HTML) e não
  há mensagem de validação.

### Saldo pela planilha (`importar-saldo-da-planilha`)
- Lê do Apps Script `json.linhas[]` com `produto, cor, medida, qtd`.
- ❓ Não valida produto/cor/medida contra o catálogo; `qtd` inválido → 0.

## Saídas

### CSV da contagem (`estoque-atualizar.html`)
- Separador `;`, BOM UTF-8, CRLF, decimal com vírgula.
- Nome: `estoque-ricapet-AAAA-MM-DD.csv`.
- Colunas: Produto, Cor, Tamanho, Estoque Próprio, Estoque Full, Estoque
  Total, Preço Unitário (R$), Valor Total (R$), Atualizado em.
- Valor total = preço × (próprio + full). Rolo sai sem preço.
- Preços vêm de `PRICE_TABLE` (fonte não registrada ❓; muitos 0).

### Google Sheets — contagem (`estoque-sheets-log`)
- Linhas `{ produto, cor, medida ('ÚNICA' quando '-'), ricapet, full }`;
  rolo com `full: 0`.

### Google Sheets — balanço mensal
- Linhas `{ produto, cor, medida ('única' quando '-'), ricapet: saldo, full: 0 }`
  + `data` ISO.

**Padrão a seguir em exportação nova**: CSV com `;`, BOM, decimal com
vírgula, datas DD/MM/AAAA, nome com a data no fim — é o que abre direto no
Excel em português sem configurar nada.

## Tratamento de erros — o padrão desejável vs. o que existe

Hoje vários pontos **engolem erro em silêncio** (`estoque-contagem-get`
devolve `record: null` em qualquer falha; número inválido vira 0). Em
código novo:
- Erro que muda número de estoque nunca é silencioso: mostre/registre o
  quê, onde (produto/cor/tamanho, linha da planilha) e o que fazer.
- Linha de planilha inválida: rejeite a linha, conte e liste as
  rejeitadas no final ("12 linhas ignoradas: …"), nunca transforme em 0
  sem avisar.
- Antes de **sobrescrever** estoque (importar contagem/planilha), mostre
  um resumo do que vai mudar e peça confirmação.
- Não mude o comportamento silencioso das rotas existentes sem perguntar
  — as telas atuais dependem dele.
