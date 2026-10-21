@echo off
setlocal

rem ============================================================
rem  Sobe o static-pages localmente via docker compose.
rem  Uso: subir.bat [porta]      (padrao: HTTP_PORT do .env)
rem ============================================================

cd /d "%~dp0"

if not "%~1"=="" set "HTTP_PORT=%~1"

docker info >nul 2>&1
if errorlevel 1 (
    echo [erro] Docker nao esta rodando. Abra o Docker Desktop e tente de novo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [info] .env nao encontrado. Criando a partir de .env.example...
    copy /y ".env.example" ".env" >nul
)

rem [DESATIVADO] rede externa p/ o proxy Caddy (pasta proxy\):
rem docker network inspect web >nul 2>&1 || docker network create web >nul

echo [info] Build + subida via docker compose...
docker compose up -d --build
if errorlevel 1 (
    echo [erro] Falha ao subir.
    pause
    exit /b 1
)

echo.
echo ============================================================
docker compose port app 80
echo  Site:         http://localhost:^<porta acima^>/
echo  File Browser: http://localhost:^<porta acima^>/admin/
echo  Senha gerada (1o boot) aparece no log abaixo.
echo  Logs:   docker compose logs -f
echo  Parar:  docker compose down
echo ============================================================
echo.

timeout /t 3 /nobreak >nul
docker compose logs app

pause
endlocal
