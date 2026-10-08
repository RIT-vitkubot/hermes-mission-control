# hermes-mission-control — spec pro implementaci

## Cíl
Read-only monitorovací web pro Hermes multi-agent systém (6 profilů: `default`
= BMO, `editor`, `obchodnik`, `programovani`, `skola`, `tegistic`), běžící na
jednom Linux hostu. **Aplikace při běhu nesmí volat žádné LLM API a nesmí
stát žádné tokeny** — je to čistě monitorovací/čtecí vrstva nad existujícími
daty (soubory, SQLite, `gh` CLI, `hermes` CLI). Jediná "akce" je tlačítko
restart gateway.

Vizuální styl: **futuristický 3D web**, tmavé neonové HUD, glassmorphism
panely. Na homepage 3D maskot "BMO" (stavěný z primitiv v Three.js — koule/
robot s glow efektem, NE externí 3D model), který reaguje na celkový stav
systému (klidná barva/animace když je vše OK, červená/rozrušená animace při
chybě) a má komixovou speech bubble (HTML overlay nad canvasem) s krátkým
živým textem o stavu ("Všechno běží", "3 cron joby padly", …).

## Architektura (napodobit `board.py`)
- Backend: **Python 3 stdlib `http.server`** (žádný Flask/FastAPI — na hostu
  nejsou nainstalované). Jeden proces, poslouchá na `127.0.0.1:<port>` (port
  zvolit jiný než 8081, např. 8090) a volitelně i na WireGuard IP
  `10.8.0.25` — bind adresu udělat konfigurovatelnou env proměnnou, protože
  stroj NENÍ veřejně přístupný (jen privátní VPN/LAN).
- Žádná autentizace/login na čtecí endpointy. Restart endpoint má jen JS
  `confirm()` dialog na frontendu, **žádné heslo/token** — výslovné přání
  uživatele, protože to neběží na veřejném internetu.
- Frontend: statické HTML/CSS/JS servované tím samým serverem, Three.js z
  CDN (nebo vendored), fetch polling backendu (`/api/*`) každých několik
  sekund — ŽÁDNÉ websockety nejsou nutné, ale jsou vítané jako vylepšení.
- Zdrojová data — VŽDY jen číst, nikdy nezapisovat (kromě restart akce):

### 1. Graf využití (bod 1 zadání)
Primární zdroj: `~/.hermes/scripts/claude_usage_history.jsonl` — JSONL,
každý řádek:
```json
{"ts": "...", "session_pct": 27, "session_reset": "...", "week_pct": 34, "week_reset": "..."}
```
To je % vyčerpání Claude Code subscription kvóty (5h session okno + týdenní
okno) — **přesně to, co má smysl zobrazit s osou 0 % dole a 100 % nahoře**.
Graf musí mít:
- přepínač časového okna (např. 6h / 24h / 7d / 30d / vše),
- fixní Y osu 0–100 %,
- dvě čáry: `session_pct` a `week_pct` (barevně odlišit), host-local čas.
Druhotně (volitelně, pokud zbude čas): per-profil token/cost graf ze
`state.db` (`~/.hermes/state.db` pro `default`, `~/.hermes/profiles/<jméno>/state.db`
pro ostatní) — tabulky `session_model_usage` (input/output/cache tokens,
`estimated_cost_usd`, `actual_cost_usd`) JOIN `sessions` (`started_at`).
Tohle NEMÁ přirozenou 0–100% osu, dát jako samostatný panel (bar/line
v tokenech nebo $), ne do stejného grafu jako kvóta.

### 2. Gateway stav (bod 2 zadání — "velej gateway" = stav gateway)
Zdroj: `~/.hermes/gateway_state.json` (JSON, jeden soubor, přepisuje se živě).
Obsahuje: `pid`, `gateway_state` (running/...), `active_agents`,
`served_profiles` (list profilů), `platforms` (per-profil+platforma stav
connected/error), `code_version`, `code_sha`, `updated_at`. Panel: badge
"gateway running/down" + uptime (z `start_time`, je to CPU jiffies/HZ — pokud
přesný uptime nejde snadno spočítat, stačí "updated_at" jako heartbeat),
tabulka platforma×profil se zeleným/červeným stavem.

### 3. Agenti (bod 3 zadání)
Pro každý ze 6 profilů panel s:
- connected/disconnected (z `gateway_state.json` `platforms`),
- "co dělá teď" — `gateway_state.json.active_work` pokud je vyplněné (teď
  bývá `null` = idle), jinak ukázat "idle",
