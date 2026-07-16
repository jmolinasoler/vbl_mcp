# Examples

- [docker-compose.coolify.yml](docker-compose.coolify.yml) — Docker Compose file for deploying vbl-mcp on Coolify, either from the prebuilt Docker Hub image or building from this repository. Includes the Coolify `SERVICE_FQDN` magic variable for automatic domain wiring and a container health check against `/health`.

After deploying, verify:

```bash
curl https://your-domain/health   # health JSON
open https://your-domain/         # status dashboard
```

And connect an MCP client to `https://your-domain/mcp`:

```bash
claude mcp add --transport http vbl https://your-domain/mcp \
  --header "Authorization: Bearer <token>"   # only if MCP_AUTH_TOKEN is set
```
