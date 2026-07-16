# vbl-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

MCP (Model Context Protocol) server for the public **Basketball Vlaanderen** (VBL) API — the `vblcb.wisseq.eu` backend used by [basketbal.vlaanderen](https://www.basketbal.vlaanderen). Read-only.

Repository: [github.com/jmolinasoler/vbl_mcp](https://github.com/jmolinasoler/vbl_mcp) · Docker image: [jmolinaso/vbl-mcp](https://hub.docker.com/r/jmolinaso/vbl-mcp) · Public instance: [vblmcp.valvestudio.io](https://vblmcp.valvestudio.io/)

See [examples/](examples/README.md) for ready-made MCP client configurations (Claude Code, Hermes, stdio-only clients via `mcp-remote`), a Coolify Docker Compose file, and a [`/vbl` Agent Skill](examples/skills/vbl/SKILL.md) that runs the right queries from a single slash command.

Official API documentation: [ApiDocV2.pdf](docs/ApiDocV2.pdf) ([source](https://www.basketbal.vlaanderen/documenten/Clubondersteuning/ApiDocV2.pdf)).

> **Terms of use (from the official document):** the APIs may only be used to integrate match calendars, results and standings on websites of clubs affiliated with Basketbal Vlaanderen vzw. Any other party or use requires contacting info@basketbal.vlaanderen.

## Features

- **Two transports**: stdio (local MCP clients) and Streamable HTTP (`/mcp`) for deployments.
- **Status dashboard** at `/` (HTTP mode): uptime, active sessions with client name/IP/last activity, tool-usage counters and a recent-calls log — so you can see who is using the server. Auto-refreshes every 15 s; stats are in-memory and reset on restart.
- **Health endpoint** at `/health`: JSON with uptime, session/call counters and a cached (60 s) reachability check of the upstream VBL API.
- **API key management from the app**: create and revoke keys from the dashboard (or via `/admin/keys`), protected by an admin token. Keys can also be seeded via `MCP_API_KEYS` (`hermes:key1,claude:key2`); all of them require the `X-API-Key` header on `/mcp` (the dashboard and `/health` stay open).
- **Usage metering per request**: every tool call records estimated tokens in/out (≈ characters ÷ 4) and duration. Aggregates per key and per tool are **persisted** to disk as the basis for usage-based billing; the dashboard shows per-request consumption and per-key totals.

## Tools

| Tool | VBL endpoint | Description |
|---|---|---|
| `list_clubs` | `OrgList?p=1` | All clubs, with optional filter on name/city/region/stam number |
| `get_club` | `OrgDetailByGuid` | Club detail: teams and their poules, website, address, venues (`accomms`), board (`bestuur`) |
| `get_club_members` | `RelatiesByOrgGuid` | Registered members of a club (players, coaches, …) |
| `get_club_matches` | `OrgMatchesByGuid` | All matches of all teams of a club |
| `get_team` | `TeamDetailByGuid` | Team detail: official standings of its poules, roster (`spelers`) and staff (`tvlijst`) |
| `get_team_matches` | `TeamMatchesByGuid` | Calendar and results of one team |
| `get_poule_matches` | `PouleMatchesByGuid` | Full calendar and results of a poule (series) |
| `get_poule_standings` | `TeamDetailByGuid` | **Official** standings of a poule (rangNr, wedPunt, ptVoor/ptTegen, …); falls back to standings computed from played matches |
| `get_match` | `MatchesByWedGuid` | Full match detail (rescheduling history optional) |
| `get_match_lineup` | `DwfDeelByWedGuid` (PUT) | Digital scoresheet (DWF) lineups; `null` when not yet available |

## Local development

```bash
git clone https://github.com/jmolinasoler/vbl_mcp.git
cd vbl_mcp
npm install
npm run build

# stdio mode (default) — for Claude Code / Claude Desktop
npm start

# HTTP mode — dashboard on http://localhost:3000
npm run start:http
```

### Claude Code

The repo ships a `.mcp.json`, so opening this directory with Claude Code registers the server automatically (stdio). To register it globally:

```bash
claude mcp add vbl -- node /path/to/vbl_mcp/dist/index.js
```

To use a deployed instance over HTTP instead:

```bash
claude mcp add --transport http vbl https://your-domain.example/mcp
# with auth:
claude mcp add --transport http vbl https://your-domain.example/mcp --header "X-API-Key: <key>"
```

### Claude Desktop

```json
{
  "mcpServers": {
    "vbl": {
      "command": "node",
      "args": ["/path/to/vbl_mcp/dist/index.js"]
    }
  }
}
```

## Docker

Build the image:

```bash
git clone https://github.com/jmolinasoler/vbl_mcp.git
cd vbl_mcp
docker build -t vbl-mcp .
```

Run it:

```bash
docker run -d --name vbl-mcp -p 3000:3000 \
  -v vbl-mcp-data:/app/data \
  -e ADMIN_TOKEN=change-me-admin \
  vbl-mcp
```

Then open `http://localhost:3000/`, paste the admin token and create your first API key from the dashboard. The `/app/data` volume keeps keys and usage metering across restarts. You can also seed keys via `-e MCP_API_KEYS="hermes:change-me"`.

Verify:

```bash
curl http://localhost:3000/health   # health JSON
open http://localhost:3000/         # status dashboard
```

The image is a multi-stage build (Node 22 alpine, dev dependencies pruned, runs as the non-root `node` user) and declares a Docker `HEALTHCHECK` against `/health`.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `MCP_TRANSPORT` | – | Set to `http` to force HTTP mode (the container CMD already passes `--http`) |
| `MCP_API_KEYS` | – | Seed API keys, comma-separated and optionally labeled: `label:key,label2:key2`. Imported into the persistent store at startup |
| `ADMIN_TOKEN` | – | Enables the admin API and the key-management UI on the dashboard (`X-Admin-Token` header). Unset = key management disabled |
| `DATA_DIR` | `./data` (`/app/data` in Docker) | Where API keys and usage metering are persisted (`store.json`) |

## API keys & usage metering

Set `ADMIN_TOKEN` and the dashboard (`/`) gains a key-management panel: paste the admin token, give the key a label (one per client) and hit **Create API key** — the full key is shown only once. Revoking a key immediately returns 401 to its clients.

The same operations are available as an admin API (header `X-Admin-Token`):

```bash
# create
curl -X POST https://your-domain/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"label":"hermes"}'
# list with usage (requests, errors, tokens in/out, per-tool breakdown)
curl https://your-domain/admin/keys -H "X-Admin-Token: $ADMIN_TOKEN"
# revoke
curl -X DELETE https://your-domain/admin/keys/<id> -H "X-Admin-Token: $ADMIN_TOKEN"
```

Every tool call is metered: estimated tokens in (arguments) and out (response), computed as ≈ characters ÷ 4, plus duration and error flag. Aggregates per key and per tool are persisted in `DATA_DIR/store.json` — `GET /admin/keys` is effectively the billing export. The dashboard additionally shows the last 50 calls with their individual consumption. Single-tenant for now: one flat list of keys, one admin.

## Publishing to Docker Hub

### Automatically (GitHub Actions)

The repo ships a workflow ([.github/workflows/docker-publish.yml](.github/workflows/docker-publish.yml)) that builds a multi-arch image (`linux/amd64` + `linux/arm64`) and pushes it to Docker Hub on every push to `main` and on version tags (`v*`). One-time setup:

1. On Docker Hub, create the repository (published as [`jmolinaso/vbl-mcp`](https://hub.docker.com/r/jmolinaso/vbl-mcp)) and an access token (**Account Settings → Personal access tokens**, *Read & Write*).
2. On GitHub (**Settings → Secrets and variables → Actions**), add two repository secrets:
   - `DOCKERHUB_USERNAME` — your Docker Hub username
   - `DOCKERHUB_TOKEN` — the access token
3. Push to `main` (publishes `:latest` and `:sha-…`) or tag a release (`git tag v0.2.0 && git push --tags` publishes `:0.2.0` and `:0.2`).

### Manually

```bash
docker login
docker build -t jmolinaso/vbl-mcp:latest .
docker push jmolinaso/vbl-mcp:latest
```

## Deploying on Coolify

### Option A — from Docker Hub (recommended once published)

1. In Coolify: **+ New → Docker Image** and enter the image name: `jmolinaso/vbl-mcp:latest`.
2. **Ports Exposes**: `3000`.
3. (Recommended) Add the environment variable `ADMIN_TOKEN` with a strong secret, then create per-client API keys from the dashboard (or seed them with `MCP_API_KEYS`).
4. In **Persistent Storage**, add a volume mounted at `/app/data` so API keys and usage metering survive redeploys.
5. (Optional) In **Health Checks**, set the path to `/health` on port `3000` — or rely on the image's built-in Docker `HEALTHCHECK`.
6. Assign a domain and deploy. Coolify handles HTTPS via its proxy.

To pick up a new version, push the updated image and hit **Redeploy** (with the `:latest` tag Coolify re-pulls the image; pin a version tag like `:0.2.0` if you prefer explicit upgrades).

### Option B — build from the Git repository

1. In Coolify: **+ New → Application**, choose **Public Repository** and enter `https://github.com/jmolinasoler/vbl_mcp` (branch `main`).
2. **Build Pack**: `Dockerfile` (Coolify detects the `Dockerfile` at the repo root automatically).
3. Continue with steps 2-6 of Option A (port `3000`, `ADMIN_TOKEN`, persistent storage on `/app/data`, health check, domain).

### Option C — Docker Compose

A ready-made compose file lives at [examples/docker-compose.coolify.yml](examples/docker-compose.coolify.yml): pick **Build Pack: Docker Compose** with that file as *Docker Compose Location*, or paste it into **+ New → Docker Compose Empty**. It pulls the Docker Hub image (or optionally builds from the repo), wires the domain via Coolify's `SERVICE_FQDN` magic variable and includes the `/health` container health check.

After deploying:

- `https://your-domain/` — status dashboard (who is connected, tool usage).
- `https://your-domain/health` — health check (JSON, includes upstream VBL API reachability).
- `https://your-domain/mcp` — MCP Streamable HTTP endpoint for clients.

## GUIDs

- **Club**: `BVBL1004` (Antwerp Giants)
- **Team**: `BVBL1004HSE  2` — team GUIDs contain **two spaces**; pass them exactly as returned by `get_club`
- **Poule**: `BVBL26279180NAHSE11A` (Top Division Men 1, season 2026-27; the 4 digits after `BVBL` encode the season)
- **Match**: `BVBL26279180NAHSE11AAB`

## Notes

- The API only serves current-season data; past seasons are purged.
- Field names are Dutch (`naam` = name, `plaats` = city, `uitslag` = result, `gespeeld` = played, `tT`/`tU` = home/away team, `wedPunt` = competition points, `ptVoor`/`ptTegen` = points for/against).
- The officially documented endpoints are the five wisseq methods in the table (`OrgDetailByGuid`, `OrgMatchesByGuid`, `RelatiesByOrgGuid`, `TeamDetailByGuid`, `TeamMatchesByGuid`). `OrgList`, `PouleMatchesByGuid`, `MatchesByWedGuid` and the DWF endpoints live on the same backend and are used by the official website, but are not part of the PDF.
- Errors use standard HTTP status codes (400, 404, 500, …) per the official document.

## License

[MIT](LICENSE) — © 2026 Julio Molina Soler. Note that the license covers this server's code only; usage of the VBL API itself is subject to the terms quoted at the top of this README.
