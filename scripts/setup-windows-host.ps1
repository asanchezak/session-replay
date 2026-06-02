# setup-windows-host.ps1
#
# Pegar en PowerShell como Administrador. Hace todo lo necesario para
# dejar acceso SSH remoto listo en la computadora de Fernanda.
#
# Como abrir PowerShell como Admin:
#   Buscar "PowerShell" en el menu inicio -> clic derecho -> "Run as administrator"
#
# Que hace:
#   1. Habilita OpenSSH Server (built-in en Windows 10/11)
#   2. Crea el usuario linkedin-bot (estandar, sin admin)
#   3. Instala la llave SSH del operador (en ProgramData, via Match block)
#   4. Abre el firewall para SSH
#   5. Desactiva el sleep en corriente
#
# Notas de diseno (ver review en el historial del repo):
#   - Usa SIDs (no nombres de grupo) -> funciona en Windows en cualquier idioma.
#   - La llave va a C:\ProgramData\ssh\ (NO al perfil del usuario): el perfil
#     no existe hasta el primer login, y pre-crearlo rompe la creacion del
#     perfil real. El bloque "Match User" en sshd_config apunta sshd ahi.
#   - Encoding ASCII en la llave (UTF8 en PS 5.1 mete un BOM que rompe sshd).

$OPERATOR_PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK68p5exs0YyApot6IxtESO2bcBwEIjTbVFl2vvjDHvZ upsidefoods"
$BOT_USER = "linkedin-bot"
$ErrorActionPreference = "Stop"

function Step($n, $msg) {
    Write-Host ""
    Write-Host ("[{0}] PASO {1}/5: {2}" -f (Get-Date -Format "HH:mm:ss"), $n, $msg) -ForegroundColor Cyan
}
function Ok($msg)   { Write-Host ("    OK  {0}" -f $msg) -ForegroundColor Green }
function Info($msg) { Write-Host ("    ... {0}" -f $msg) -ForegroundColor Gray }
function Warn($msg) { Write-Host ("    /!\ {0}" -f $msg) -ForegroundColor Yellow }

Write-Host ""
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Setup del host LinkedIn Bot (Windows)" -ForegroundColor Cyan
Write-Host "  Hora de inicio: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

# ── Chequeo: corriendo como Administrador ─────────────────────────────────────
$isAdminSession = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdminSession) {
    Write-Host ""
    Write-Host "ERROR: Esta ventana NO esta corriendo como Administrador." -ForegroundColor Red
    Write-Host "Cerra esta ventana y abri PowerShell asi:" -ForegroundColor Red
    Write-Host "  Menu Inicio -> escribir 'PowerShell' -> clic DERECHO -> 'Ejecutar como administrador'" -ForegroundColor Yellow
    Write-Host ""
    return
}
Write-Host ""
Write-Host "OK Corriendo como Administrador" -ForegroundColor Green

# ── 1. OpenSSH Server ─────────────────────────────────────────────────────────
Step 1 "Habilitar OpenSSH Server"
Info "Verificando si ya esta instalado..."
$sshCapability = Get-WindowsCapability -Online -Name OpenSSH.Server*

if ($sshCapability.State -ne "Installed") {
    Write-Host ""
    Write-Host "    +-----------------------------------------------------------+" -ForegroundColor Yellow
    Write-Host "    |  ESTO TARDA 1-3 MINUTOS. Windows esta descargando e       |" -ForegroundColor Yellow
    Write-Host "    |  instalando un componente. NO cierres la ventana ni       |" -ForegroundColor Yellow
    Write-Host "    |  toques nada aunque parezca congelado. Es normal.         |" -ForegroundColor Yellow
    Write-Host "    +-----------------------------------------------------------+" -ForegroundColor Yellow
    Write-Host ""
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Info "Instalando OpenSSH Server... (inicio: $(Get-Date -Format 'HH:mm:ss'))"
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    $sw.Stop()
    Ok ("OpenSSH Server instalado en {0:N0} segundos" -f $sw.Elapsed.TotalSeconds)
} else {
    Ok "OpenSSH Server ya estaba instalado (se omite la descarga)"
}

Info "Iniciando el servicio sshd (esto genera la config por defecto)..."
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic
Ok "Servicio sshd corriendo y configurado para arrancar solo al prender la PC"

# ── 2. Crear usuario linkedin-bot ─────────────────────────────────────────────
Step 2 "Crear el usuario 'linkedin-bot'"
$existingUser = Get-LocalUser -Name $BOT_USER -ErrorAction SilentlyContinue
if ($existingUser) {
    Ok "El usuario '$BOT_USER' ya existe (se omite la creacion)"
} else {
    Write-Host ""
    Write-Host "    >>> AHORA TE VA A PEDIR UN PASSWORD <<<" -ForegroundColor Magenta
    Write-Host "    Escribilo y dale Enter. OJO: no se ve nada mientras lo tipeas" -ForegroundColor Magenta
    Write-Host "    (ni puntitos ni asteriscos). Es normal. Anota ese password." -ForegroundColor Magenta
    Write-Host ""
    $password = Read-Host "    Elegir password para linkedin-bot" -AsSecureString
    New-LocalUser -Name $BOT_USER -FullName "LinkedIn Bot" -Password $password -PasswordNeverExpires:$true | Out-Null
    Ok "Usuario '$BOT_USER' creado (estandar, sin permisos de admin)"
}

