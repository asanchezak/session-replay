# Runbook — Bot de LinkedIn en host dedicado (usuario en 2º plano)

> ⚠️ **DEPRECADO (2026-06-15).** Este doc es el setup **Mac-focused** original. El host de
> producción de Fernanda es **Windows** — usá **`docs/windows-bot-host-runbook.md`** (SSH
> sobre Tailscale, scheduled tasks `linkedin-bot-daemon` + `recruiter-snapshot-prune`, ops y
> gotchas). Se mantiene este archivo solo por contexto histórico del approach Mac.

> **Para qué es este documento.** Guía paso a paso para dejar el bot de scraping
> corriendo en la **única** Mac con acceso a recruiting (la del **titular de la
> cuenta** de LinkedIn), dentro de un **usuario macOS dedicado** (`linkedin-bot`) en
> **segundo plano**, mientras el titular sigue trabajando en su sesión **sin
> interferencia**. Cubre desde crear el usuario hasta validar técnicamente que
> funciona en ese equipo.
>
> Es el complemento operativo del plan de arquitectura
> (`~/.claude/plans/ahora-tengo-otro-problema-bubbly-diffie.md`) y del pipeline
> completo (`docs/recruitment-automation-flow.md` + `docs/anti-bot-measures.md`).
> Si algo choca, esos documentos mandan en arquitectura; este manda en el "cómo".

---

## 0. El modelo en 30 segundos

```
   Mac del titular (única con acceso a recruiting)
   ├─ Usuario del titular     → su Chrome, su trabajo normal       → LinkedIn ┐ misma cuenta,
   │   (sesión al frente — NUNCA se comparte por VNC)                          │ 2 perfiles,
   └─ Usuario "linkedin-bot"  → daemon + Chrome del bot (headed)    → LinkedIn ┘ misma IP/HW
       (sesión en 2º plano vía Fast User Switching; login propio 1 vez)
```

- **Por qué un usuario dedicado y no headless:** headed con la GPU real (Apple/Metal)
  es la postura anti-bot más fuerte; headless cae a render por software (SwiftShader)
  y contradice el hardware real — justo lo que marcó la cuenta el 2026-05-28.
- **Por qué NO copiar el Chrome del titular:** dos perfiles independientes en la misma
  máquina = misma cuenta + misma IP + mismo hardware → benigno. Copiar cookies/perfil
  sería fork de sesión (riesgo de session-hijack). El bot hace su **propio login** una vez.
- **Por qué el titular no se entera:** macOS aísla los usuarios (WindowServer propio por
  usuario). El Chrome del bot vive en la sesión de `linkedin-bot`; nunca aparece en la
  pantalla del titular ni le mueve el mouse.

---

## Checklist rápido (orden de instalación)

Para el admin que instala todo de cero. Cada ítem enlaza a la sección con el detalle.

**En la Mac del operador (antes de ir al host):**
- [ ] Generar llave SSH: `ls ~/.ssh/id_ed25519 || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519` → copiar `~/.ssh/id_ed25519.pub` (§11a)
- [ ] Instalar Tailscale y hacer `tailscale up` → anotar la IP `100.x` del tailnet (§7)

**En la Mac del titular (como admin):**
- [ ] Instalar Homebrew + Node: `node -v` debe responder (§1)
- [ ] Clonar el repo en el home del usuario bot: `git clone <URL> /Users/linkedin-bot/session-replay` + `cd /Users/linkedin-bot/session-replay/extension && npm install` (§1)
- [ ] Crear usuario `linkedin-bot`: `sudo sysadminctl -addUser linkedin-bot ...` (§2)
- [ ] Activar Fast User Switching (§3)
- [ ] Fijar sleep a 0 enchufado: `sudo pmset -c sleep 0` (§4)
- [ ] Habilitar Remote Login (SSH): `sudo systemsetup -setremotelogin on` (§11a)
- [ ] Instalar llave pública del operador en `linkedin-bot` (§11a)
- [ ] Instalar Tailscale y hacer `tailscale up` (§7)
- [ ] Activar Screen Sharing (GUI: System Settings → Sharing → Screen Sharing = ON) (§7)

