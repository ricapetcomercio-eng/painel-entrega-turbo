@echo off
REM Envia o fechamento do mes mais recente para o painel ricapetadministrativo
REM (aba "Fechamento Mensal"). Coloque este arquivo em C:\FECHAMENTO\01 EXECUTAR
REM para rodar DEPOIS dos outros arquivos do fechamento.
REM Para mandar todo o historico: 99_enviar_painel.bat --todos
REM Para um mes especifico:      99_enviar_painel.bat --mes "26 - Agosto"
chcp 65001 >nul
set SCRIPT=C:\FECHAMENTO\painel\enviar_fechamento.py
where py >nul 2>nul
if %ERRORLEVEL%==0 (
  py "%SCRIPT%" %*
) else (
  python "%SCRIPT%" %*
)
echo.
pause
