@echo off
setlocal
chcp 65001 >nul
title Geraldo AI

echo ============================================
echo   Geraldo AI - Assistente Nordestino
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado no PATH.
    echo        Instale a partir de https://nodejs.org
    pause
    exit /b 1
)

if not exist node_modules (
    echo Primeira execucao: instalando dependencias...
    echo.
    call npm install
    if errorlevel 1 (
        echo [ERRO] Falha ao instalar dependencias. Rode "npm install" manualmente.
        pause
        exit /b 1
    )
)

if not exist backend\dist\index.js (
    echo Compilando o Geraldo (primeira vez)...
    echo.
    call npm run build
    if errorlevel 1 (
        echo [ERRO] Falha no build. Rode "npm run build" manualmente.
        pause
        exit /b 1
    )
)

echo Iniciando Geraldo em modo PRODUCAO (o que o atualizador troca):
echo   - Painel:  http://localhost:4820
echo   - API:     http://127.0.0.1:4820/api/health
echo   - Login inicial: senha "geraldo123" [TROQUE A SENHA na aba Configuracoes]
echo   - Dados ficam em %%APPDATA%%\Geraldo (banco, config, sessao, midia)
echo   - Modo dev (tsx, hot-reload): rode "npm run dev" no terminal
echo.
call npm run start

pause
endlocal
