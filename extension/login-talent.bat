@echo off
REM ===================================================================
REM  login-talent.bat - Re-login del seat de LinkedIn Recruiter (/talent)
REM  con UN solo doble-click.
REM
REM  Hacelo en la sesion de Windows de linkedin-bot (pantalla fisica).
REM  Baja el daemon, libera el perfil, abre Chrome para que inicies sesion,
REM  y vuelve a levantar el daemon solo cuando cerras la ventana.
REM
REM  Necesita permisos de admin (para parar/arrancar la tarea programada),
REM  asi que pide UNA confirmacion de UAC ("Si") - sin password.
REM ===================================================================

REM Si no estamos elevados, relanzar este mismo .bat como admin (UAC).
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Public\extension\relogin-talent.ps1"
