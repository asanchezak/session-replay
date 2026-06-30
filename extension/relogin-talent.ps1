# =====================================================================
#  relogin-talent.ps1 - One-click re-login of the LinkedIn Recruiter
#  (/talent) seat on Fernanda's Windows host.
#
#  Run by login-talent.bat (which self-elevates). Encodes the proven
#  stop -> human login -> restart sequence from
#  docs/PROMPT-restart-and-relogin.md so the operator only has to sign in.
#
#  Sequence:
#    1) DISABLE + stop the daemon task and kill its node/Chrome so the
#       .linkedin-profile lock is released (otherwise login-talent.mjs
#       throws "Failed to create a ProcessSingleton").
#    2) Run login-talent.mjs - visible Chrome, the human signs in to
#       Talent/Recruiter and picks the Morsoft contract; it auto-closes
#       on a real /talent/ page. This step BLOCKS until the window closes.
#    3) ENABLE + start the daemon task again - it reopens the profile and
#       its keepalive grabs the fresh, warm seat.
#
#  The login (the sensitive password) is never automated.
# =====================================================================

$ErrorActionPreference = 'Continue'
$ext        = 'C:\Users\Public\extension'
$profileDir = Join-Path $ext '.linkedin-profile'
$node       = 'C:\Program Files\nodejs\node.exe'
$task       = 'linkedin-bot-daemon'

function Line($m) { Write-Host ('-' * 4) $m }
function ProfileChrome { Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*linkedin-profile*' } }
function DaemonNode    { Get-CimInstance Win32_Process -Filter "Name='node.exe'"   -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*driver-daemon*' } }
function DaemonWrapper { Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*daemon-task*' } }

Write-Host ''
Write-Host ('=' * 70)
Write-Host ' Re-login del seat de LinkedIn Recruiter (/talent)'
Write-Host ('=' * 70)

# --- 1) Bajar el daemon y liberar el lock del perfil --------------------
Line 'Paso 1/3 - Bajando el daemon y liberando el perfil...'

# DISABLE primero: el task tiene restart-on-fail (999x/1min). Si no lo
# deshabilitamos, el daemon revive a mitad del login y vuelve a tomar el lock.
try { Disable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null; Line "  task '$task' deshabilitado" }
catch { Line "  (no se pudo deshabilitar el task: $($_.Exception.Message))" }
try { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null } catch {}

# Matar (en cada vuelta) el node del daemon PRIMERO (para que no reabra Chrome),
# luego el wrapper powershell fantasma, luego TODO Chrome sobre el perfil - y NO
# seguir hasta CONFIRMAR que el perfil quedo libre. Un sleep fijo no alcanza: a
# veces un chrome sobrevive el tiempo de espera y el login choca con ProcessSingleton.
$free = $false
for ($i = 1; $i -le 10; $i++) {
  DaemonNode    | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  DaemonWrapper | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  ProfileChrome | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  Start-Sleep -Milliseconds 800
  $pc = (ProfileChrome | Measure-Object).Count
  $dn = (DaemonNode    | Measure-Object).Count
  if ($pc -eq 0 -and $dn -eq 0) { $free = $true; Line "  perfil libre (vuelta $i)"; break }
  Line "  esperando cierre... (vuelta ${i}: chrome=$pc node=$dn)"
}

# Borrar locks Singleton viejos (seguro extra contra ProcessSingleton).
Get-ChildItem -Path (Join-Path $profileDir 'Singleton*') -Force -ErrorAction SilentlyContinue |
  ForEach-Object { try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {} }
Line '  locks Singleton del perfil limpiados'

if (-not $free) {
  Write-Host ''
  Write-Host 'ERROR: no se pudo liberar el perfil de Chrome (sigue habiendo un proceso).'
  Write-Host 'Cerra cualquier Chrome abierto y volve a correr este .bat.'
  # Re-habilitar la task para no dejar el daemon caido.
  try { Enable-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null; Start-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue | Out-Null } catch {}
  Read-Host 'Enter para salir'
  exit 1
}

# --- 2) Login interactivo (HUMANO) -------------------------------------
Write-Host ''
Line 'Paso 2/3 - Abriendo Chrome para iniciar sesion...'
Write-Host '       > Inicia sesion en LinkedIn Talent / Recruiter.'
Write-Host '       > Si aparece el selector de contrato, elegi Morsoft SRL - Recruiter.'
Write-Host '       > La ventana se cierra sola cuando entras a /talent/. (No la cierres a mano salvo que se quede pegada.)'
Write-Host ''

if (-not (Test-Path $node)) { Write-Host "ERROR: no existe node en $node"; Read-Host 'Enter para salir'; exit 1 }
Push-Location $ext
& $node (Join-Path $ext 'login-talent.mjs')
$loginExit = $LASTEXITCODE
Pop-Location
Line "  login-talent.mjs termino (exit=$loginExit)"

# --- 3) Volver a levantar el daemon ------------------------------------
Write-Host ''
Line 'Paso 3/3 - Levantando el daemon de nuevo...'
try { Enable-ScheduledTask -TaskName $task -ErrorAction Stop | Out-Null } catch { Line "  (enable: $($_.Exception.Message))" }
try { Start-ScheduledTask  -TaskName $task -ErrorAction Stop | Out-Null; Line "  task '$task' arrancado" }
catch { Line "  (start: $($_.Exception.Message))" }

# Dar unos segundos y mostrar el estado del seat desde el log del keepalive.
Start-Sleep -Seconds 10
$state = (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue).State
Line "  estado del task: $state"
$log = Join-Path $ext 'daemon.task.log'
if (Test-Path $log) {
  $warm = Get-Content $log -Tail 60 -ErrorAction SilentlyContinue |
          Select-String 'keepalive|seat warm|WALLED' | Select-Object -Last 1
  if ($warm) { Line "  keepalive: $warm" }
}

Write-Host ''
Write-Host ('=' * 70)
if ($loginExit -eq 0) {
  Write-Host ' Listo. El daemon esta arriba con la sesion nueva.'
  Write-Host ' Quedate logueado como linkedin-bot unos minutos hasta que el seat caliente.'
} else {
  Write-Host ' ATENCION: el login no se completo (no llego a /talent/). Volve a correr el .bat.'
}
Write-Host ('=' * 70)
Read-Host 'Enter para cerrar esta ventana'
