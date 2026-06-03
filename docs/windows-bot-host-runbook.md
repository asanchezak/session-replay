# Runbook operativo — Host del bot en Windows (máquina de Fernanda)

> **Qué es esto.** Cómo accedo (Claude/operador) a la máquina de Fernanda y todo
> lo necesario para operar el daemon de LinkedIn ahí. Es la **realidad de
> producción** del host del bot. El doc `docs/linkedin-bot-host-setup.md` quedó
> escrito para un host **Mac**; la máquina real de Fernanda es **Windows**, así que
> para su host **manda este documento**. Setup inicial: `scripts/setup-windows-host.ps1`
> (lo corrió Fernanda una vez) + `scripts/elevate-bot-windows.ps1` (elevó al bot a
> admin). Validado live el 2026-06-03.

---

## 0. La máquina

| Dato | Valor |
|---|---|
| Hostname / tailnet | `laptop-9d70426c` · dueño `fbenavides@` |
| **IP Tailscale** | **`100.107.206.110`** |
| OS | Windows 11 Home Single Language, build 26200 (25H2) |
| Arch | **x64 (AMD64)**, 8 cores, 15.4 GB RAM |
| GPU | **AMD Radeon integrada** (driver real) |
| Chrome | 148.x en `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Mac de Andrey (operador) | tailnet `100.100.20.99` (corre el backend) |

**Arquitectura:** el **daemon** corre en Windows (sesión no-interactiva, con GPU
real); el **backend + Postgres** corren en la Mac de Andrey y el daemon se conecta
por Tailscale (`BACKEND=http://100.100.20.99:8081`). El backend bindea `0.0.0.0:8081`.

---

## 1. Cómo accedo (SSH)

```bash
ssh linkedin-bot@100.107.206.110
```

- **Auth por llave**, sin password. Mi llave (`~/.ssh/id_ed25519` en la Mac de
  Andrey) está en `C:\ProgramData\ssh\administrators_authorized_keys` del host.
- **La sesión entra ELEVADA** (High integrity, token de admin) porque `linkedin-bot`
  es miembro del grupo Administradores (lo elevó `elevate-bot-windows.ps1`). Esto
  permite correr cmdlets admin (firewall, CIM, Set-Acl, scheduled tasks) por SSH.
- **Shell por defecto = `cmd.exe`.** Para PowerShell:
  `ssh ... "powershell -NoProfile -Command \"<comando>\""`.
- Solo alcanzable por **Tailscale** (esta Mac debe tener Tailscale up). El puerto 22
  no está expuesto a internet; el firewall lo permite solo en perfil Private (OK,
  Tailscale igual pasa).

### Gotcha de quoting (importante)
SSH → `cmd.exe` → PowerShell tiene 3 niveles de comillas. Para algo no trivial,
**escribir un `.ps1` localmente, copiarlo con `scp`, y correrlo**:
```bash
scp /tmp/foo.ps1 linkedin-bot@100.107.206.110:"C:/Users/Public/extension/"
ssh linkedin-bot@100.107.206.110 'powershell -ExecutionPolicy Bypass -File C:\Users\Public\extension\foo.ps1'
```
La sesión SSH **no hereda PATH de Node** → usar ruta completa
`"C:\Program Files\nodejs\node.exe"` / `npm.cmd`.

---

## 2. Dónde está todo en el host

| Cosa | Ruta |
|---|---|
| Código del daemon | `C:\Users\Public\extension\` (de `git archive HEAD extension`) |
| Daemon | `C:\Users\Public\extension\driver-daemon.mjs` |
| Perfil LinkedIn | `C:\Users\Public\extension\.linkedin-profile\` (lo crea el login) |
| Acción de la task | `C:\Users\Public\extension\daemon-task.ps1` (env + corre el daemon) |
| Log del daemon (task) | `C:\Users\Public\extension\daemon.task.log` |
| Launcher manual | `C:\Users\Public\extension\run-daemon.ps1` (Start-Process + muestra logs) |
| Capturas de debug | `C:\Users\Public\extension\.debug\<runId>\` |
| Diagnósticos GPU/fp | `C:\Users\Public\bottest\` (`gpu-test.mjs`, `fp-probe.mjs`) |
| Node | `C:\Program Files\nodejs\node.exe` (v24.16.0) |
| Mi llave SSH (admin) | `C:\ProgramData\ssh\administrators_authorized_keys` |

**Config del daemon** (env, seteado en `daemon-task.ps1`): `BACKEND=http://100.100.20.99:8081`,
`API_KEY=dev-api-key-change-in-production`, `VIEWPORT_WIDTH=1280` `VIEWPORT_HEIGHT=600`
(≤ screen 1280x720 → evita el tell viewport>screen), budgets QA
(`MAX_PROFILE_VIEWS_DAY=20`, `_HOUR=6`, `MAX_SEARCHES_DAY=10`, `MAX_PAGE_LOADS_DAY=150`).

---

## 3. El autostart (scheduled task)

- Task: **`linkedin-bot-daemon`** — trigger `AtStartup`, principal `linkedin-bot`
  **LogonType S4U (sin password) / RunLevel Highest**, restart-on-fail (999 ×, cada
  1 min), `ExecutionTimeLimit` ilimitado, `MultipleInstances=IgnoreNew`.
