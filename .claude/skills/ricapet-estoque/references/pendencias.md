# Pendências — regras que precisam de decisão do dono

Nada aqui deve ser "corrigido" por conta própria. Se a tarefa esbarrar
num destes itens, use o modelo de pergunta do SKILL.md. Quando o dono
decidir, mova a regra para ✅ em `regras.md` e risque o item aqui.

Levantado em out/2026 lendo o código.

## Afetam o número do saldo
1. **Kit/par baixa 1 unidade.** _(Em andamento: PR #279 — o agente de
   Estoque relata que o Ricardo confirmou a coluna UNIDADE da
   TABELA_AUXILIAR como nº de peças e "SKU terminado em D/E = Lado
   Direito/Esquerdo". Só mova para ✅ quando o PR for mergeado; o "_Par"
   do Arranhador de Braço continua em aberto lá.)_
   Situação atual: SKUs como `(G)ArranhadorBraco_Azul_Par`,
   `(G)Carpete_Bege-Kit2`, `AreiaMandioca_KIT5` apontam para o produto
   unitário, sem multiplicador. Vender 1 par baixa 1, não 2. Decidir: a
   tabela de SKU deve ganhar uma coluna de multiplicador? (custo do Par na
   tabela já é o dobro do unitário, o que sugere que é 2.)
2. **Nomes do catálogo × tabela de SKU divergem.** Só 27 dos 68 produtos
   da tabela têm o mesmo nome no `catalog.json` (ex.: tabela "Arranhador
   de Braço", catálogo "Arranhador de Braço Lado Direito/Esquerdo";
   tabela "Casinha 04", catálogo "Casinha 04 Sem Carpete"); tamanhos
   diferem em maiúscula (`200x50` × `200X50`). Resultado: a venda baixa
   numa linha e a contagem grava em outra. Decidir qual nome é o oficial.
   (`scripts/conferir_catalogo.py` lista os casos.)
3. **Saldo negativo** é permitido. Desejado (alerta de contagem velha) ou
   deveria travar/avisar?
4. **Devolução devolve o estoque na abertura**, não no recebimento físico,
   e mesmo se o vendedor ganhar a disputa.
5. **Cancelamento**: ML `invalid` e Shopee `IN_CANCEL` não estornam; Shopee
   `UNPAID` baixa.
6. **Pedido misto** (SKU mapeado + não mapeado) nunca baixa o não mapeado,
   mesmo depois de mapear o SKU.
7. **Backfill ML** não marca cancelado — pode baixar estoque de pedido
   cancelado.
8. **Duas fontes de saldo inicial** (JSONBin e aba "Estoque Ricapet");
   qual vence quando divergem?
9. **Full fora do saldo automático** (balanço sempre `full: 0`). É de
   propósito?

## Afetam a compra (tela de reposição)
10. **Todo mês = 30 dias** no consumo diário.
11. **Lead time 15 dias** como padrão — de onde veio? Igual para todas as
    cores/fornecedores?
12. **Sem estoque de segurança, mínimo ou arredondamento para rolo
    inteiro.** A quantidade a comprar sai em m² quebrados.
13. **Badge amarelo com 7 dias** antes do "comprar até".
14. **"Dias desde a contagem"** usa a última edição de qualquer célula,
    não a data da contagem daquela cor/tamanho.
15. **Área por peça** (`FIXED_AREA_PER_UNIT`): "tabela informada", sem
    fonte registrada.
16. **Cores de rolo divergem**: `estoque.html` tem Chumbo, a tela mobile
    não.
17. **Visão geral soma m² com unidades** para ordenar.
18. **Exclusão fixa Degrau/Grafite/P** — ainda necessária?
19. **Vendas da aba Desempenho incluem cancelados/devolvidos** — não usar
    como consumo sem decidir.

## Operação, segurança e consistência
20. **Mês do balanço em UTC** (pode virar o mês entre 21h e 23h59 do dia
    30/31 em Brasília).
21. **Rotas de escrita de estoque só pedem o segredo**, sem sessão
    (`importar-contagem-fisica`, `importar-saldo-da-planilha`,
    `completar-catalogo-faltante`, `corrigir-cor-...`), e o segredo está
    escrito em páginas públicas (`estoque-saldo.html`,
    `estoque-atualizar.html`). Qualquer pessoa com o link consegue
    zerar o saldo. Pedir ao dono: trocar o segredo e exigir sessão.
22. **`estoque-contagem-set` sem validação** — corpo vazio apaga a contagem.
23. **Sem rotina de recálculo do saldo** a partir de `estoque_baixas`
    (comentário diz que "pode ser recalculado", mas não existe).
24. **Sincronia `CATALOG` → `catalog.json`** é manual e o script gerador
    só existe no repo antigo desligado.
25. **`PRICE_TABLE`** (preços da exportação) sem fonte e com muitos zeros.
26. **Arquitetura do catálogo único** (uma fonte alimentando Painel de
    Estoque e outros sistemas): proposta pelo Ricardo, **não decidida**.
    Não consolidar até ele escolher.
27. **Segredo do JSONBin exposto no repo legado (público)**
    `painel-estoque-adesivo`. Só o Ricardo pode trocar a chave; depois de
    trocada, atualizar a variável `JSONBIN_ESTOQUE_API_KEY` na Vercel. Não
    copie a chave para lugar nenhum.
