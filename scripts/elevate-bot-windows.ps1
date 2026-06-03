# elevate-bot-windows.ps1
#
# Corre UNA vez en PowerShell COMO ADMINISTRADOR en la maquina del bot.
# Eleva al usuario 'linkedin-bot' a administrador para que las sesiones SSH
# entren con token elevado (high-integrity), permitiendo tareas admin remotas.
#
# ORDEN SEGURO (evita lockout): primero instala la llave del operador en el path
# de admin de OpenSSH (administrators_authorized_keys), DESPUES agrega al grupo.
# Asi, cuando OpenSSH cambie a leer la llave del path de admin, ya esta puesta.
#
# NOTA DE SEGURIDAD: esto le da permisos de admin a la cuenta del bot. Si la
# cuenta se compromete, el atacante tiene admin en esta PC. Decision consciente.

$OPERATOR_PUBKEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK68p5exs0YyApot6IxtESO2bcBwEIjTbVFl2vvjDHvZ upsidefoods"
$BOT_USER = "linkedin-bot"
$ErrorActionPreference = "Stop"

function Ok($m)   { Write-Host ("OK  {0}" -f $m) -ForegroundColor Green }
function Info($m) { Write-Host ("... {0}" -f $m) -ForegroundColor Gray }

# ── Chequeo admin ─────────────────────────────────────────────────────────────
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: abri PowerShell como Administrador (clic derecho -> Ejecutar como administrador)." -ForegroundColor Red
    return
}
Write-Host ""
Write-Host "=== Elevar '$BOT_USER' a administrador (con llave en path admin) ===" -ForegroundColor Cyan

# ── 1. Instalar la llave en administrators_authorized_keys (ANTES de elevar) ──
$adminKeys = Join-Path $env:ProgramData "ssh\administrators_authorized_keys"
Info "Asegurando la llave del operador en $adminKeys ..."

$existing = ""
if (Test-Path $adminKeys) { $existing = Get-Content $adminKeys -Raw -ErrorAction SilentlyContinue }
if ($existing -notmatch [regex]::Escape($OPERATOR_PUBKEY)) {
    Add-Content -Path $adminKeys -Value $OPERATOR_PUBKEY -Encoding ascii
    Ok "Llave agregada a administrators_authorized_keys"
} else {
    Ok "La llave ya estaba en administrators_authorized_keys"
}

# ACL requerida por OpenSSH para administrators_authorized_keys:
# solo SYSTEM (S-1-5-18) y Administradores (S-1-5-32-544). Por SID = locale-safe.
Info "Ajustando permisos de administrators_authorized_keys ..."
$acl = Get-Acl $adminKeys
$acl.SetAccessRuleProtection($true, $false)
@($acl.Access) | ForEach-Object { [void]$acl.RemoveAccessRule($_) }
foreach ($sid in @("S-1-5-18", "S-1-5-32-544")) {
    $id   = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($id, "FullControl", "Allow")
    $acl.AddAccessRule($rule)
}
Set-Acl -Path $adminKeys -AclObject $acl
Ok "Permisos correctos (solo SYSTEM + Administradores)"

# ── 2. Agregar linkedin-bot al grupo Administradores (por SID = locale-safe) ──
$adminGroup = Get-LocalGroup -SID "S-1-5-32-544"
$yaEsMiembro = Get-LocalGroupMember -Group $adminGroup -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*\$BOT_USER" }
if ($yaEsMiembro) {
    Ok "'$BOT_USER' ya estaba en el grupo Administradores"
} else {
    Add-LocalGroupMember -Group $adminGroup -Member $BOT_USER
    Ok "'$BOT_USER' agregado al grupo Administradores"
}

# ── 3. Reiniciar sshd para tomar la nueva config de token/llaves ─────────────
Info "Reiniciando sshd ..."
Restart-Service sshd
Ok "sshd reiniciado"

Write-Host ""
Write-Host "LISTO. La proxima sesion SSH de '$BOT_USER' deberia entrar ELEVADA." -ForegroundColor Green
Write-Host "El operador verifica con:  ssh $BOT_USER@<IP>  ->  whoami /groups (debe incluir S-1-16-12288 High)" -ForegroundColor White
