/**
 * Global guard rails for the test run.
 *
 * The suite must never reach the real Basketball Vlaanderen backend: it is a
 * third-party service, it is rate-limited, and a green test run must not
 * depend on the network. Tests point VBL_BASE_URL at the fake upstream; this
 * default makes an un-pointed test fail fast and loudly instead of silently
 * hitting production.
 */
process.env.VBL_BASE_URL ??= "http://127.0.0.1:9/__no_upstream_configured__";

// Never inherit real deployment secrets or data locations from the shell.
delete process.env.ADMIN_TOKEN;
delete process.env.MCP_API_KEYS;
delete process.env.DATA_DIR;
