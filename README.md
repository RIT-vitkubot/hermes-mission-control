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
| Tokeny / $ per profil (14 dní) + projekce útraty do konce měsíce | `<home>/state.db` — `session_model_usage` JOIN `sessions`, otevřeno `mode=ro` |
| Projekce kvóty („100 % za X“) | lineární trend z `claude_usage_history.jsonl` od posledního resetu |
| Restarty gateway | volání `/api/restart` + změny PID / startu gateway zachycené při pollingu (jen v paměti) |
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

### Živá obnova, zkratky, projekce

- **Auto-refresh bez blikání:** panely se překreslí jen když se jejich obsah
  opravdu změní; rozbalené detaily (`agent.log`, incidenty, restarty) a scroll
  pozice polling přežijí. Na každý endpoint letí max. jeden požadavek, ve skryté
  záložce se nepolluje a po návratu se data hned načtou. V hlavičce je
  „aktualizováno před X s“ — po 15 s bez úspěšného `/api/state` zežloutne,
  při chybě zčervená. Favicon (BMO) mění barvu podle stavu a titulek záložky
  ukazuje počet problémů, takže stav je vidět i z jiné záložky.
- **Klávesové zkratky** (`?` nebo tlačítko `?` v hlavičce = nápověda, `#/help`):

  | klávesa | akce |
  |---------|------|
  | `?` | nápověda |
  | `/` | hledání — v otevřeném detailu, jinak otevře plný log incidentů s kurzorem v hledání |
  | `g a` / `g s` / `g u` / `g i` / `g c` / `g t` / `g r` / `g g` | skok na agenty / gateway / kvótu / incidenty / cron / tokeny / GitHub / nahoru |
  | `g l` | plný log incidentů |
  | `1`–`5` | okno grafu kvóty 6h / 24h / 7d / 30d / vše |
  | `$` | tokeny ↔ $ |
  | `r` | načíst data hned (v detailu obnovit detail) |
  | `Esc` | zavřít detail / opustit pole |

- **Projekce kvóty:** lineární regrese bodů od posledního resetu (session: 3 h,
  týden: 48 h zpět). Když by 100 % padlo až po očekávaném resetu okna (5 h / 7 d
  od začátku segmentu), ukáže se „do resetu na 100 % nedojde“.
- **Projekce útraty / tokenů do konce měsíce** (`/api/forecast`): měsíc dosud +
  průměr posledních 7 celých dní × zbývající dny; dnešek se počítá aspoň tímto
  tempem. Srovnání s minulým měsícem se neukazuje, pokud data v `state.db`
  začínají až v jeho průběhu. $ = `actual_cost_usd`, jinak `estimated_cost_usd`.
- **Restarty gateway:** v panelu Gateway („Restarty“) — každé volání
  `/api/restart` (výsledek, rc, doba, IP klienta) a přechody gateway
  down / up / restart (nový PID nebo jiný čas startu z `/proc`) viděné od
  spuštění dashboardu. **Drží se jen v paměti procesu**, nic se nezapisuje na
  disk; restart dashboardu historii vymaže.
- **BMO nálady podle typu problému** (`summary.cause` / `summary.mood`):

  | příčina | nálada | projev |
  |---------|--------|--------|
  | vše OK | `happy` | tyrkysová, mává, mrká |
  | vše OK a nějaký agent pracuje | `busy` | „píše“ na klávesnici, kouká po orbitu pracujícího agenta |
  | chyba platformy / chyby v logu | `worried` | žlutá, těkavé oči, rovná pusa |
  | padající cron joby (≥ 3 = error) | `alarmed` | červená, třese se, mává rukama, „!“ nad hlavou |
  | kvóta ≥ 90 % | `tired` | oranžová, přivřené oči, kapka potu, zívá |
  | gateway dole / chybí state | `down` | X oči, sesunutý, blikající obrazovka, orbity profilů spadnou na zem |

  Náhled bez čekání na problém: `http://127.0.0.1:8090/?bmo=tired` (jen vizuál).
- **Favicon + web app manifest** (`/favicon.svg`, `/icon-192.png`,
  `/icon-512.png`, `/manifest.webmanifest`) a meta tagy pro sdílení odkazu
  (`og:*`, `noindex` — je to privátní dashboard).

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
| `GET /api/state` | gateway, agenti, cron, incidenty, odhad procesů, BMO summary (`level`, `mood`, `cause`), `restarts` |
| `GET /api/usage?window=6h\|24h\|7d\|30d\|all` | historie kvóty (downsamplováno na ≤ 1500 bodů se zachováním špiček) + `forecast` (ETA 100 %) |
| `GET /api/forecast` | útrata a tokeny za měsíc dosud + projekce do konce měsíce, celkem i per profil (cache 5 min) |
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
mission_control/static/       index.html, style.css, app.js (panely, grafy, zkratky), bmo.js (Three.js BMO),
                              favicon.svg, icon-*.png, manifest.webmanifest
tools/make_demo_home.py       generátor demo ~/.hermes stromu
tests/                        unittest testy
```

## Testy

```bash
python3 -m unittest discover -s tests -t .
```