**En la sesión de `linkedin-bot` (por FUS o VNC):**
- [ ] Validar render GPU: `cd ~/session-replay/extension && node test-bg-session-chrome.mjs && node test-bg-session-gpu.mjs` (§5)
- [ ] Login de LinkedIn: `cd ~/session-replay/extension && node login-linkedin.mjs` — el titular escanea QR o ingresa credenciales (§6)
- [ ] Instalar daemon y apuntar al backend central: `cd ~/session-replay && make daemon-install` → editar `BACKEND` en el plist (§6)

**Desde la Mac del operador:**
- [ ] Verificar SSH: `ssh -o BatchMode=yes linkedin-bot@<IP-tailnet> whoami` → debe responder `linkedin-bot` (§11a)
- [ ] Abrir dashboard: `http://localhost:5173` (el frontend vive en la Mac del operador, no en el host)
- [ ] Correr run de prueba: `trigger-now` con `"mode":"test","max_candidates":1` (§6)
- [ ] Verificar leads en Odoo con `is_test=true`, luego limpiar (§6)

---

## 1. Pre-requisitos en el host

- macOS reciente (validado en **macOS 26.5 / Apple M1 Pro**).
- **Google Chrome** instalado (el bot usa `channel:"chrome"`, el Chrome del sistema).
- **Homebrew Node** (`/opt/homebrew/bin/node`). Verificar: `node -v`.
- El repo `session-replay` clonado en el **home del usuario bot** (no en `~/Documents/`):
  ```bash
  git clone <URL-del-repo> /Users/linkedin-bot/session-replay
  ```
  Clonar dentro de `~/Documents/` puede causar errores EPERM cuando launchd intenta
  leer esa carpeta. Directamente en el home (`~/session-replay`) no tiene ese problema.
  En el resto del doc `<REPO>` = `/Users/linkedin-bot/session-replay`.
- `npm install` corrido en `<REPO>/extension` (trae Playwright).
- Acceso administrador para crear el usuario (lo hace quien administre la Mac).

**Arquitectura de este host:** el **daemon** corre aquí (bajo `linkedin-bot`); el
**backend + frontend + Postgres** corren en la Mac del operador (ya configurados).
El daemon se conecta al backend por Tailscale — ver §6 para la configuración del
`BACKEND`.

---

## 2. Crear el usuario dedicado `linkedin-bot`

Standard (no-admin) = mínimo privilegio; el bot no necesita admin.

```bash
sudo sysadminctl -addUser linkedin-bot -fullName "LinkedIn Bot" -password -
```

`-password -` pide el password de forma interactiva (no queda en el historial).
Guárdalo: lo necesitarás para iniciar sesión y para VNC.

**Verificar que quedó bien (standard, UID >= 501):**

```bash
dscl . -read /Users/linkedin-bot UniqueID PrimaryGroupID NFSHomeDirectory RealName
dseditgroup -o checkmember -m linkedin-bot admin   # debe decir "no ... NOT a member of admin"
```

Esperado: `PrimaryGroupID: 20` (staff = standard), home `/Users/linkedin-bot`.

---

## 3. Activar Fast User Switching (cambio rápido de usuario)

Permite tener al titular y al bot logueados a la vez, alternando sin cerrar sesión.

```bash
sudo defaults write /Library/Preferences/.GlobalPreferences MultipleSessionEnabled -bool true
```

Y mostrar el menú: **System Settings → Control Center → Fast User Switching →
"Show in Menu Bar" = On**. Aparecerá un ícono/nombre arriba a la derecha; desde ahí
se cambia de usuario. Atajo para ir al login: `Ctrl + ⌘ + Q`.

> **Primer login de `linkedin-bot`:** salta el asistente de configuración
> ("Set Up Later" / "Skip" / "Not Now") hasta llegar a un escritorio limpio.

