# Deploy & Environments runbook

How the session-replay app is deployed across **two AWS environments** and the **one
shared LinkedIn daemon/seat**. This is the canonical reference — keep it in sync when
infra changes.

> Secrets (gateway keys, PEMs, `.env.prod`) live ON the boxes / in gitignored files,
> NOT in git. The exact secret values are in the `project_prod_env_deploy` +
> `project_aws_backend_deploy` memories. This doc has the IDs and procedures.

---

## 1. Architecture

```
            ONE EC2 box (i-05b040cc9eaf73146, t4g.micro, 16GB) — since 2026-10-19
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │  Caddy (project sr, the ONLY edge, ports 80/443, auto-TLS for both hosts)    │
 │    54-211-23-18.sslip.io ──► backend      (project sr,     /opt/sr)     ── Odoo: morsoft (prod)
 │    52-5-45-84.sslip.io   ──► backend-dev  (project sr-dev, /opt/sr-dev) ── Odoo: qaodoo
 │                              via the `sr-edge` docker network            │
 │  Postgres sr_pgdata (PROD)          Postgres sr-dev_pgdata (DEV)             │
 └──────────────────────────────────────────────────────────────────────────────┘
        │  both public IPs (EIPs) are on this box's ENI                        │
        └──────────────────────────┬───────────────────────────────────────────┘
                                    ▼
                ONE shared daemon + LinkedIn seat (Fernanda's Windows host)
                polls BOTH backends; claims runs targeted at operator "fernanda"
                from either; reports each run back to its ORIGIN backend.
                Drives ONE run at a time → the two envs serialize on the seat.
```

- **The two stacks share the box, not their data**: each has its own compose project,
  directory, Postgres volume, backend source/image, gateway API key and `.env.prod`. Only the
  edge (Caddy) and the box's RAM/disk are shared. A redeploy of dev rebuilds `backend-dev`
  only and can never touch prod's containers or DB.
- Until 2026-10-19 each env had its own EC2. DEV was folded into the PROD box to cut cost
  (~$9/mo). DEV's EIP `52.5.45.84` moved WITH it (now a secondary private IP on the PROD
  box's ENI), so the DEV URL — and everything pointing at it (qaodoo, the daemon,
  extension builds, scripts) — did not change.
- **The daemon/seat is NOT duplicated** (only one LinkedIn Recruiter account). It serves
  both stacks via multi-backend polling — see §6.

### Per-environment facts

| | DEV | PROD |
|---|---|---|
| Domain | `52-5-45-84.sslip.io` | `54-211-23-18.sslip.io` |
| EC2 instance | `i-05b040cc9eaf73146` (shared) | `i-05b040cc9eaf73146` |
| Directory / compose project | `/opt/sr-dev` / `sr-dev` (`docker-compose.dev.yml`) | `/opt/sr` / `sr` (`docker-compose.prod.yml`) |
| Backend service / container | `backend-dev` / `sr-dev-backend-dev-1` | `backend` / `sr-backend-1` |
| Elastic IP → private IP | `52.5.45.84` (`eipalloc-054bc6014304bbc49`) → `172.31.65.239` (secondary) | `54.211.23.18` (`eipalloc-0f0beb21384f02ca2`) → `172.31.79.113` (primary) |
| Security group | `sg-09d49bc7c7f8d097e` (shared) | `sg-09d49bc7c7f8d097e` |
| Keypair / PEM | `sr-prod` / `deploy/sr-prod.pem` (shared) | `sr-prod` / `deploy/sr-prod.pem` |
| Odoo target | qaodoo | morsoft (prod, live data) |
| Gateway key | in `project_aws_backend_deploy` | in `project_prod_env_deploy` |

Shared: account `462620190779`, us-east-1, AMI `ami-0b183bb1259186479` (AL2023 arm64),
VPC `vpc-09dccdd6e5a5f9f45`, subnet `subnet-04c009ffd631ab616`, ENI `eni-032da8ae7cdb9e2cc`.
The box is `t4g.micro` (1GB) + 2GB swap; DEV's containers are memory-capped
(`backend-dev` 400m, its postgres 200m) so DEV can't starve PROD. The SG allows SSH (22)
only from Andrey's current IP; 80/443 open. **Always SSH via `54.211.23.18`** — `52.5.45.84`
reaches the same box but with a different host key than the old DEV box.

