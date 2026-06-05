@echo off
REM ===================================================================
REM  Extrae las cookies de LinkedIn Recruiter de TU Chrome personal
REM  (el que tiene la sesion de Recruiter abierta) para pasarlas al bot.
REM
REM  HACELO EN LA SESION DE WINDOWS DE FERNANDA (no la del bot).
REM  Solo lee cookies: NO entra a ninguna cuenta ni hace clicks.
REM ===================================================================
echo.
echo Paso 1/3 - Cerrando Chrome para reabrirlo con depuracion...
taskkill /F /IM chrome.exe >nul 2>&1
timeout /t 3 /nobreak >nul

echo Paso 2/3 - Reabriendo TU Chrome (tu sesion de Recruiter se mantiene)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9333 --remote-allow-origins=* --restore-last-session
echo           Esperando a que Chrome cargue (10s)...
timeout /t 10 /nobreak >nul

echo Paso 3/3 - Extrayendo cookies de LinkedIn...
"C:\Program Files\nodejs\node.exe" "C:\Users\Public\extension\extract-talent-cookies.mjs"

echo.
echo ===================================================================
echo  Listo. Si arriba dice  li_a=true  la extraccion sirvio.
echo  Avisa a Andrey para que inyecte la sesion en el perfil del bot.
echo ===================================================================
pause