- **S4U tiene GPU** (verificado: 5/5 HARDWARE bajo la task) — no hace falta el
  password de Fernanda.
- **Estado actual: DISABLED** a propósito, hasta que exista `.linkedin-profile`
  (para que no agarre runs sin perfil y los pause). Activar tras el login:

```bash
ssh linkedin-bot@100.107.206.110 "powershell -NoProfile -Command \"Enable-ScheduledTask -TaskName 'linkedin-bot-daemon'; Start-ScheduledTask -TaskName 'linkedin-bot-daemon'\""
```

---

## 4. Operaciones comunes

**Ver workers/heartbeat (desde la Mac de Andrey):**
```bash
curl -s -H "X-API-Key: dev-api-key-change-in-production" http://localhost:8081/v1/daemon/status | python3 -m json.tool
# worker LAPTOP-9D70426C-* con up:true / polling:true = vivo
```

**Arrancar el daemon a mano (sin la task):**
```bash
ssh linkedin-bot@100.107.206.110 'powershell -ExecutionPolicy Bypass -File C:\Users\Public\extension\run-daemon.ps1'
```

**Parar el daemon:**
```bash
ssh linkedin-bot@100.107.206.110 "powershell -NoProfile -Command \"Stop-ScheduledTask -TaskName 'linkedin-bot-daemon'; Get-CimInstance Win32_Process -Filter \\\"Name='node.exe'\\\" | ? { \$_.CommandLine -like '*driver-daemon*' } | %% { Stop-Process -Id \$_.ProcessId -Force }\""
```
(o más simple, ver procesos: `ssh ... "tasklist /fi \"imagename eq node.exe\""`)

**Tail del log del daemon:**
```bash
ssh linkedin-bot@100.107.206.110 "powershell -NoProfile -Command \"Get-Content 'C:\Users\Public\extension\daemon.task.log' -Tail 30\""
```

**Desplegar código nuevo (un archivo):**
```bash
scp extension/driver-daemon.mjs linkedin-bot@100.107.206.110:"C:/Users/Public/extension/"
# luego reiniciar la task/daemon
```
Para el árbol completo: `git archive --format=tar.gz -o /tmp/ext.tar.gz HEAD extension`
→ `scp` a `C:/Users/Public/` → `ssh ... "cd /d C:\Users\Public && tar xzf ext.tar.gz"`
→ `npm install` (`set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

**Capturas de debug de un run colgado:**
```bash
curl -s -H "X-API-Key: dev-api-key-change-in-production" "http://localhost:8081/v1/runs/<RUN_ID>/events?event_type=debug" | python3 -m json.tool
```

**Test de GPU (confirmar fingerprint real cuando haga falta):**
```bash
ssh linkedin-bot@100.107.206.110 'cd /d C:\Users\Public\bottest && set ITERATIONS=5&& "C:\Program Files\nodejs\node.exe" gpu-test.mjs'
# espera: HARDWARE | renderer="ANGLE (AMD, AMD Radeon... Direct3D11)"
```

---

## 5. Gotchas / cosas a recordar

- **Hay 2 daemons** posibles contra el mismo backend (la Mac de Andrey + Windows).
  Antes de un E2E en Windows, **apagar el de la Mac** o compiten por el run.
- **GPU en Windows ≠ Mac:** acá Chrome obtiene GPU real (ANGLE/Direct3D11) **incluso
  en sesión no-interactiva** (S4U/session 0). NO hace falta Fast User Switching ni
  que Fernanda se loguee como el bot. (En Mac, sin GUI → SwiftShader software.)
- **Tell de fingerprint menor:** en sesión no-interactiva `screen`=1280x720 y
  `avail==screen` (sin monitor real). El vector fuerte (GPU/WebGL) es genuino.
  Mejora futura: subir la resolución de la sesión a 1920x1080.
- **Reinicio del daemon:** preferir Stop/Start de la task (no `taskkill` en seco que
  deje Chrome huérfano). El daemon tiene watchdog (`RUN_WATCHDOG_MS`, 240s) que
  captura y aborta limpio si un run se cuelga.
- **`linkedin-bot` es admin** (decisión consciente, tradeoff de seguridad: el bot
  scrapea con permisos de admin). Por eso la sesión SSH entra elevada.
- **Si me quedo sin SSH:** la llave está en `administrators_authorized_keys`. Si se
  rompe, Fernanda corre de nuevo `elevate-bot-windows.ps1` elevado (re-instala la
  llave). Tailscale debe estar up en ambos lados (arranca al login de Fernanda).

---

## 6. Pendiente (al 2026-06-03)

1. **Login de LinkedIn** (interactivo, Fernanda): correr
   `node login-linkedin.mjs` en una sesión interactiva visible, escanear QR /
   credenciales de la cuenta recruiter → crea `.linkedin-profile`. Única parte que
   necesita a Fernanda.
2. **Habilitar la task** (§3) una vez exista el perfil.
3. **E2E real:** apagar daemon de la Mac, disparar workflow en modo test, verificar
   scrape con GPU real → push de leads a Odoo (`is_test=true`), limpiar.