---

## 2. Deploy the BACKEND

`deploy/redeploy.sh` ships `backend/` + `deploy/` into the env's directory, rebuilds that
env's backend image, restarts ONLY that env's backend container, prunes dangling images,
and health-checks. `TARGET` is **required** (no default, so an old habit can't hit the
wrong env):

```bash
# DEV  → /opt/sr-dev, service backend-dev
TARGET=dev ./deploy/redeploy.sh

# PROD → /opt/sr, service backend
TARGET=prod API_KEY=<prod-gateway-key> ./deploy/redeploy.sh
```

- `ENV_FILE` (default `.env.prod`) = the env filename in that env's directory on the box.
- `API_KEY` is only for the health check; dev's defaults to the local `deploy/.env.prod`,
  prod's must be passed explicitly.
- Redeploying from a branch that predates 2026-10-19 is unsafe: its `redeploy.sh` targets
  the old DEV box (fails harmlessly on the host key) or ships the pre-colocation
  `docker-compose.prod.yml`/`Caddyfile` into `/opt/sr` (the DEV site would vanish on the
  next Caddy recreate/reboot). Rebase onto develop first.
- The Postgres volume is preserved. **NEVER `docker compose down -v`** — the schema can't
  be rebuilt from `create_all`/alembic (see §5).

Manual stack ops on the box (`-f` decides the env — the file hardcodes the project name):
```bash
ssh -i deploy/sr-prod.pem ec2-user@54.211.23.18
cd /opt/sr/deploy     && sudo docker compose -f docker-compose.prod.yml --env-file .env.prod <ps|logs|up -d|restart>   # PROD (+ Caddy)
cd /opt/sr-dev/deploy && sudo docker compose -f docker-compose.dev.yml  --env-file .env.prod <ps|logs|up -d|restart>   # DEV
```
Caddy belongs to the PROD project: a `Caddyfile` change → ship it to `/opt/sr/deploy` and
`up -d --no-deps --force-recreate caddy` there (the file is bind-mounted; see §3 on inodes).

---

## 3. Deploy the FRONTEND

