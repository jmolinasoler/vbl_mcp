# API Keys

This page explains how to configure and use API keys for the HTTP deployment of
`vbl-mcp`.

## What the keys protect

An API key authenticates an MCP client calling the Streamable HTTP endpoint:

```text
POST https://your-domain.example/mcp
```

When at least one key has been provisioned, every `POST`, `GET`, and `DELETE`
request to `/mcp` must include the key in the `X-API-Key` header. A missing,
invalid, or revoked key returns HTTP `401`.

API keys do not authenticate requests to the upstream Basketball Vlaanderen API.
That upstream API is accessed by this server and is public/read-only according
to the terms described in the [main README](../README.md). API keys are the
credentials that your MCP clients use to access your `vbl-mcp` HTTP deployment.

### Credential types

| Credential | Header or location | Used for |
|---|---|---|
| MCP API key | `X-API-Key` | Calling `/mcp` from an MCP client |
| Admin token | `X-Admin-Token` | Scripted access to `/admin/keys` |
| Dashboard account | Login form and HTTP-only session cookie | Dashboard access and key management in the browser |

An `X-Admin-Token` is not an MCP API key. Do not send it to `/mcp`.

## Choose a provisioning method

There are two ways to create an MCP API key:

- **Environment variable:** useful for deployment automation and bootstrapping.
- **Dashboard or admin API:** useful for creating one labeled key per client and rotating keys without changing the deployment configuration.

Use a different key for each client or integration. The label appears in the
dashboard and usage export, making it possible to attribute requests to a
specific client.

## Provision keys with `MCP_API_KEYS`

Set `MCP_API_KEYS` when starting the HTTP server. Its value is a comma-separated
list in either of these forms:

```text
label:key
key-without-a-label
```

For example:

```bash
MCP_API_KEYS="hermes:replace-with-a-long-random-secret,claude:another-long-random-secret" \
  npm run start:http
```

An entry without a label receives an automatic label such as `key-1`:

```bash
MCP_API_KEYS="replace-with-a-long-random-secret" npm run start:http
```

The server imports environment-provisioned keys into its persistent store at
startup. Existing keys and their usage history are retained across restarts.
The key value is never returned by the list endpoint; only a masked preview is
shown after import.

### Docker

Pass the variable when starting the container and mount `/app/data` so keys
and usage survive container replacement:

```bash
docker run -d --name vbl-mcp -p 3000:3000 \
  -v vbl-mcp-data:/app/data \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD="use-a-password-at-least-8-characters" \
  -e MCP_API_KEYS="claude:replace-with-a-long-random-secret" \
  vbl-mcp
```

For Coolify, define `MCP_API_KEYS` in the application's environment variables.
The repository includes the corresponding commented setting in
[`examples/docker-compose.coolify.yml`](../examples/docker-compose.coolify.yml).

## Create keys from the dashboard

1. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` before the first start.
2. Open `https://your-domain.example/` and sign in.
3. Enter a label, preferably the name of one client or integration.
4. Select **Create API key**.
5. Copy the returned secret immediately and store it in the client's secret configuration.

The full generated key is displayed only once. Later dashboard views show a
masked preview. Generated keys have the form `vbl_...`.

The dashboard account is created only if that username does not already exist
in the persistent store. Changing `ADMIN_PASSWORD` after the first start does
not reset the stored password; use the dashboard's password-change action
instead.

If `ADMIN_USERNAME` and `ADMIN_PASSWORD` are not configured, the dashboard is
public and displays a warning. This does not make `/mcp` public after an API
key exists, but it does expose dashboard information such as client IPs and
usage. Configure a dashboard account for any public deployment.

## Create keys with the admin API

Set `ADMIN_TOKEN` if automation needs to create, list, or revoke keys without a
browser session. Keep this token separate from all client API keys:

```bash
export ADMIN_TOKEN='replace-with-a-separate-admin-secret'
```

Create a key. The response contains the full key, so capture it securely:

```bash
curl -sS -X POST https://your-domain.example/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label":"claude"}'
```

Example response:

```json
{
  "id": "a1b2c3d4",
  "label": "claude",
  "key": "vbl_replace-with-the-returned-secret"
}
```

List keys and usage. The `key` secret is not included in this response:

```bash
curl -sS https://your-domain.example/admin/keys \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

Revoke a key by its `id` from the list or create response:

```bash
curl -sS -X DELETE https://your-domain.example/admin/keys/a1b2c3d4 \
  -H "X-Admin-Token: $ADMIN_TOKEN"