---

## 4. Energía: que la Mac no se duerma (crítico)

El *bloqueo de pantalla / screensaver* **NO** detiene al bot — solo importa para
**ver** por VNC. El enemigo real es el **system sleep**, que sí congela todo.

Revisar el timer de sleep:

```bash
pmset -g | grep -E " sleep| disablesleep"
```

En la Mac de prueba estaba en **`sleep 1`** (¡1 minuto!). Mitigaciones:

1. **Enchufar a corriente** durante las ventanas de QA.
2. **Tapa abierta** (cerrarla duerme la Mac aunque haya `caffeinate`, salvo con
   monitor externo).
3. **`caffeinate`** mientras corra el bot. Para pruebas, envolver el comando
   (ver §5.3). Para operación durable, o bien lanzar el daemon bajo `caffeinate`,
   o fijar a nivel sistema (afecta ambos usuarios):
   ```bash
   sudo pmset -c sleep 0     # nunca dormir cuando está en corriente
   ```
4. **Auto-logout por inactividad:** confirmar que está apagado:
   ```bash
   defaults read /Library/Preferences/.GlobalPreferences com.apple.autologout.AutoLogOutDelay 2>/dev/null || echo "off (ok)"
   ```

---

## 5. Validar el modelo en ESE host (3 pruebas, sin tocar LinkedIn)

Estas pruebas confirman el punto técnico clave: **¿el Chrome headed sigue renderizando
con la GPU real cuando su sesión está en segundo plano?** Usan un perfil temporal
aislado y solo `example.com` → **cero riesgo para la cuenta**. Los scripts están en
el repo: `extension/test-bg-session-{chrome,gpu,longrun}.mjs`.

**Mecánica de cada prueba:**
1. Cambia a la sesión de **`linkedin-bot`** (Fast User Switching).
2. Abre Terminal en esa sesión y corre el comando indicado **en primer plano**.
3. Cuando imprima las primeras líneas `OK`, **cambia de vuelta al usuario del titular**
   (esto deja la sesión del bot en 2º plano — la condición que probamos).
4. Espera, **vuelve a la sesión de `linkedin-bot`** y lee el scrollback / `VERDICT`.

> Tip: si prefieres observar desde el otro usuario sin volver, redirige a un archivo
> en `/Users/Shared/` (world-readable) y haz `tail -f` desde la otra sesión:
> `... > /Users/Shared/bg.log 2>&1 &`.

### 5.1 Render en 2º plano (no se congela)

```bash
cd <REPO>/extension
ITERATIONS=30 INTERVAL_MS=3000 node test-bg-session-chrome.mjs
```

**PASA si:** llega a `30/30 OK` con `screenshot=NNNN B` (>0 y estable) tras haber
cambiado de usuario. **Falla si:** se congela / FAIL al pasar a 2º plano.

### 5.2 GPU real (no cae a SwiftShader)

```bash
cd <REPO>/extension
ITERATIONS=10 INTERVAL_MS=3000 node test-bg-session-gpu.mjs
```

**PASA si:** las 10/10 lecturas dicen `HARDWARE (Apple)` con renderer tipo
`ANGLE (Apple, ANGLE Metal Renderer: Apple M1 ...)`. **Falla si:** aparece
`SOFTWARE` / `SwiftShader` (contradicción de fingerprint → fallback Mac dedicada).

### 5.3 Sostenido 15 min (no se frena ni degrada)

Envuelto en `caffeinate` para neutralizar el sleep durante la prueba:

```bash
cd <REPO>/extension
caffeinate -dimsu env DURATION_MIN=15 node test-bg-session-longrun.mjs
```

Cambia a la sesión del titular; vuelve a los ~15 min y lee el `VERDICT`.
**PASA si:** `HW-Apple = N`, `SOFTWARE = 0`, `errores = 0`, y el `gap máx` entre
vueltas es cercano al intervalo (sin throttling de App Nap).

### Resultados de referencia (M1 Pro / macOS 26.5, 2026-05-29)

