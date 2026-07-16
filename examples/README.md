# Examples

- [docker-compose.coolify.yml](docker-compose.coolify.yml) — Docker Compose file for deploying vbl-mcp on Coolify, either from the prebuilt Docker Hub image or building from this repository. Includes the Coolify `SERVICE_FQDN` magic variable for automatic domain wiring and a container health check against `/health`.
- [skills/vbl/](skills/vbl/SKILL.md) — example Agent Skill: invoke `/vbl <question>` and it runs the right queries against this server (GUID conventions, Dutch field glossary and workflows built in).

A public instance runs at **https://vblmcp.valvestudio.io** (dashboard at `/`, health at `/health`, MCP endpoint at `/mcp`, API key required).

## Connecting an MCP client

All examples point at the public instance; replace the URL with your own deployment and `<key>` with one of the keys configured in its `MCP_API_KEYS`.

### Claude Code

```bash
claude mcp add --transport http vbl https://vblmcp.valvestudio.io/mcp \
  --header "X-API-Key: <key>"
```

### Hermes or any client with JSON MCP config (Streamable HTTP)

```json
{
  "mcpServers": {
    "vbl": {
      "type": "http",
      "url": "https://vblmcp.valvestudio.io/mcp",
      "headers": {
        "X-API-Key": "<key>"
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
        "X-API-Key: <key>"
      ]
    }
  }
}
```

Tip: give each client its own labeled key (`MCP_API_KEYS="hermes:key1,claude:key2"`) and the server's dashboard will show which client each session belongs to.

## Installing the example skill

The skill is client-agnostic markdown. For Claude Code, copy it into a skills directory:

```bash
# project-scoped
cp -r examples/skills/vbl .claude/skills/
# or user-scoped
cp -r examples/skills/vbl ~/.claude/skills/
```

Then just type `/vbl <question>`, e.g.:

```
/vbl clasificación de la Top Division Men 1
/vbl when does Antwerp Giants play next?
```

For Hermes or other clients that support Agent Skills, point the client at the `examples/skills/vbl` folder (a skill is a folder with a `SKILL.md` whose frontmatter carries the name and trigger description; the client substitutes `$ARGUMENTS` with the text after `/vbl`).

## Verifying a deployment

```bash
curl https://vblmcp.valvestudio.io/health   # health JSON
open https://vblmcp.valvestudio.io/         # status dashboard
```