- poslední cron run a next run (viz bod cron níže),
- **počet aktuálně živých sub-agentů** — ŽÁDNÝ existující zdroj pravdy pro
  živé subagenty na tomto hostu neexistuje (TodoStore i subagent tracking
  jsou jen v živé konverzaci, ne v souboru). Implementuj best-effort: spočítej
  počet child procesů PID gateway (`ps --ppid <gateway_pid> -o pid,etime,cmd`
  rekurzivně), heuristicky řekni "N aktivních procesů" a v UI tooltipu
  jasně napiš, že je to odhad podle procesů, ne přesný počet sub-agentů.
  Pokud to bude nespolehlivé/šumné, je přijatelné ukázat jen "N/A" s
  vysvětlivkou — nehádat čísla.
- (volitelně) krátká historie: posledních N řádků z `hermes logs --component
  agent --since 1h` nebo `~/.hermes/profiles/<p>/agent.log` tail, pro
  "co dělal" kontext.

### 4. Cron úlohy
Zdroj: `~/.hermes/cron/jobs.json` (profil `default`) a
`~/.hermes/profiles/<jméno>/cron/jobs.json` (ostatní profily) — JSON list
objektů s `name`, `schedule_display`, `next_run_at`, `last_run_at`,
`last_status`, `failure_streak`, `enabled`. Alternativně/doplňkově
`hermes -p <profil> cron list --all` (textový výstup) a
`hermes -p <profil> cron incidents` pro nevyřešené failed joby. Panel: per
profil tabulka jobů se stavem (ok/error/paused), zvýraznit failure_streak>0.

### 5. Chyby / incidenty (vlastní nápad, odsouhlaseno uživatelem)
`hermes logs errors --since 24h` (nebo přímo `errors.log` v profilu, pokud
existuje) + `hermes cron incidents` — spojit do jednoho "co teď hoří" panelu,
řazeno od nejnovějšího, barevně (warning/error/critical).

### 6. Stav GitHub repo (vlastní nápad)
`gh repo view RIT-vitkubot/<repo> --json pushedAt,defaultBranchRef` +
`gh pr list --repo RIT-vitkubot/<repo> --state open --json number,title,url`
pro repa: `process-supervisor`, `sysstatus-history`, `profile-health-check`,
`shared-error-log`, `auto-pr-review`, `hermes-mission-control` (sebe sama).
Cachovat výsledek na backendu (např. 5 min TTL), ať se nespamuje GitHub API.

### 7. Restart tlačítka (bod 5 zadání)
Jedno tlačítko "Restart Hermes gateway" → `POST /api/restart` → backend spustí
`hermes gateway restart` (subprocess, timeout, zachytit stdout/stderr, vrátit
JSON s výsledkem). Frontend: JEN `confirm("Opravdu restartovat celý Hermes
gateway (všech 6 profilů)?")` před odesláním POSTu — **žádná autentizace,
žádný token, žádné heslo** (výslovné přání uživatele — soukromá VPN/LAN).

## Technické požadavky
- Python 3.9+, stdlib only na backendu (žádné pip instally na hostu bez
  domluvy — host nemá Flask ani jiné web frameworky).
- Frontend může použít Three.js z CDN (`<script type="module" src="https://unpkg.com/three@.../build/three.module.js">`)
  — žádný build step (webpack/vite) není k dispozici/žádaný, čisté statické
  soubory.
- Žádné externí databáze/porty navíc — jen jeden HTTP server proces.
- `/healthz` endpoint pro process-supervisor (vzor z `process-supervisor`
  repa — tenhle dashboard by měl časem běžet pod ním).
- README s instrukcemi jak spustit (`python3 server.py --port 8090 --bind
  127.0.0.1,10.8.0.25`), jaké soubory/cesty čte, a jasně napsané "tento
  proces nevolá žádné LLM API, jen čte lokální soubory/DB/CLI výstupy".
- Testy aspoň pro parsing/agregační funkce (parsování jsonl, čtení jobs.json),
  ne nutně pro HTTP vrstvu.

## Co NEDĚLAT
- Nepsat žádnou autentizaci/login (vlastnost #5 zadání).
- Nevolat žádné `hermes -z`/`claude -p` ani jiné LLM invokace za běhu serveru.
- Nemazat/nepřepisovat žádná existující data (`state.db`, `jobs.json`,
  `gateway_state.json` apod.) — jen číst. Jediný zápis je spuštění
  `hermes gateway restart` jako subprocess.
- Nemergovat PR sám — otevřít PR a počkat na schválení (Parmic merguje
  explicitně, stejně jako u předchozích 4 repo).

## Kontext hostu (pro orientaci, nemusí být 1:1 použito)
- `~/.hermes/profiles/programovani/scripts/board.py` — existující obdoba
  (stdlib http.server, žádný Flask), dobrý vzor pro strukturu backendu.
- `~/.hermes/profiles/programovani/scripts/sysstatus.py` — má
  `collect()`/`--json`, vrací read-only přehled stavu, dá se znovu použít
  nebo inspirovat.
- GitHub org `RIT-vitkubot`, repo `hermes-mission-control` (toto).