| Prueba | Resultado |
|---|---|
| Render 2º plano | `30/30 OK`, screenshot 17190 B estable → **PASS** |
| GPU real | `10/10 HARDWARE (Apple) — ANGLE Metal Renderer: Apple M1 Pro` → **PASS** |
| Sostenido | `15.0 min · 177/177 HW-Apple · SOFTWARE=0 · errores=0 · gap máx 5108ms (obj 5000)` → **PASS** |

Si el host da los mismos resultados, el modelo headed-en-2º-plano es técnicamente
sólido en ese equipo.

> **Lo que estas pruebas NO validan:** la reacción anti-bot real de LinkedIn. Eso es
> caja negra y solo se confirma con un *soak* de varios días a bajo volumen con la
> cuenta real (Niveles 2–3 del runbook del plan).

---

## 6. Setup real del bot bajo `linkedin-bot`

Hacer **en la sesión de `linkedin-bot`**. El titular participa una sola vez (el login).

1. **Login propio del bot (perfil fresco, NO copiar el del titular):**
   ```bash
   cd <REPO>/extension
   node login-linkedin.mjs
   ```
   Abre Chrome directo en la página de login de LinkedIn. El titular solo tiene que
   **llegar a su feed**, de la forma más cómoda:
   - **La más simple, sin teclear:** si Chrome muestra "Iniciar sesión con la app" /
     un **código QR**, escanearlo con la app de LinkedIn del teléfono.
   - O email + contraseña normal.
   - Si pide un **código** (SMS/email) la 1ª vez, ingresarlo una sola vez (es el
     checkpoint que whitelistea el equipo).

   El script **detecta solo** el login y cierra (espera hasta 25 min). Es **una sola
   vez**: el perfil queda en `.linkedin-profile` y el daemon lo reutiliza sin que el
   titular vuelva a intervenir.

   > No correr `prepare-stealth-profile.mjs` aquí: ese script copia un `Profile 4`
   > de Chrome ya envejecido (flujo de una Mac con perfil preexistente). En el usuario
   > bot fresco el camino correcto es el login limpio de arriba.

2. **Instalar el daemon** y apuntarlo al backend del operador:
   ```bash
   cd <REPO>
   make daemon-install
   ```
   Después del install, editar el plist renderizado para cambiar `BACKEND` y `API_KEY`
   a los valores del backend central (que corre en la Mac del operador por Tailscale):
   ```bash
   PLIST="$HOME/Library/LaunchAgents/com.akurey.session-replay-daemon.plist"
   # Reemplazar la IP con la IP de Tailscale de la Mac del operador (100.x.x.x)
   plutil -replace EnvironmentVariables.BACKEND \
     -string "http://<IP-TAILNET-OPERADOR>:8081" "$PLIST"
   # API_KEY debe coincidir con el backend del operador
   plutil -replace EnvironmentVariables.API_KEY \
     -string "dev-api-key-change-in-production" "$PLIST"
   make daemon-restart
   make daemon-status        # debe mostrar pid activo
   ```
   > Nota: el backend, frontend y Postgres corren en la Mac del operador — no se
   > instalan en este host. Solo el daemon vive aquí.

3. **Bajar límites de budget para testing** (env vars que el daemon ya lee, en el
   plist del daemon): `MAX_PROFILE_VIEWS_DAY/HOUR`, `MAX_SEARCHES_DAY`,
   `MAX_PAGE_LOADS_DAY`. Con un solo daemon, `.linkedin-budget.json` es el rate global.

4. **Kill switch:** `make daemon-uninstall` detiene toda actividad de LinkedIn
   dejando el perfil y el budget intactos.

Detalle completo del pipeline (webhook Odoo → search → scrape → push → scoring):
`docs/recruitment-automation-flow.md`.

### Verificación E2E (run de prueba, sin contaminar Odoo)

