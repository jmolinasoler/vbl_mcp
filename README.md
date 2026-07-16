# vbl-mcp

MCP (Model Context Protocol) server for the public **Basketball Vlaanderen** (VBL) API — the `vblcb.wisseq.eu` backend used by [basketbal.vlaanderen](https://www.basketbal.vlaanderen). Read-only.

Official API documentation: [ApiDocV2.pdf](docs/ApiDocV2.pdf) ([source](https://www.basketbal.vlaanderen/documenten/Clubondersteuning/ApiDocV2.pdf)).

> **Terms of use (from the official document):** the APIs may only be used to integrate match calendars, results and standings on websites of clubs affiliated with Basketbal Vlaanderen vzw. Any other party or use requires contacting info@basketbal.vlaanderen.

## Features

- **Two transports**: stdio (local MCP clients) and Streamable HTTP (`/mcp`) for deployments.
- **Status dashboard** at `/` (HTTP mode): uptime, active sessions with client name/IP/last activity, tool-usage counters and a recent-calls log — so you can see who is using the server. Auto-refreshes every 15 s; stats are in-memory and reset on restart.
- **Health endpoint** at `/health`: JSON with uptime, session/call counters and a cached (60 s) reachability check of the upstream VBL API.
- **Optional bearer auth**: set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on `/mcp` (the dashboard and `/health` stay open).

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
claude mcp add --transport http vbl https://your-domain.example/mcp --header "Authorization: Bearer <token>"
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
docker build -t vbl-mcp .
```

Run it:

```bash
docker run -d --name vbl-mcp -p 3000:3000 vbl-mcp
# optionally protect the MCP endpoint:
docker run -d --name vbl-mcp -p 3000:3000 -e MCP_AUTH_TOKEN=change-me vbl-mcp
```

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
| `MCP_AUTH_TOKEN` | – | If set, `/mcp` requires `Authorization: Bearer <token>` |

## Deploying on Coolify

1. Push this repository to a Git provider Coolify can reach (GitHub, GitLab, Gitea, …).
2. In Coolify: **+ New → Application**, pick the repository and branch.
3. **Build Pack**: `Dockerfile` (Coolify detects the `Dockerfile` at the repo root automatically).
4. **Ports Exposes**: `3000`.
5. (Recommended) Add the environment variable `MCP_AUTH_TOKEN` with a strong secret so only your clients can call `/mcp`.
6. (Optional) In **Health Checks**, set the path to `/health` on port `3000` — or rely on the image's built-in Docker `HEALTHCHECK`.
7. Assign a domain and deploy. Coolify handles HTTPS via its proxy.

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