Caddy serves the built SPA at `/` and proxies `/v1/*` to the backend (same origin → no
CORS). Build with `VITE_API_URL=/v1` (relative, so the bundle isn't pinned to a domain):

An env badge (DEV blue / PROD red) shows in the sidebar + the browser tab title — driven by
`VITE_ENV_LABEL` (baked per build; falls back to inferring DEV/PROD from the host). Always set it.

```bash
cd frontend
VITE_API_URL=/v1 VITE_API_KEY=<that-env's-gateway-key> VITE_ENV_LABEL=<DEV|PROD> npm run build
tar czf /tmp/dash.tgz -C dist .

# ship + replace IN-PLACE (never rename the dir — Caddy bind-mount inode lesson):
scp -i ../deploy/sr-prod.pem /tmp/dash.tgz ec2-user@54.211.23.18:/tmp/
ssh -i ../deploy/sr-prod.pem ec2-user@54.211.23.18 \
  'mkdir -p /opt/sr/deploy/dashboard && cd /opt/sr/deploy/dashboard && sudo rm -rf ./* && sudo tar xzf /tmp/dash.tgz -C /opt/sr/deploy/dashboard'
```

For **dev**, same box and PEM, but the directory is `/opt/sr-dev/deploy/dashboard`
(mounted into Caddy as `/srv/dashboard-dev`) and the build uses dev's key + `VITE_ENV_LABEL=DEV`.
Both dashboard dirs are bind-mounted read-only into Caddy; populating them in place is
picked up live. If one ever serves a stale bundle, force-recreate caddy ONCE (in
`/opt/sr/deploy`: `up -d --no-deps --force-recreate caddy`) then go back to in-place.

---

## 4. Provision a NEW environment (what was done for prod, 2026-06-22)

```bash
# 1) keypair → gitignored PEM
aws ec2 create-key-pair --region us-east-1 --key-name sr-prod \
  --query KeyMaterial --output text > deploy/sr-prod.pem && chmod 600 deploy/sr-prod.pem

# 2) security group (same VPC), ingress 22 from your IP + 80/443 open
SG=$(aws ec2 create-security-group --region us-east-1 --group-name sr-prod-sg \
  --description "session-replay prod" --vpc-id vpc-09dccdd6e5a5f9f45 --query GroupId --output text)
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id "$SG" --ip-permissions \
  "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=<your-ip>/32}]" \
  "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]" \
  "IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]"

# 3) launch t4g.micro with user-data bootstrap (docker + compose + buildx + 2GB swap + /opt/sr)
aws ec2 run-instances --region us-east-1 --image-id ami-0b183bb1259186479 \
  --instance-type t4g.micro --key-name sr-prod --security-group-ids "$SG" \
  --subnet-id subnet-04c009ffd631ab616 \
  --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=16,VolumeType=gp3,DeleteOnTermination=true}' \
  --user-data file://deploy/ec2-bootstrap.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=sr-prod}]'

# 4) allocate + associate an Elastic IP → DOMAIN = <ip-with-dashes>.sslip.io
ALLOC=$(aws ec2 allocate-address --region us-east-1 --domain vpc --query AllocationId --output text)
aws ec2 associate-address --region us-east-1 --instance-id <iid> --allocation-id "$ALLOC"
```

The bootstrap script is `deploy/ec2-bootstrap.sh` (installs docker, the compose + buildx
plugin binaries — AL2023 ships neither — a 2GB swapfile so `docker build` won't OOM on a
1GB box, and `/opt/sr`). Then: put `deploy/.env.prod` on the box (§7), seed the DB (§5),
and run the backend + frontend deploys (§2, §3).

**Sizing:** `t4g.micro` (1GB) + 2GB swap runs BOTH stacks (~$6/mo; measured after the
2026-10-19 merge: ~480/916 MB used, ~300 MB available, CPU ~1%). If memory gets tight, resize
the one box to `t4g.small` (stop/modify/start below, ~2 min of downtime for both envs).

**Adding DEV to a freshly provisioned box** (what was done 2026-10-19): the bootstrap already
creates `sr-edge` + `/opt/sr-dev/deploy/dashboard`. Copy dev's `.env.prod` into
`/opt/sr-dev/deploy/`, `TARGET=dev ./deploy/redeploy.sh` (ships source + builds), restore
dev's DB into `sr-dev-postgres-1` (§5), add `DOMAIN_DEV=<dev host>` to PROD's
`/opt/sr/deploy/.env.prod`, recreate Caddy, then point DEV's EIP at the box (a second EIP
needs a secondary private IP on the ENI: `aws ec2 assign-private-ip-addresses
--network-interface-id <eni> --secondary-private-ip-address-count 1`, wait ~1 min until
`ip -4 addr` shows it — amazon-ec2-net-utils configures it — then `aws ec2 associate-address
--allocation-id <alloc> --network-interface-id <eni> --private-ip-address <ip>
--allow-reassociation`). Recreate Caddy AFTER the IP points at the box, or its first
Let's Encrypt HTTP-01 attempts for the DEV host hit the old box and count against the
5-failures/hour limit.

### Resize an existing box (e.g. dev medium→micro)
```bash
ssh ... ec2-user@<ip> 'sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile && echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab'
aws ec2 stop-instances  --region us-east-1 --instance-ids <iid> && aws ec2 wait instance-stopped --instance-ids <iid> --region us-east-1
aws ec2 modify-instance-attribute --region us-east-1 --instance-id <iid> --instance-type t4g.micro
aws ec2 start-instances --region us-east-1 --instance-ids <iid>
```
The Elastic IP stays associated across stop/start; containers (`restart: unless-stopped`)
auto-start on boot.

---

## 5. Seed a new env's DATABASE (dump-restore-prune)