Para confirmar el flujo completo sin ensuciar datos reales, dispará un run en **modo
test** vía `trigger-now` (tagea los outputs como test en Odoo, `is_test=true`). Correr
desde la **Mac del operador** (donde vive el backend):

```bash
API_KEY="dev-api-key-change-in-production"
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  http://localhost:8081/v1/workflows/<WORKFLOW_ID>/trigger-now \
  -d '{"connector_id":"<CONNECTOR_ID>","execution_options":{"mode":"test","max_candidates":1,"push_to_odoo":true,"label_outputs":true},"triggered_by":"qa"}'
```

- El daemon en la Mac de Fernanda (sesión `linkedin-bot`) detecta el run vía poll y abre Chrome headed → observable por VNC (`vnc://<IP-tailnet>` conectado como `linkedin-bot`).
- El dashboard `localhost:5173` refleja el run en vivo (mismo backend).
- Verificar leads en Odoo, tagueados como test:
  ```sql
  select is_test, count(*) from linkedin_lead where source_run_id = '<RUN_ID>' group by is_test;  -- is_test=t
  ```
- **Limpieza de datos de prueba** (por run o por flag):
  ```sql
  delete from linkedin_lead where source_run_id = '<RUN_ID>';   -- o: where is_test = true
  ```

> Validado 2026-06-01 (rehearsal en 2ª Mac, daemon bajo `linkedin-bot` contra backend
> compartido): búsqueda real → **19 leads pusheados con `is_test=true` + `source_run_id`**,
> dashboard sincronizado, Chrome headed renderizando en sesión en 2º plano.

---

## 7. Acceso remoto para QA (observación, sin tocar anti-bot)

Los operadores **disparan** y **observan**; nunca abren LinkedIn de esta cuenta en su
propio navegador. (Pasos interactivos: los ejecuta el usuario, no se automatizan.)

1. **Tailscale** en el host y en las máquinas de QA/admin. Es la red privada cifrada;
   transporta el dashboard y el VNC sin exponer puertos a internet.
2. **Screen Sharing** (System Settings → General → Sharing → Screen Sharing = On),
   accesible **solo por Tailscale**, en modo **observe-only** durante un run.
3. **Conectar SIEMPRE como el usuario `linkedin-bot`** (Screen Sharing.app → iniciar
   sesión como `linkedin-bot`), **nunca** como el titular. macOS abre la sesión propia
   del bot en un display virtual → QA ve solo el escritorio limpio del bot; la pantalla
   del titular queda intocable.
4. Observación principal = **dashboard `:5173`** + applicants/scoring en **Odoo**. VNC
   es para debug visual; nadie clickea dentro del Chrome del bot durante un run.

**Validado 2026-06-01:** Tailscale arriba (cada equipo recibe IP `100.x`); backend
`:8081` y dashboard `:5173` alcanzables por la IP del tailnet con API key (401 sin
key); un **iPhone** (2º nodo del tailnet) abre el dashboard en Safari. VNC: Screen
Sharing `:5900` alcanzable por tailnet; **desde Mac** → `vnc://<IP-tailnet>` con
Screen Sharing.app; **desde iPhone** → app **RealVNC Viewer** a `<IP-tailnet>:5900`.
Siempre se autentica con la cuenta macOS **`linkedin-bot`** (no la del titular).
Habilitar Screen Sharing es **GUI** (System Settings → Sharing) — macOS lo bloquea
por terminal (el `kickstart` de ARD avisa "must be enabled from System Settings").

---

## 8. Checklist antes de cada ventana de QA

- [ ] Mac enchufada, tapa abierta, sleep neutralizado (`caffeinate` o `pmset -c sleep 0`).
- [ ] Sesión de `linkedin-bot` logueada y en 2º plano; el titular en la suya.
- [ ] `make services-status`: daemon up, backend `:8081` y frontend `:5173` OK.
- [ ] Sin run activo; circuito cerrado (sin `[CIRCUIT OPEN]` en logs del daemon).
- [ ] VNC solo por Tailscale, observe-only, conectado como `linkedin-bot`.
- [ ] Durante pruebas críticas, **el titular no usa Recruiter activamente** en paralelo
      (≤2 sesiones coherentes; mismo país reduce viaje-imposible, no lo elimina).

