/**
 * Fake VBL upstream. Tests point VBL_BASE_URL at it so nothing touches the
 * real wisseq backend: fast, deterministic, and it records every request so
 * tests can assert on how GUIDs were encoded.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import * as fx from "./fixtures.js";

export interface RecordedRequest {
  method: string;
  path: string;
  /** Decoded query params, e.g. { teamguid: "BVBL1004HSE  2" }. */
  query: Record<string, string>;
  /** Raw query string, to assert on encoding (spaces as %20 vs +). */
  rawQuery: string;
}

export interface FakeVbl {
  url: string;
  requests: RecordedRequest[];
  /** Force the next N responses of an endpoint to fail with `status`. */
  failNext(path: string, status: number, times?: number): void;
  /** Override the payload an endpoint returns for the rest of the test. */
  setResponse(path: string, body: unknown): void;
  reset(): void;
  close(): Promise<void>;
}

const defaults = (): Record<string, unknown> => ({
  OrgList: fx.orgList,
  OrgDetailByGuid: fx.orgDetail,
  OrgMatchesByGuid: fx.pouleMatches,
  RelatiesByOrgGuid: fx.relaties,
  TeamDetailByGuid: fx.teamDetail,
  TeamMatchesByGuid: fx.teamMatches,
  PouleMatchesByGuid: fx.pouleMatches,
  MatchesByWedGuid: fx.matchDetail,
  DwfDeelByWedGuid: fx.dwfLineup,
});

export async function startFakeVbl(): Promise<FakeVbl> {
  let responses = defaults();
  const failures = new Map<string, { status: number; times: number }>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\//, "");
    requests.push({
      method: req.method ?? "GET",
      path,
      query: Object.fromEntries(url.searchParams),
      rawQuery: url.search.replace(/^\?/, ""),
    });

    // Drain the body so PUT requests (DWF) complete cleanly.
    req.resume();
    req.on("end", () => {
      const failure = failures.get(path);
      if (failure && failure.times > 0) {
        failure.times--;
        res.writeHead(failure.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ Message: `Injected failure for ${path}` }));
        return;
      }
      if (!(path in responses)) {
        // Mirrors the real backend's 404 body for unknown endpoints.
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            Message: `No HTTP resource was found that matches the request URI '${req.url}'.`,
          })
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses[path]));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    failNext(path, status, times = 1) {
      failures.set(path, { status, times });
    },
    setResponse(path, body) {
      responses[path] = body;
    },
    reset() {
      responses = defaults();
      failures.clear();
      requests.length = 0;
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}
