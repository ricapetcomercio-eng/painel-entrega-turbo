# Fechamento Mensal → painel ricapetadministrativo

Leva o fechamento do mês (planilha Excel gerada pelo sistema em
`C:\FECHAMENTO`) para a aba **Fechamento Mensal** do painel
(`https://ricapetadministrativo.vercel.app/fechamento.html`).

O script lê só os valores já calculados da planilha e manda para o painel.
Ele **não altera a planilha** e **não envia** a coluna OBS dos lançamentos.
Qualquer número com cara de CPF/CNPJ também é apagado dos textos antes do envio.

## Instalação (uma vez só)

1. **Python**: se ainda não tiver, instale pelo site python.org (marque
   "Add python.exe to PATH" na instalação).
2. **openpyxl**: abra o Prompt de Comando e rode:
   ```
   py -m pip install openpyxl
   ```
   (`requests` é opcional; o script funciona sem ele.)
3. Crie a pasta `C:\FECHAMENTO\painel` e copie para ela o arquivo
   `enviar_fechamento.py`.
4. Copie `painel_config.exemplo.ini` para `C:\FECHAMENTO\painel_config.ini`,
   abra no Bloco de Notas e preencha:
   - `secret` = o mesmo valor do `CRON_SECRET` da Vercel (o mesmo que já
     está no cron-job.org);
   - `pasta` / `padrao`: já vêm prontos para o padrão
     `C:\FECHAMENTO\05 FECHAMENTOS\AAAA_MM\Fechamento_<Mês>_<AA>.xlsx`.
     O script entra sozinho na subpasta `AAAA_MM` mais recente (ex.:
     `2026_09`) e pega o `Fechamento_*.xlsx` de dentro dela. Para usar outra
     planilha, passe `--arquivo "caminho\do\arquivo.xlsx"`.
5. Copie `99_enviar_painel.bat` para `C:\FECHAMENTO\01 EXECUTAR`. O número
   99 no nome é para ele ficar por último, depois dos outros arquivos.
6. Mande o histórico uma vez, para o painel já ter comparação mês a mês.
   No Prompt de Comando:
   ```
   "C:\FECHAMENTO\01 EXECUTAR\99_enviar_painel.bat" --todos
   ```
7. No painel, em **Acessos**, marque "Fechamento Mensal" para quem pode ver
   a tela (você, como super admin, já vê tudo).

## Uso no dia a dia

Rode o fechamento normalmente. No fim, dê dois cliques em
`99_enviar_painel.bat`. Ele envia o mês mais recente da planilha e mostra
um resumo (faturamento, lucro líquido e quantos lançamentos foram enviados).

Outras opções (pelo Prompt de Comando):

| Comando | O que faz |
|---|---|
| `99_enviar_painel.bat` | envia o mês mais recente |
| `99_enviar_painel.bat --mes "26 - Agosto"` | envia (ou reenvia) um mês específico |
| `99_enviar_painel.bat --todos` | envia todos os meses da planilha |
| `99_enviar_painel.bat --simular` | só lê a planilha e mostra o resumo, sem enviar |
| `99_enviar_painel.bat --diagnostico` | mostra onde achou cada rótulo da planilha e o tipo das células ao lado (número, texto, fórmula sem valor), **sem mostrar valores** e sem enviar nada |
| `99_enviar_painel.bat --arquivo "C:\caminho\arquivo.xlsx"` | usa outra planilha |

Reenviar um mês substitui a versão anterior dele no painel.

## Mensagens de erro comuns

- **"Nao achei o valor de ..."**: a planilha está num formato um pouco
  diferente do esperado. Rode `99_enviar_painel.bat --diagnostico` e mande
  o print da janela para ajustar o script (o diagnóstico não mostra valores).

- **"formulas SEM valor calculado"**: a planilha foi salva por um programa e
  não pelo Excel, então as fórmulas ainda não têm resultado. Abra o arquivo
  no Excel, aperte Ctrl+S e rode de novo.
- **"O painel recusou o segredo (401)"**: o `secret` do
  `painel_config.ini` não bate com o `CRON_SECRET` da Vercel.
- **"Nenhuma planilha encontrada"**: confira `pasta` e `padrao` no
  `painel_config.ini`.
- **"PULADO (layout antigo...)"** no `--todos`: abas antigas (antes de 2025)
  têm outro formato. Elas são puladas e os outros meses são enviados mesmo assim.

## Formato do envio (para o futuro servidor)

O envio é um `POST` com JSON (`{ "fechamento": { "mes": "AAAA-MM", ... } }`)
para `/api/debug?tipo=fechamento-enviar&secret=CRON_SECRET`. A rota não sabe
nem precisa saber de onde ele vem: se um dia o fechamento rodar num servidor
web, basta esse servidor montar o mesmo JSON (pode até reaproveitar
`montar_fechamento` deste script) e mandar para a mesma rota. O campo
`origem` só registra quem enviou (`script-local` hoje; dá para mudar com a
variável de ambiente `PAINEL_ORIGEM`).

## Como o script lê a planilha

Ele procura os blocos pelos **rótulos**, não por posição fixa:
"Custos Mensais" (resumo), o cabeçalho "porcentagem / Meta / Resultado"
(metas), os nomes de canal (ML, SHOPEE…) nas colunas canal × categoria,
"Cor"/"Modelo" + "Unidades" (tabela de produtos), "REFERENCIA" +
"CATEGORIA" (lançamentos) e "Algo Errado"/"OK" (conferência). Assim, uma
coluna a mais ou a menos não quebra o envio.

## Teste sem dados reais

`exemplo/gerar_exemplo.py` gera uma planilha **100% inventada** com o mesmo
layout, para testar sem usar números de verdade:

```
python exemplo/gerar_exemplo.py
python enviar_fechamento.py --arquivo exemplo/Fechamento_Exemplo.xlsx --todos --simular
```