---

## 9. Anti-bot: qué NUNCA hacer

- **No** correr headless si se puede headed (SwiftShader contradice el M1 real).
- **No** copiar/sincronizar el Chrome ni las cookies del titular al bot (fork de sesión).
- **No** restaurar el perfil del bot desde un backup de otra máquina. Si se corrompe,
  login limpio **en el mismo host**.
- **No** abrir LinkedIn de esta cuenta desde el navegador propio de ningún operador.
- Ante checkpoint/captcha: **pausar**, dejar correr el cooldown, y que el titular valide
  manualmente. No re-loguear en bucle ni mover el perfil.
- **No** lanzar el daemon con `BASE_COOLDOWN_MS=0` / `COOLDOWN_JITTER_MS=0` /
  `RESPECT_WORKING_HOURS=0` — esas variables son solo para iterar rápido en QA y
  producirían una cadencia robótica (runs back-to-back, fuera de horario) que es un
  tell anti-bot. **Producción = `make daemon-install`**, que usa los defaults del plist
  (cooldown 20–40 min entre runs + horario laboral).

---

## 10. Limpieza del PoC

Los scripts `test-bg-session-*.mjs` quedan versionados en el repo (reutilizables).
Si durante la validación se crearon artefactos sueltos en `/Users/Shared/` (logs,
`bg-smoke/`), se pueden borrar — no son parte del setup real:

```bash
rm -rf /Users/Shared/bg-smoke /Users/Shared/bg-*.log
```

El usuario `linkedin-bot` se queda: es el usuario real del bot.

---

## 11. Terminal remota y debugging (acceso desde la Mac del operador)

Dos canales, ambos sobre Tailscale (sin puertos públicos).

---

### 11a. Consola SSH — la vía principal

Da una terminal completa como `linkedin-bot` desde cualquier Mac del operador, sin
exponer puertos a internet. Es lo que permite desplegar/reiniciar el daemon, hacer
`tail -f` del log y leer capturas de debug **sin necesitar VNC ni estar en la misma red**.

#### Setup en el host (una sola vez, con admin)

```bash
# 1) Habilitar Remote Login (servidor SSH de macOS).
#    Por terminal (si tiene Full Disk Access):
sudo systemsetup -setremotelogin on
#    Si responde "requires Full Disk Access" → GUI:
#    System Settings → General → Sharing → Remote Login = ON.

# 2) Dar acceso SSH al usuario bot.
sudo dseditgroup -o edit -a linkedin-bot -t user com.apple.access_ssh 2>/dev/null || true

# 3) Instalar la llave pública del operador.
#    El operador te pasa el contenido de ~/.ssh/id_ed25519.pub (ver §11a "Operador").
sudo mkdir -p /Users/linkedin-bot/.ssh
echo 'PEGAR_PUBKEY_AQUI' | sudo tee -a /Users/linkedin-bot/.ssh/authorized_keys >/dev/null
sudo chown -R linkedin-bot:staff /Users/linkedin-bot/.ssh
sudo chmod 700 /Users/linkedin-bot/.ssh
sudo chmod 600 /Users/linkedin-bot/.ssh/authorized_keys
```

#### Setup en la Mac del operador (una sola vez)

```bash
# 1) Generar llave SSH si no tenés una (solo si ~/.ssh/id_ed25519 no existe).
ls ~/.ssh/id_ed25519 2>/dev/null || ssh-keygen -t ed25519 -C "$(whoami)@$(hostname)" -N "" -f ~/.ssh/id_ed25519

# 2) Copiar la llave pública → pasársela al admin del host para el paso 3 de arriba.
cat ~/.ssh/id_ed25519.pub
# Ejemplo de salida: ssh-ed25519 AAAAC3Nz... tu@maquina

# 3) Obtener la IP de Tailscale del host (una vez que Tailscale esté instalado en ambos).
#    En el host: Settings → Tailscale → la IP empieza con 100.x
#    O desde tu terminal: tailscale status | grep "linkedin-bot\|<nombre-del-host>"

# 4) Guardar un alias para no tipear siempre la IP.
echo 'alias ssh-bot="ssh linkedin-bot@<IP-TAILNET>"' >> ~/.zshrc && source ~/.zshrc
```