```

The admin API can also be authorized by the dashboard login session. A logged-in
browser does not need `X-Admin-Token` for these endpoints.

## Configure an MCP client

Use the key in the `X-API-Key` header and point the client at `/mcp`.

### Claude Code

```bash
claude mcp add --transport http vbl https://your-domain.example/mcp \
  --header "X-API-Key: replace-with-your-client-key"
```

### JSON MCP clients

```json
{
  "mcpServers": {
    "vbl": {
      "type": "http",
      "url": "https://your-domain.example/mcp",
      "headers": {
        "X-API-Key": "replace-with-your-client-key"
      }
    }
  }
}
```

### Stdio-only clients

The local stdio transport does not use `X-API-Key`; it starts the server as a
local process. To connect a stdio-only client to a remote HTTP deployment, use
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "vbl": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-domain.example/mcp",
        "--header",
        "X-API-Key: replace-with-your-client-key"
      ]
    }
  }
}
```

For local development with the repository's default `.mcp.json`, run the
server in stdio mode. No HTTP API key is required because the client and server
run in the same local environment:

```bash
npm install
npm run build
npm start
```

## Verify a key

Check that the service is reachable without credentials:

```bash
curl -sS https://your-domain.example/health
```

The health endpoint is intentionally public and does not verify an API key.
To test the protected MCP endpoint, configure the key in an MCP client and
initialize a session. A request without the header should return a JSON-RPC
error similar to:

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32001,
    "message": "Unauthorized: missing or invalid X-API-Key header"
  },
  "id": null
}
```

The dashboard's **API keys & usage** section shows the key label, status, last
use, request count, errors, and estimated input/output token totals.

## Rotation and revocation

To rotate a key safely:

1. Create a new key with a new label or a label identifying the replacement.
2. Update the client with the new key and verify that it can connect.
3. Revoke the old key with the dashboard or `DELETE /admin/keys/:id`.

Revocation takes effect immediately. Existing and new requests using the
revoked key receive `401`. If the last remaining key is revoked, the server
stays locked down rather than reopening in unauthenticated mode.

Environment-provisioned keys are re-imported on every startup. If a revoked
environment key remains in `MCP_API_KEYS`, the next startup reactivates it.
Remove it from the deployment secret configuration when revoking it
permanently. Removing `MCP_API_KEYS` alone does not remove an already imported
key from `store.json`; revoke the key, or intentionally remove the persisted
store only as part of a controlled data migration or reset.

## Persistence and usage metering

Keys, revocation state, and per-key usage are stored in:

```text
DATA_DIR/store.json
```

`DATA_DIR` defaults to `./data` for a local HTTP process and `/app/data` in the
Docker image. Mount this directory as persistent storage in Docker or Coolify.
Without persistent storage, a replacement container loses the stored keys and
usage data.

Each tool call records:

- request count;
- estimated input and output tokens, using approximately characters divided by four;
- error count;
- per-tool totals; and
- last-used time.

Usage is available in the dashboard and from `GET /admin/keys`. Runtime
dashboard statistics such as active sessions reset on restart, but key usage is
persisted.

## Security checklist

- Use HTTPS for every remote MCP connection.
- Generate long, random key values when using `MCP_API_KEYS`; do not use examples such as `change-me` in production.
- Store `MCP_API_KEYS`, `ADMIN_TOKEN`, and dashboard passwords in a secret manager or deployment secret store.
- Do not commit API keys to Git or place them in browser-side JavaScript.
- Use one labeled key per client so access can be revoked and usage can be attributed independently.
- Mount `DATA_DIR` as protected persistent storage because it contains key material and usage records.
- Rotate keys when a client is decommissioned or a secret may have been exposed.
- Configure `ADMIN_USERNAME` and `ADMIN_PASSWORD` on public deployments.

## Troubleshooting

### `401 Unauthorized` from `/mcp`

Check that the client sends `X-API-Key` exactly, that the value is the full
secret rather than the masked dashboard preview, and that the key has not been
revoked. Header names are case-insensitive, but the value is not.

### `/mcp` is open without a key

This is expected only when the persistent store contains no API keys. As soon
as a key is created or imported, authentication is enabled. Removing
`MCP_API_KEYS` later does not delete previously imported keys; revoke them
through the admin API/dashboard and remove them from the deployment
configuration as appropriate.

### `403` or `401` from `/admin/keys`

Use either a valid dashboard login session or the exact `ADMIN_TOKEN` value in
the `X-Admin-Token` header. An MCP client key cannot authorize admin endpoints.

### A key disappeared after redeployment

Ensure the same persistent volume is mounted at `/app/data` in Docker/Coolify,
or set `DATA_DIR` to a persistent directory for a local HTTP deployment. If the
deployment intentionally uses only environment-provisioned keys, remember that
those keys are also imported into `store.json` and remain there when the
environment variable is later removed.