The schema **cannot** be rebuilt from `create_all`/alembic (FK type drift) — the only
source of truth is an existing box's live DB. To seed a fresh env, dump dev and prune the
dev-specific runtime/config rows, keeping the (account-agnostic) workflow definitions:

```bash
# dump dev (its postgres is sr-dev-postgres-1 on the shared box)
ssh -i deploy/sr-prod.pem ec2-user@54.211.23.18 \
  'sudo docker exec -i sr-dev-postgres-1 pg_dump -U sr -d workflow --no-owner --no-privileges' > /tmp/dev-dump.sql

# on the NEW box: postgres up first, then recreate schema + restore
sudo docker compose ... up -d postgres        # wait healthy
... psql -U sr -d workflow -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
... psql -U sr -d workflow < /tmp/dev-dump.sql

# prune dev runtime + connectors (KEEP workflows/steps/params + schema):
... psql -U sr -d workflow -c "
  TRUNCATE execution_runs CASCADE;
  TRUNCATE event_log, artifacts, run_summaries, workflow_analyses, audit_outbox;
  DELETE FROM webhook_triggers;
  DELETE FROM workflow_connector_bindings;
  DELETE FROM connector_configs;"
# then bring up backend + caddy
sudo docker compose ... up -d --build
```

The dump preserves the **workflow UUIDs**, so the new env's `.env.prod` reuses the SAME
`RECRUITER_*_WORKFLOW_ID` values as dev. `artifacts`/`run_summaries`/`event_log` don't FK
to `execution_runs`, so truncate them explicitly. Create the env's connector fresh (§8).

---

## 6. The shared DAEMON (one seat, both envs)

`extension/driver-daemon.mjs` is multi-backend: `ENDPOINTS = [primary, secondary]` from
`BACKEND`/`API_KEY` (+ `BACKEND_2`/`API_KEY_2`). `BACKEND`/`API_KEY`/`HEADERS` are mutable
pointers repointed by `setActive()`. Each poll tick iterates endpoints; the FIRST one with
a claimable run keeps the binding for that run's whole lifetime (claim → drive → terminal),
so all of a run's calls hit its origin backend. Idle heartbeats fan out to every endpoint
(`heartbeatAll`). One run at a time → the envs serialize on the single seat.

Config on Fernanda's host (`daemon-task.ps1`): set `BACKEND`/`API_KEY` (dev) **and**
`BACKEND_2`/`API_KEY_2` (prod). `OPERATOR_ID=fernanda` (unchanged). Webhook/reconcile
LinkedIn runs are pinned to operator `fernanda` on BOTH backends, so the daemon claims them
from either. See [[project_daemon_operator_routing]].

### Deploying daemon changes
- **Strategy / behavior** (`runtime-strategies/{recruiter,daemon-behavior}.mjs`) — hot-loaded
  by mtime: `scp` the file, NO restart.
- **Host code** (`driver-daemon.mjs` + `src/`) — re-sync + **restart `linkedin-bot-daemon` +
  re-login the seat**. Multi-backend is a host change → this restart is required ONCE.
  Re-login dance (proven 2026-06-23):
  1. DISABLE + stop `linkedin-bot-daemon` **AND** the aux tasks `recruiter-inject`,
     `recruiter-probe`, `recruiter-search-capture`, `recruiter-sesscheck` — they grab the
     `.linkedin-profile` lock and will make `login-talent.bat` fail with
     `launchPersistentContext: ... browser has been closed`. Kill any chrome on the profile +
     remove stale `Singleton*` files.
  2. Operator runs `Login-Talent-Recruiter.bat` (or `login-talent.bat` — both run
     `login-talent.mjs`, which hard-guards Windows user = `linkedin-bot`) AT the host GUI; log
     into Talent, pick the **Morsoft SRL-Recruiter** contract; the window closes on success.
  3. Re-enable + start `linkedin-bot-daemon` + the aux tasks. Confirm `/v1/daemon/status` on
     BOTH backends shows the worker and the log prints `[keepalive] /talent OK — seat warm`.
  (`LoginCheck` is a Windows system task — ignore. SSH→PowerShell quoting bites: ship a `.ps1`
  and run `powershell -File`.) See `docs/windows-bot-host-runbook.md` +
  [[project_recruiter_relogin_contract]] + [[project_prod_env_deploy]].