#### Verificar conexión (desde la Mac del operador)

```bash
ssh -o BatchMode=yes linkedin-bot@<IP-TAILNET> whoami   # → linkedin-bot
```

#### Comandos de uso cotidiano

```bash
HOST="linkedin-bot@<IP-TAILNET>"

# Ver log del daemon en vivo
ssh $HOST 'tail -f ~/Library/Logs/session-replay/daemon.log'

# Estado de los servicios
ssh $HOST 'cd ~/session-replay && make services-status'

# Reiniciar el daemon (limpio: mata Chrome huérfano primero)
ssh $HOST 'cd ~/session-replay && make daemon-restart'

# Ver capturas de debug del último run que se colgó
ssh $HOST 'ls -lt ~/session-replay/extension/.debug/ | head'
ssh $HOST 'cat ~/session-replay/extension/.debug/<runId>/debug-*.json'

# Desplegar código nuevo al host
scp extension/driver-daemon.mjs $HOST:~/session-replay/extension/
ssh $HOST 'cd ~/session-replay && make daemon-restart'
```

#### Caveats críticos

- **Headed Chrome desde SSH funciona SOLO si `linkedin-bot` tiene sesión GUI activa**
  (logueada por Fast User Switching). Sin sesión GUI, todo comando gráfico (daemon,
  Chrome) falla silenciosamente. Regla: mantener la sesión del bot logueada. (Validado
  2026-06-01: smoke test headed desde SSH OK con FUS activo.)
- El shell SSH **no hereda el PATH de Homebrew** → siempre usar ruta completa
  `/opt/homebrew/bin/node`. `make` resuelve esto solo (el Makefile fija el PATH).
- El puerto 22 **nunca se expone a internet**. Autenticación solo por llave, no
  password. El usuario `linkedin-bot` es standard (sin admin), así que el alcance
  de lo accesible está acotado al home del bot y directorios compartidos.

---

### 11b. Artefactos de debug que el daemon reporta al backend

Para cuando el operador no puede abrir una terminal (ej. solo tiene el dashboard):

- **Logs con timestamps** (`[dbg HH:MM:SS] …`) — inicio de cada step con URL/título,
  conteos, y errores de consola de la página. launchd los escribe a
  `~/Library/Logs/session-replay/daemon.log`.
- **Watchdog anti-cuelgue:** si un run supera `RUN_WATCHDOG_MS` (default 240 s), el
  daemon captura el estado de la página y aborta limpio (pausa el run) en vez de
  colgarse en silencio.
- **Captura de página (`captureDebug`):** guarda screenshot + HTML + consola en
  `extension/.debug/<runId>/` y postea URL/título/HTML/consola al backend.
- **Recuperar la captura sin terminal:**
  ```bash
  API_KEY="dev-api-key-change-in-production"
  curl -s -H "X-API-Key: $API_KEY" \
    "http://<IP-TAILNET>:8081/v1/runs/<RUN_ID>/events?event_type=debug" | python3 -m json.tool
  ```
  El campo `payload` trae `reason`, `url`, `title`, `html_excerpt`, `console`,
  `screenshot_path`.

**Reinicio limpio del daemon:** NO hagas `pkill -f driver-daemon` en seco — deja
Chrome huérfano, bloquea el perfil y causa un "search → cuelgue mudo" (observado
2026-06-01). Usar siempre `make daemon-restart` o parar/arrancar el LaunchAgent
(`launchctl unload/load`), que el wrapper ya mata el Chrome scoped al usuario antes
de relanzar.
