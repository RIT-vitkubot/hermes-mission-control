# hermes-mission-control

Read-only, **zero-LLM-token** futuristický 3D monitorovací dashboard pro Hermes
multi-agent systém (6 profilů: `default` = BMO, `editor`, `obchodnik`,
`programovani`, `skola`, `tegistic`).

> **Tento proces nevolá žádné LLM API a nestojí žádné tokeny.** Jen čte lokální
> soubory, SQLite databáze (read-only režim) a výstupy `hermes` / `gh` CLI.
> Jediná akce se side-effectem je `hermes gateway restart` po kliknutí na
> tlačítko v UI.

## Spuštění

Požadavky: Python 3.9+ (jen stdlib — žádný Flask, žádné pip instally),
moderní prohlížeč s WebGL. Three.js se načítá z CDN (unpkg), žádný build step.

```bash
python3 server.py --port 8090 --bind 127.0.0.1,10.8.0.25
# pak otevřít http://127.0.0.1:8090/  (nebo přes WireGuard http://10.8.0.25:8090/)
```

| volba / env               | default         | význam |
|---------------------------|-----------------|--------|
| `--port` / `MC_PORT`      | `8090`          | port |
| `--bind` / `MC_BIND`      | `127.0.0.1`     | čárkou oddělené bind adresy; adresa, kterou nejde nabindovat, se jen zaloguje |
| `--hermes-home` / `HERMES_HOME` | `~/.hermes` | kořen Hermes dat |
| `--no-cli`                | vypnuto         | nevolat `hermes logs errors` / `hermes cron incidents`, jen číst soubory |
| `MC_HERMES_BIN`, `MC_GH_BIN` | z `PATH`     | cesta k `hermes` / `gh` |

Stroj **není** veřejně přístupný (jen VPN/LAN), proto dashboard záměrně nemá
žádnou autentizaci — ani restart endpoint (jen `confirm()` dialog ve frontendu).
`POST /api/restart` vyžaduje `Content-Type: application/json`; to není auth, jen
zábrana proti tomu, aby restart spustil obyčejný cross-site HTML formulář.

### Lokální náhled s demo daty

```bash
python3 tools/make_demo_home.py /tmp/demo-hermes
HERMES_HOME=/tmp/demo-hermes python3 server.py --port 8090
```

### Pod process-supervisorem

`GET /healthz` vrací `{"ok": true, ...}` (HTTP 200). Proces se čistě ukončí na
`SIGTERM`.

## Co dashboard ukazuje a odkud to čte

Pro `default` je `<home>` = `~/.hermes`, pro ostatní profily
`~/.hermes/profiles/<profil>`.

| panel | zdroj (vždy jen čtení) |
|-------|------------------------|
| Claude kvóta — graf `session_pct` / `week_pct`, osa fixně 0–100 %, okna 6h/24h/7d/30d/vše, host-local čas | `~/.hermes/scripts/claude_usage_history.jsonl` |
| Gateway — running/down, PID, uptime (z `/proc/<pid>/stat`), heartbeat `updated_at`, verze, matice profil × platforma | `~/.hermes/gateway_state.json`, `/proc` |
| Agenti — connected, co dělá teď (`active_work`, jinak idle), poslední/další cron run, odhad procesů, tail `agent.log` | `gateway_state.json`, `<home>/cron/jobs.json`, `/proc`, `<home>/agent.log` |
| Cron úlohy — per profil, stav ok/error/paused/pending, zvýrazněný `failure_streak` | `<home>/cron/jobs.json` |
| Co teď hoří — chyby + incidenty za 24 h, od nejnovějšího | `<home>/logs/errors.log` nebo `<home>/errors.log` (fallback `hermes [-p P] logs errors --since 24h`), `hermes [-p P] cron incidents` (fallback: failující joby z `jobs.json`) |
| GitHub repa — poslední push, default branch, otevřené PR (cache 5 min) | `gh repo view`, `gh pr list` pro `process-supervisor`, `sysstatus-history`, `profile-health-check`, `shared-error-log`, `auto-pr-review`, `hermes-mission-control` |
| Tokeny / $ per profil (14 dní) | `<home>/state.db` — `session_model_usage` JOIN `sessions`, otevřeno `mode=ro` |
| BMO + speech bubble | agregace všeho výše (`summary` v `/api/state`) |

