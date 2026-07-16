# Examples

- [docker-compose.coolify.yml](docker-compose.coolify.yml) — Docker Compose file for deploying vbl-mcp on Coolify, either from the prebuilt Docker Hub image or building from this repository. Includes the Coolify `SERVICE_FQDN` magic variable for automatic domain wiring and a container health check against `/health`.
- [skills/vbl-basketball/](skills/vbl-basketball/SKILL.md) — example Agent Skill teaching an MCP client how to use this server well (GUID conventions, Dutch field glossary, typical workflows).

A public instance runs at **https://vblmcp.valvestudio.io** (dashboard at `/`, health at `/health`, MCP endpoint at `/mcp`, bearer token required).

## Connecting an MCP client

All examples point at the public instance; replace the URL with your own deployment and `<token>` with the value of its `MCP_AUTH_TOKEN`.

### Claude Code

```bash
claude mcp add --transport http vbl https://vblmcp.valvestudio.io/mcp \
  --header "Authorization: Bearer <token>"
```

### Hermes or any client with JSON MCP config (Streamable HTTP)

```json
{
  "mcpServers": {
    "vbl": {
      "type": "http",
      "url": "https://vblmcp.valvestudio.io/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```

### Clients that only speak stdio (e.g. Claude Desktop)

Bridge with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "vbl": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://vblmcp.valvestudio.io/mcp",
        "--header",
        "Authorization: Bearer <token>"
      ]
    }
  }
}
```

## Installing the example skill

The skill is client-agnostic markdown. For Claude Code, copy it into a skills directory:

```bash
# project-scoped
cp -r examples/skills/vbl-basketball .claude/skills/
# or user-scoped
cp -r examples/skills/vbl-basketball ~/.claude/skills/
```

For Hermes or other clients that support Agent Skills, point the client at the `examples/skills/vbl-basketball` folder (a skill is a folder with a `SKILL.md` whose frontmatter carries the name and trigger description).

## Verifying a deployment

```bash
curl https://vblmcp.valvestudio.io/health   # health JSON
open https://vblmcp.valvestudio.io/         # status dashboard
```
