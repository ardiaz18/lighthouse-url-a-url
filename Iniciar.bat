@echo off
title Technical SEO Report
cd /d "%~dp0"
if not defined PORT set PORT=4173
set URL=http://127.0.0.1:%PORT%

rem 1. Node.js instalado y en versi¢n compatible
where node >nul 2>nul
if errorlevel 1 (
  echo No se encuentra Node.js.
  echo Inst lalo desde https://nodejs.org ^(versi¢n LTS^) y vuelve a abrir este archivo.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)"
if errorlevel 1 (
  echo Tu versi¢n de Node.js es antigua. Instala la versi¢n LTS desde https://nodejs.org y vuelve a abrir este archivo.
  start "" https://nodejs.org
  pause
  exit /b 1
)

rem 2. Si ya est  en marcha, solo abre el navegador
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo La herramienta ya est  en marcha.
  if not defined NO_ABRIR start "" %URL%
  exit /b 0
)

rem 3. Instala o actualiza las dependencias cuando haga falta
node -e "const fs=require('fs');const s=f=>fs.statSync(f,{throwIfNoEntry:false})?.mtimeMs||0;process.exit(s('package-lock.json')>s('node_modules/.package-lock.json')?1:0)"
if errorlevel 1 (
  echo Instalando lo necesario. La primera vez tarda unos minutos...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo No se pudo completar la instalaci¢n. Revisa tu conexi¢n a Internet y vuelve a intentarlo.
    pause
    exit /b 1
  )
)

rem 4. Arranca y abre el navegador
echo.
echo Technical SEO Report: %URL%
echo Deja esta ventana abierta mientras uses la herramienta. Para cerrarla, cierra la ventana.
echo.
if not defined NO_ABRIR start "" cmd /c "timeout /t 2 >nul & start "" %URL%"
node src/server.mjs
pause
