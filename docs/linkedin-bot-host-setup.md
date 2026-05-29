# Runbook — Bot de LinkedIn en host dedicado (usuario en 2º plano)

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

## 1. Pre-requisitos en el host

- macOS reciente (validado en **macOS 26.5 / Apple M1 Pro**).
- **Google Chrome** instalado (el bot usa `channel:"chrome"`, el Chrome del sistema).
- **Homebrew Node** (`/opt/homebrew/bin/node`). Verificar: `node -v`.
- El repo `session-replay` clonado (ej. en `~/Documents/session-replay`).
  En el resto del doc se abrevia como `<REPO>`.
- `npm install` corrido en `<REPO>/extension` (trae Playwright).
- Acceso administrador para crear el usuario (lo hace quien administre la Mac).

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
   Abre Chrome contra un `.linkedin-profile` nuevo. **El titular teclea sus
   credenciales** y resuelve el checkpoint/captcha si aparece (1 sola vez; LinkedIn
   whitelistea ese dispositivo+IP). El script espera hasta 25 min a que la URL quede
   en una superficie logueada de LinkedIn.

   > No correr `prepare-stealth-profile.mjs` aquí: ese script copia un `Profile 4`
   > de Chrome ya envejecido (flujo de una Mac con perfil preexistente). En el usuario
   > bot fresco el camino correcto es el login limpio de arriba.

2. **Instalar los servicios** (daemon en launchd + backend/frontend en screen):
   ```bash
   cd <REPO>
   make all-services-install
   make services-status      # daemon up, puertos 8081/5173 respondiendo
   ```
   Para que no dependan del sleep, lanzar el daemon bajo `caffeinate` o fijar
   `sudo pmset -c sleep 0` (§4).

3. **Bajar límites de budget para testing** (env vars que el daemon ya lee, en el
   plist del daemon): `MAX_PROFILE_VIEWS_DAY/HOUR`, `MAX_SEARCHES_DAY`,
   `MAX_PAGE_LOADS_DAY`. Con un solo daemon, `.linkedin-budget.json` es el rate global.

4. **Kill switch:** `make daemon-uninstall` detiene toda actividad de LinkedIn
   dejando el perfil y el budget intactos.

Detalle completo del pipeline (webhook Odoo → search → scrape → push → scoring):
`docs/recruitment-automation-flow.md`.

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

---

## 10. Limpieza del PoC

Los scripts `test-bg-session-*.mjs` quedan versionados en el repo (reutilizables).
Si durante la validación se crearon artefactos sueltos en `/Users/Shared/` (logs,
`bg-smoke/`), se pueden borrar — no son parte del setup real:

```bash
rm -rf /Users/Shared/bg-smoke /Users/Shared/bg-*.log
```

El usuario `linkedin-bot` se queda: es el usuario real del bot.