# Confirmar que no es admin. Usamos el SID del grupo (S-1-5-32-544) en vez del
# nombre, porque en Windows en espanol el grupo se llama "Administradores".
$isBotAdmin = $null
try {
    $adminGroup   = Get-LocalGroup -SID "S-1-5-32-544"
    $adminMembers = Get-LocalGroupMember -Group $adminGroup -ErrorAction SilentlyContinue
    $isBotAdmin   = $adminMembers | Where-Object { $_.Name -like "*\$BOT_USER" }
} catch { }
if ($isBotAdmin) {
    Warn "$BOT_USER esta en el grupo de administradores - revisar manualmente"
} else {
    Ok "Confirmado: '$BOT_USER' es usuario estandar (sin admin)"
}

# ── 3. Llave SSH del operador (en ProgramData, via Match block) ───────────────
Step 3 "Instalar la llave SSH (acceso por llave, sin password)"

$sshDataDir  = Join-Path $env:ProgramData "ssh"
$keyFile     = Join-Path $sshDataDir "authorized_keys_linkedinbot"
$sshdConfig  = Join-Path $sshDataDir "sshd_config"

Info "Escribiendo la llave en $keyFile (ASCII, sin BOM)..."
Set-Content -Path $keyFile -Value $OPERATOR_PUBKEY -Encoding ascii

Info "Ajustando permisos del archivo de llaves (solo SYSTEM + Administradores)..."
# sshd (corre como SYSTEM) exige que el archivo NO sea escribible por usuarios
# comunes. Le damos FullControl solo a SYSTEM (S-1-5-18) y Administradores
# (S-1-5-32-544), por SID para ser independiente del idioma de Windows.
$acl = Get-Acl $keyFile
$acl.SetAccessRuleProtection($true, $false)              # quitar herencia
@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
    $id   = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($id, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $keyFile -AclObject $acl
Ok "Llave instalada con permisos correctos"

Info "Apuntando sshd a esa llave para el usuario '$BOT_USER'..."
# Bloque Match: solo para linkedin-bot, sshd lee la llave de ProgramData en vez
# del perfil (~/.ssh) que no existe hasta el primer login interactivo.
$matchBlock = @"

Match User $BOT_USER
    AuthorizedKeysFile __PROGRAMDATA__/ssh/authorized_keys_linkedinbot
"@
if (-not (Select-String -Path $sshdConfig -Pattern "Match User $BOT_USER" -SimpleMatch -Quiet)) {
    Add-Content -Path $sshdConfig -Value $matchBlock -Encoding ascii
    Ok "Bloque Match agregado a sshd_config"
} else {
    Ok "El bloque Match ya existia en sshd_config"
}

Info "Reiniciando sshd para aplicar la configuracion..."
Restart-Service sshd
Ok "sshd reiniciado"

# ── 4. Firewall: permitir SSH (puerto 22) ────────────────────────────────────
Step 4 "Abrir el firewall para SSH (puerto 22)"
$fwRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    Info "Creando regla de firewall..."
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    Ok "Puerto 22 abierto en el firewall"
} else {
    Ok "La regla de firewall ya existia"
}

# ── 5. Power: no dormir cuando esta enchufada ────────────────────────────────
Step 5 "Desactivar el sleep cuando esta enchufada"
powercfg /change standby-timeout-ac 0   | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Ok "El sistema no se duerme estando en corriente (AC)"

# ── Resumen ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===================================================" -ForegroundColor Green
Write-Host "  SETUP COMPLETADO - $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Proximos pasos:" -ForegroundColor White
Write-Host ""
Write-Host "  1. Mandar la IP de Tailscale al operador:" -ForegroundColor White
Write-Host "     Clic en el icono de Tailscale en la barra de tareas (empieza con 100.)"
$tsIp = $null
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
    $tsIp = (tailscale ip -4 2>$null | Select-Object -First 1)
}
if ($tsIp) {
    Write-Host ("     >>> Tu IP de Tailscale es: {0} <<<" -f $tsIp) -ForegroundColor Magenta
} else {
    Write-Host "     (No pude leer la IP automaticamente - miralo en el icono de Tailscale)" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  2. El operador verifica con:" -ForegroundColor White
Write-Host "     ssh linkedin-bot@<IP-tailscale> whoami"
Write-Host "===================================================" -ForegroundColor Green