Reply-scan/keepalive still target ENDPOINTS[0] only; fanning the reply POST to all backends
is a future hot-module tweak (no restart).

---

## 7. Secrets & the 3-way key rule

Each env's `deploy/.env.prod` (on the box, gitignored): `DOMAIN`, `POSTGRES_*`, `API_KEY`
(gateway), `SECRET_KEY`, `AI_API_KEY` (OpenAI), `CORS_ORIGINS`, and the `RECRUITER_*_WORKFLOW_ID`
set (same UUIDs across envs).

**The gateway `API_KEY` must match in 3 places per env:** the backend `.env.prod`, the FE
build (`VITE_API_KEY`), and the daemon (`API_KEY` for dev / `API_KEY_2` for prod). A mismatch
= FE "Invalid API key" or the daemon never claims that env's runs.

---

## 8. Odoo wiring per env (akcr)

- **dev → qaodoo**, **prod → morsoft**. The akcr recruiter integration (model `linkedin.lead`,
  recruiter buttons/fields, the post-CV-analysis link hook) must be deployed to that Odoo
  (PR into the Odoo branch + operator `-u akcr`). morsoft initially had only the OLD akcr
  (`linkedin_sync`, no `linkedin.lead`) — needs the recruiter PR before prod can run.
- **Trigger = reconcile (outbound):** the backend polls its Odoo for `linkedin_sync` +
  `is_published` jobs and enqueues runs (`RECONCILER_ENABLED=1`). No inbound webhook config
  on the Odoo side.
