# setup-windows-host.ps1
#
# Pegar en PowerShell como Administrador. Hace todo lo necesario para
# dejar acceso SSH remoto listo en la computadora de Fernanda.
#
# Cómo abrir PowerShell como Admin:
#   Buscar "PowerShell" en el menú inicio → clic derecho → "Run as administrator"
#
# Qué hace:
#   1. Habilita OpenSSH Server (built-in en Windows 10/11)
#   2. Crea el usuario linkedin-bot (estándar, sin admin)
#   3. Instala la llave SSH del operador para ese usuario
#   4. Configura permisos correctos del archivo de llaves
#   5. Desactiva el sleep de sistema cuando está enchufada

$OPERATOR_PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK68p5exs0YyApot6IxtESO2bcBwEIjTbVFl2vvjDHvZ upsidefoods"
$BOT_USER = "linkedin-bot"

Write-Host ""
Write-Host "=== Setup del host LinkedIn Bot (Windows) ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. OpenSSH Server ─────────────────────────────────────────────────────────
Write-Host "-> Verificando OpenSSH Server..."
$sshCapability = Get-WindowsCapability -Online -Name OpenSSH.Server*
if ($sshCapability.State -ne "Installed") {
    Write-Host "   Instalando OpenSSH Server..."
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
} else {
    Write-Host "   OpenSSH Server ya instalado"
}

Write-Host "-> Iniciando y configurando servicio sshd..."
Start-Service sshd -ErrorAction SilentlyContinue
Set-Service -Name sshd -StartupType Automatic
Write-Host "OK OpenSSH Server corriendo y configurado para arrancar solo" -ForegroundColor Green

# ── 2. Crear usuario linkedin-bot ─────────────────────────────────────────────
Write-Host ""
$existingUser = Get-LocalUser -Name $BOT_USER -ErrorAction SilentlyContinue
if ($existingUser) {
    Write-Host "OK Usuario '$BOT_USER' ya existe - se omite la creacion" -ForegroundColor Green
} else {
    Write-Host "-> Creando usuario '$BOT_USER'..."
    $password = Read-Host "   Elegir password para linkedin-bot" -AsSecureString
    New-LocalUser -Name $BOT_USER -FullName "LinkedIn Bot" -Password $password -PasswordNeverExpires $true
    Write-Host "OK Usuario '$BOT_USER' creado (estandar, sin admin)" -ForegroundColor Green
}

# Confirmar que no es admin
$isAdmin = Get-LocalGroupMember -Group "Administrators" -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*$BOT_USER*" }
if ($isAdmin) {
    Write-Host "ADVERTENCIA: $BOT_USER tiene permisos de administrador - revisar manualmente" -ForegroundColor Yellow
}

# ── 3. Llave SSH del operador ─────────────────────────────────────────────────
Write-Host ""
Write-Host "-> Instalando llave SSH del operador en '$BOT_USER'..."

$botHome = "C:\Users\$BOT_USER"
$sshDir  = "$botHome\.ssh"
$authKeys = "$sshDir\authorized_keys"

# Crear el home si no existe (puede no existir hasta el primer login)
if (-not (Test-Path $botHome)) {
    New-Item -ItemType Directory -Path $botHome -Force | Out-Null
}
if (-not (Test-Path $sshDir)) {
    New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
}

Set-Content -Path $authKeys -Value $OPERATOR_PUBKEY -Encoding UTF8

# Permisos: solo linkedin-bot puede leer (Windows es estricto con esto)
$acl = Get-Acl $authKeys
$acl.SetAccessRuleProtection($true, $false)   # quitar herencia
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $BOT_USER, "FullControl", "Allow"
)
$acl.AddAccessRule($rule)
Set-Acl $authKeys $acl

Write-Host "OK Llave instalada en $authKeys" -ForegroundColor Green

# ── 4. Firewall: permitir SSH (puerto 22) ────────────────────────────────────
Write-Host ""
Write-Host "-> Configurando firewall para SSH..."
$fwRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" `
        -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}
Write-Host "OK Puerto 22 abierto en firewall" -ForegroundColor Green

# ── 5. Power: no dormir cuando esta enchufada ────────────────────────────────
Write-Host ""
Write-Host "-> Desactivando sleep de sistema cuando esta enchufada..."
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "OK Sistema no duerme en corriente (AC)" -ForegroundColor Green

# ── Resumen ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================" -ForegroundColor Cyan
Write-Host "  Setup completado. Proximos pasos:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1. Mandar la IP de Tailscale al operador:" -ForegroundColor White
Write-Host "     Clic en el icono de Tailscale en la barra de tareas"
Write-Host "     (la IP empieza con 100.)"
Write-Host "     O en PowerShell: tailscale ip" -ForegroundColor Gray
Write-Host ""
Write-Host "  2. El operador verifica con:" -ForegroundColor White
Write-Host "     ssh linkedin-bot@<IP-tailscale> whoami"
Write-Host "================================================" -ForegroundColor Cyan
