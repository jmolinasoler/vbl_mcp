# Testing & TDD guide

This project is developed test-first. The harness exists so that writing the
test **before** the code is the path of least resistance: no network, no ports
to pick, no leftover state, sub-second feedback.

```bash
npm run test          # one-shot run
npm run test:watch    # red-green-refactor loop (keep this open while coding)
npm run test:coverage # coverage report + thresholds
npm run typecheck     # type-checks src and tests
npm run check         # typecheck + tests, what CI runs
```

## The loop

1. **Red** — write the smallest test that states the behaviour you want, in the
   language of the domain ("bills each key only for the calls made with it",
   not "calls recordUsage twice"). Run it and *watch it fail*. A test that has
   never failed proves nothing.
2. **Green** — write the least code that makes it pass. Resist fixing anything
   the test does not ask for.
3. **Refactor** — clean up with the suite green, running it after each step.

Two rules that keep the suite trustworthy:

- **A bug fix starts with a failing test.** Reproduce the defect as a test
  first; that test is the proof the fix works and the guard against regression.
  Both auth bugs found while building this harness (see below) were fixed that
  way.
- **When a test fails, decide whether the test or the code is wrong** before
  touching anything. Changing an assertion to match current behaviour is how a
  suite quietly stops protecting you. If the existing behaviour turns out to be
  right, fix the test and say why in the commit.

## What to test where

| Layer | Location | Use it for |
|---|---|---|
| Unit | `tests/unit/` | Pure logic and single modules: the store, token estimation, tool payload shaping |
| Integration | `tests/integration/` | The real Express app over real HTTP with a real MCP client: auth, admin API, metering end to end, persistence |

Anything that would reach `vblcb.wisseq.eu` goes through the fake upstream.
`tests/setup.ts` points `VBL_BASE_URL` at a dead address by default, so a test
that forgets to wire the fake fails fast instead of silently calling the real
Basketball Vlaanderen backend.

## The harness

Everything is exported from `tests/harness/index.js`.

### `startFakeVbl()` — the upstream

An HTTP server that speaks the VBL API with canned fixtures, records every
request, and can be told to fail.

```ts
const upstream = await startFakeVbl();
process.env.VBL_BASE_URL = upstream.url;

upstream.setResponse("TeamDetailByGuid", fixtures.teamDetailNoPoules); // change a payload
upstream.failNext("OrgList", 500);                                     // inject a failure
upstream.requests.at(-1)?.rawQuery;                                    // assert on the wire format
upstream.reset();                                                      // between tests
```

Asserting on `requests` is how the suite pins down GUID encoding — team GUIDs
carry two internal spaces, and mangling them silently returns the wrong team.

### `startMcpHarness()` — tools without HTTP

A real MCP client linked to the real server in memory. Fast enough for
fine-grained tool tests, and it captures the metering records the server emits.

```ts
const mcp = await startMcpHarness();
const clubs = await mcp.call<any[]>("list_clubs", { search: "giants" }); // parsed JSON
const message = await mcp.callExpectingError("get_club", { club_guid: "x" });
mcp.records; // [{ tool, tokensIn, tokensOut, durationMs, isError }]
```

### `startHttpHarness()` — the whole server

Boots the Express app on an ephemeral port with an isolated temp `DATA_DIR`.

```ts
const h = await startHttpHarness({ adminToken: "admin-secret" });
const key = await h.createKey("client-a");        // through the admin API
const client = await h.connectMcp(key.key);       // real Streamable HTTP MCP client
await client.callTool({ name: "list_clubs", arguments: {} });
const { body } = await h.admin("GET", "/admin/keys");  // billing export
await h.close();                                   // closes sessions, removes temp data
```

Pass `dataDir` (see `tempDataDir()`) to point two consecutive harnesses at the
same files and assert that billing data survives a restart. Pass `null` as the
admin token argument to omit the header entirely.

### `withTempStore()` — the store alone

```ts
const tmp = withTempStore();
tmp.store.createKey("hermes");
tmp.reopen();   // flush + reload from disk, i.e. a restart
tmp.cleanup();
```

## Design constraints this harness imposes on the code

The production code was reshaped to be testable, and those shapes are worth
keeping:

- **`createApp()` builds the app without binding a port.** `startHttp()` is a
  thin wrapper that listens. Tests get isolated instances.
- **No module-level mutable state.** Sessions, counters and the upstream health
  cache live in a per-app `AppState`, so two instances in one process cannot
  contaminate each other's numbers (there is a test for exactly that).
- **`baseUrl()` is resolved per call**, not frozen at import time, so the
  upstream can be redirected at runtime.
- **Config is injected, with env vars as the default** — `createApp({ dataDir,
  apiKeys, adminToken })`. Tests never mutate the real environment.

## Bugs this harness caught

Both were found the first time the integration tests ran, and both are billing
or security relevant:

1. **Revoking the last API key reopened the server to everyone.** Auth was
   enabled by "are there active keys?", so revoking them all fell back to open
   mode — the exact opposite of the operator's intent. Auth is now enforced as
   soon as a key has ever existed (`Store.authEnabled()`).
2. **One key could drive a session opened by another**, and the consumption was
   metered against the key that opened it. A session is now bound to its key and
   mismatches get 403.

## Adding a tool, test-first

1. Write the failing test in `tests/unit/tools.test.ts` describing the payload
   you want, plus a fixture in `tests/harness/fixtures.ts` and its route in
   `defaults()` in `tests/harness/fake-vbl.ts`.
2. Register the tool in `src/vbl.ts` until the test is green.
3. Add a metering expectation if the tool has unusual response sizes.
4. Update the tool list assertion in `tests/unit/tools.test.ts` — it is
   deliberately exhaustive so new tools cannot ship undocumented.