### Detailní náhledy (modaly)

Klikatelné detaily běží čistě na klientovi (hash routing, žádný nový stav na
backendu, jen čtecí GET endpointy výše). Odkazy jdou sdílet / bookmarkovat:

| URL | obsah |
|-----|-------|
| `#/agent/<profil>` | stav profilu, platformy, procesy, jeho cron joby, graf tokenů/$ jen za profil (30 dní), incidenty 7 dní, `agent.log` tail (100/300/1000 řádků, filtr závažnosti, hledání) |
| `#/cron/<profil>/<job>` | detail jobu, úspěšnost, medián intervalu, pruh posledních běhů, historie běhů s výstupem (filtr „jen chyby“) |
| `#/incidents?profile=&level=&hours=` | plný log chyb/incidentů s filtrem profilu, závažnosti, období (24h/3d/7d) a fulltextem |

Do detailů se jde kliknutím na jméno agenta / „detail profilu ›“, jméno cron
jobu, „plný log ›“ v panelu incidentů nebo profil u incidentu. Zavření: `Esc`,
✕, klik mimo okno nebo „dashboard“ v drobečkové navigaci; tlačítko ⟳ data
znovu načte. Stav běhu z `cron/output` je odhad z obsahu výstupu
(`(FAILED)` v nadpisu / sekce `## Error`).

**Počet sub-agentů:** na hostu neexistuje zdroj pravdy pro živé sub-agenty.
Dashboard ukazuje jen *odhad* — počet potomků procesu gateway (rekurzivně
přes `/proc`), přiřazený k profilu podle `-p <profil>` / `profiles/<profil>/`
v command line. V UI je to označené jako odhad; když PID gateway neběží,
zobrazí se `N/A`.

CLI volání (`hermes …`, `gh …`) běží na pozadí s timeoutem a cache, takže
HTTP požadavky nikdy nečekají na pomalé CLI.

## API

| endpoint | popis |
|----------|-------|
| `GET /healthz` | liveness |
| `GET /api/state` | gateway, agenti, cron, incidenty, odhad procesů, BMO summary |
| `GET /api/usage?window=6h\|24h\|7d\|30d\|all` | historie kvóty (downsamplováno na ≤ 1500 bodů se zachováním špiček) |
| `GET /api/tokens?days=14` | tokeny/náklady per profil a den |
| `GET /api/github` | stav repozitářů (cache 5 min) |
| `GET /api/agent-log?profile=P&lines=300` | delší tail `agent.log` (max 2000 řádků) pro detail profilu |
| `GET /api/cron/runs?profile=P&job=ID\|jméno&limit=50` | historie běhů jobu z `<home>/cron/output/<job_id>/*.md` (fallback: poslední běh z `jobs.json`) |
| `GET /api/incidents?profile=P&level=warning\|error\|critical&hours=24..168` | chyby + incidenty až 7 dní zpět, filtr profilu a minimální závažnosti |
| `POST /api/restart` | `hermes gateway restart`, vrací `{ok, returncode, stdout, stderr, duration}` |

## Struktura

```
server.py                     entry point
mission_control/parsing.py    čisté parsovací/agregační funkce (testované)
mission_control/collectors.py čtení souborů, SQLite, /proc, CLI + cache
mission_control/server.py     stdlib http.server, routing
mission_control/static/       index.html, style.css, app.js (panely, grafy), bmo.js (Three.js BMO)
tools/make_demo_home.py       generátor demo ~/.hermes stromu
tests/                        unittest testy
```

## Testy

```bash
python3 -m unittest discover -s tests -t .
```
