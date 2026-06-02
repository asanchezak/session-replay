#!/usr/bin/env bash
# setup-fernanda-host.sh
#
# Pegar en la Terminal de Fernanda (como admin). Hace TODO lo necesario para
# dejar acceso SSH remoto listo. Solo se necesita correr UNA VEZ.
#
# Qué hace:
#   1. Crea el usuario macOS linkedin-bot (standard, sin admin)
#   2. Activa Fast User Switching
#   3. Fija sleep=0 cuando está enchufada
#   4. Habilita Remote Login (SSH)
#   5. Instala la llave SSH del operador en linkedin-bot
#   6. Activa Screen Sharing
#
# Al terminar: mandar la IP de Tailscale al operador (ícono Tailscale → menu bar).

set -euo pipefail

OPERATOR_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK68p5exs0YyApot6IxtESO2bcBwEIjTbVFl2vvjDHvZ upsidefoods"
BOT_USER="linkedin-bot"
BOT_FULLNAME="LinkedIn Bot"

echo ""
echo "=== Setup del host LinkedIn Bot ==="
echo ""

# ── 1. Crear usuario linkedin-bot ────────────────────────────────────────────
if dscl . -read /Users/$BOT_USER UniqueID &>/dev/null; then
    echo "✓ Usuario '$BOT_USER' ya existe — se omite la creación"
else
    echo "→ Creando usuario '$BOT_USER' (se pedirá password)..."
    sudo sysadminctl -addUser $BOT_USER -fullName "$BOT_FULLNAME" -password -
    echo "✓ Usuario '$BOT_USER' creado"
fi

# Verificar que es standard (no admin)
IS_ADMIN=$(dseditgroup -o checkmember -m $BOT_USER admin 2>&1 || true)
if echo "$IS_ADMIN" | grep -q "IS a member"; then
    echo "⚠  ADVERTENCIA: $BOT_USER tiene permisos admin — revisar manualmente"
else
    echo "✓ '$BOT_USER' es standard (sin admin)"
fi

# ── 2. Fast User Switching ────────────────────────────────────────────────────
echo "→ Activando Fast User Switching..."
sudo defaults write /Library/Preferences/.GlobalPreferences MultipleSessionEnabled -bool true
echo "✓ FUS activado (mostrar en menu bar: System Settings → Control Center → Fast User Switching)"

# ── 3. Sleep cuando está enchufada ───────────────────────────────────────────
echo "→ Desactivando system sleep en corriente..."
sudo pmset -c sleep 0
echo "✓ pmset -c sleep 0 (nunca duerme enchufada)"

# ── 4. Remote Login (SSH) ─────────────────────────────────────────────────────
echo "→ Habilitando Remote Login..."
sudo systemsetup -setremotelogin on 2>/dev/null || {
    echo "  ⚠  Necesita Full Disk Access. Habilitar manualmente:"
    echo "     System Settings → General → Sharing → Remote Login = ON"
}
# Dar acceso SSH al usuario bot
sudo dseditgroup -o edit -a $BOT_USER -t user com.apple.access_ssh 2>/dev/null || true
echo "✓ Remote Login habilitado para '$BOT_USER'"

# ── 5. Llave SSH del operador ─────────────────────────────────────────────────
echo "→ Instalando llave SSH del operador en '$BOT_USER'..."
sudo mkdir -p /Users/$BOT_USER/.ssh
echo "$OPERATOR_PUBKEY" | sudo tee /Users/$BOT_USER/.ssh/authorized_keys >/dev/null
sudo chown -R $BOT_USER:staff /Users/$BOT_USER/.ssh
sudo chmod 700 /Users/$BOT_USER/.ssh
sudo chmod 600 /Users/$BOT_USER/.ssh/authorized_keys
echo "✓ Llave instalada en /Users/$BOT_USER/.ssh/authorized_keys"

# ── 6. Screen Sharing ─────────────────────────────────────────────────────────
echo ""
echo "⚠  Screen Sharing NO se puede activar por terminal (macOS lo bloquea)."
echo "   Hacerlo manualmente: System Settings → General → Sharing → Screen Sharing = ON"

# ── Resumen final ─────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo "  Setup completado. Próximos pasos:"
echo ""
echo "  1. Screen Sharing (si lo necesitás):"
echo "     System Settings → General → Sharing → Screen Sharing = ON"
echo ""
echo "  2. Mandar la IP de Tailscale al operador:"
echo "     Clic en el ícono de Tailscale en el menu bar → la IP empieza con 100."
echo "     O en terminal: ifconfig utun$(ifconfig | grep -c utun || echo '?') 2>/dev/null || echo 'ver ícono Tailscale'"
echo ""
echo "  3. El operador verifica con:"
echo "     ssh linkedin-bot@<IP-tailscale> whoami"
echo "════════════════════════════════════════"