- **Connector** (created on that env's backend): `url`, `db`, `username`, `password`,
  `linkedin_ingest_api_key`, enabled triggers (`recruiter_pipeline`, `linkedin_lead_search`).
  morsoft creds: db=morsoft, uid=102, login=`testerakureyapp@gmail.com` (Recruitment Admin).
- **`ir.config_parameter` on the Odoo:** `akcr.session_replay_base_url` → that env's backend
  URL, `akcr.session_replay_api_key` → that env's gateway key, `akcr.linkedin_ingest_api_key`
  (matches the connector), `akcr.recruiter_recommendations_count=6`, `openai_api_key`.

⚠️ morsoft is **live production** (195 jobs / 4990 applicants) — every write deliberate.

### PROD wiring status (2026-06-22)
- akcr recruiter integration **deployed on morsoft** ✓ — `linkedin.lead` model, hr.job
  recruiter fields, all 6 `/akcr/api/*` ingest endpoints return 200, `openai_api_key` set.
- **morsoft connector created on the PROD backend** ✓ — id `9ba7d595-caa8-4f72-81e8-72381dc4d434`
  (`prod-odoo-morsoft`), `reconcile_min_job_id=287` (gated: no existing job auto-fires), one
  ENABLED trigger `recruiter_pipeline → 29ec1891`. `/connectors/{id}/test` → healthy.
  `akcr.linkedin_ingest_api_key` on morsoft = `akcr-linkedin-dev-key-change-me` (matches the
  connector) — harden later (needs a Settings-group user to rotate on morsoft).
- **OPERATOR to-do (needs a Settings/admin Odoo user — uid 102 can't write `ir.config_parameter`).**
  In Odoo: developer mode → Settings → Technical → Parameters → System Parameters, filter `akcr`.
  Set on morsoft (mirror qaodoo's set, with PROD values):
  `akcr.session_replay_base_url=https://54-211-23-18.sslip.io`,
  `akcr.session_replay_api_key=<prod gateway key>`,
  `akcr.session_replay_connector_id=9ba7d595-caa8-4f72-81e8-72381dc4d434` (the prod connector id),
  `akcr.recruiter_recommendations_count=6`. (Optional, feature-specific: `akcr.website_base_url`,
  `akcr.recruiter_demo_lead_*`, `akcr.recruiter_auto_recommendations_{min,max}_minutes`.)
  These power the **manual Odoo buttons** (send-message / add-note / save-recommendations) —
  the AUTO reconcile pipeline (backend→morsoft) does NOT need them.
- **Remaining go-live (one coordinated window):** (1) daemon multi-backend cutover (§6,
  restart+re-login); (2) create a dedicated TEST hr.job on morsoft (id>287, linkedin_sync+
  published+job_location+JD — akcr caps sync at 4, so free a slot first); (3) let reconcile
  fire it → daemon drives create-project→search→leads→flow_status; message stays GATED.
  Do (2)+(3) IN the cutover window so the run doesn't hang QUEUED.

---

## 9. Teardown an environment

Both envs share one box, so tearing down DEV ≠ terminating an instance:
```bash
# DEV only: stop its containers (volumes kept), drop its Caddy site + DOMAIN_DEV, release its EIP
cd /opt/sr-dev/deploy && sudo docker compose -f docker-compose.dev.yml --env-file .env.prod stop
aws ec2 release-address --region us-east-1 --allocation-id eipalloc-054bc6014304bbc49   # after disassociating

# The whole box (both envs):
aws ec2 terminate-instances --region us-east-1 --instance-ids <iid>
aws ec2 release-address --region us-east-1 --allocation-id <alloc>
aws ec2 delete-security-group --region us-east-1 --group-id <sg>
aws ec2 delete-key-pair --region us-east-1 --key-name <name>
```

**Pending from the 2026-10-19 merge (rollback window):** the old DEV box
`i-00c3bdac0e1f2624d` is STOPPED (not terminated), with SG `sg-071bbeb1cb8d55d71` + keypair
`sr-ec2` still there, and EBS snapshots `snap-02355ce6f9ef4a605` (old DEV) /
`snap-02a168299c8ce2117` (PROD) taken before the merge. Rollback = start the old box →
`associate-address` 52.5.45.84 back to it → `up -d backend` there (it was stopped, and
`unless-stopped` won't revive it). After ~1 week stable: terminate it (its root volume has
DeleteOnTermination=true), delete the SG + `sr-ec2` keypair; delete the snapshots after ~2 weeks.

---

## 10. Gotchas

- **NEVER `docker compose down -v`** — wipes the only consistent schema (§5).
- **SG dynamic IP:** SSH 22 is restricted to Andrey's IP; when his ISP IP rotates, SSH times
  out (AWS CLI still works). Re-authorize: `aws ec2 authorize-security-group-ingress
  --group-id <sg> --ip-permissions FromPort=22,...,CidrIp=<new-ip>/32`.
- **Caddy bind-mount inode:** populate `dashboard/` in place; never `mv`/rename it.
- **t4g.micro = 1GB:** the 2GB swapfile is what keeps `docker build` from OOM-ing. Don't
  remove it.
- **Two projects, one box:** the compose FILE decides the env (`name: sr` vs `name: sr-dev`
  are hardcoded). Never run `docker-compose.prod.yml` from `/opt/sr-dev/deploy` or vice
  versa with the other env's `.env.prod`. DEV's backend is `backend-dev` on purpose — a
  second `backend` on the shared `sr-edge` network would make Caddy's `backend:8081`
  ambiguous and could send PROD traffic to DEV.
- **`sr-edge` must exist** before either Caddy or `backend-dev` starts (external network;
  the bootstrap creates it). Only Caddy and `backend-dev` join it — never PROD's backend
  or either postgres.
- **Host key for 52.5.45.84 changed** (it now lands on the PROD box). `ssh` with the old
  `/tmp/sr_known_hosts` entry refuses it — that's the safety net that makes pre-merge
  `redeploy.sh` copies fail harmlessly. Always use `54.211.23.18`.
- **AL2023 has no compose/buildx by default** — the bootstrap installs the plugin binaries.
- **macOS tar** leaks `._*`/xattr headers; `redeploy.sh` uses `COPYFILE_DISABLE=1` + deletes
  `._*` on the box. The `LIBARCHIVE.xattr…` warnings on extract are harmless.
```
