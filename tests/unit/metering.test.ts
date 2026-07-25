/**
 * The metering contract is the billing contract: if these numbers are wrong,
 * customers are charged wrongly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startFakeVbl,
  startMcpHarness,
  fixtures as fx,
  type FakeVbl,
  type McpHarness,
} from "../harness/index.js";
import { estimateTokens } from "../../src/vbl.js";

let upstream: FakeVbl;
let mcp: McpHarness;

beforeAll(async () => {
  upstream = await startFakeVbl();
  process.env.VBL_BASE_URL = upstream.url;
  mcp = await startMcpHarness();
});

afterAll(async () => {
  await mcp.close();
  await upstream.close();
});

beforeEach(() => {
  upstream.reset();
  mcp.records.length = 0;
});

describe("estimateTokens", () => {
  it("approximates four characters per token, rounding up", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(4000)).toBe(1000);
  });
});

describe("per-call metering", () => {
  it("emits exactly one record per successful tool call", async () => {
    await mcp.call("list_clubs");
    await mcp.call("list_clubs", { search: "giants" });
    expect(mcp.records.map((r) => r.tool)).toEqual(["list_clubs", "list_clubs"]);
  });

  it("derives tokens in from the arguments and out from the response", async () => {
    const payload = await mcp.call<any[]>("list_clubs", { search: "giants" });
    const [record] = mcp.records;

    expect(record.tokensIn).toBe(estimateTokens(JSON.stringify({ search: "giants" }).length));
    expect(record.tokensOut).toBe(estimateTokens(JSON.stringify(payload, null, 2).length));
  });

  it("bills a bigger response with more output tokens", async () => {
    await mcp.call("list_clubs", { search: "giants" });
    await mcp.call("get_club", { club_guid: fx.CLUB_GUID });
    const [small, big] = mcp.records;
    expect(big.tokensOut).toBeGreaterThan(small.tokensOut);
  });

  it("measures a non-negative duration", async () => {
    await mcp.call("list_clubs");
    expect(mcp.records[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("flags failed calls but still records them as consumption", async () => {
    upstream.failNext("OrgList", 500);
    await mcp.callExpectingError("list_clubs");

    expect(mcp.records).toHaveLength(1);
    expect(mcp.records[0]).toMatchObject({ tool: "list_clubs", isError: true });
    expect(mcp.records[0].tokensOut).toBeGreaterThan(0);
  });

  it("never reports negative or NaN token counts", async () => {
    await mcp.call("get_match_lineup", { match_guid: fx.MATCH_GUID });
    upstream.setResponse("DwfDeelByWedGuid", null);
    await mcp.call("get_match_lineup", { match_guid: fx.MATCH_GUID });

    for (const r of mcp.records) {
      expect(Number.isFinite(r.tokensIn)).toBe(true);
      expect(Number.isFinite(r.tokensOut)).toBe(true);
      expect(r.tokensIn).toBeGreaterThanOrEqual(0);
      expect(r.tokensOut).toBeGreaterThanOrEqual(0);
    }
  });

  it("attributes each record to the tool that produced it", async () => {
    await mcp.call("list_clubs");
    await mcp.call("get_club", { club_guid: fx.CLUB_GUID });
    await mcp.call("get_poule_matches", { poule_guid: fx.POULE_GUID });
    expect(mcp.records.map((r) => r.tool)).toEqual([
      "list_clubs",
      "get_club",
      "get_poule_matches",
    ]);
  });
});
