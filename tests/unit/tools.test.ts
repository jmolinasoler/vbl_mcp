import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startFakeVbl,
  startMcpHarness,
  fixtures as fx,
  type FakeVbl,
  type McpHarness,
} from "../harness/index.js";

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

const lastRequest = () => upstream.requests[upstream.requests.length - 1];

describe("tool surface", () => {
  it("exposes every documented tool with a description and schema", async () => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_club",
      "get_club_matches",
      "get_club_members",
      "get_match",
      "get_match_lineup",
      "get_poule_matches",
      "get_poule_standings",
      "get_team",
      "get_team_matches",
      "list_clubs",
    ]);
    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema).toBeTruthy();
    }
  });
});

describe("list_clubs", () => {
  it("returns every club when no filter is given", async () => {
    const clubs = await mcp.call<any[]>("list_clubs");
    expect(clubs).toHaveLength(fx.orgList.length);
    expect(lastRequest().path).toBe("OrgList");
    expect(lastRequest().query.p).toBe("1");
  });

  it("filters case-insensitively on name, city, region and stam number", async () => {
    expect(await mcp.call<any[]>("list_clubs", { search: "giants" })).toHaveLength(1);
    expect(await mcp.call<any[]>("list_clubs", { search: "oostende" })).toHaveLength(1);
    expect(await mcp.call<any[]>("list_clubs", { search: "Oost-Vlaanderen" })).toHaveLength(1);
    expect(await mcp.call<any[]>("list_clubs", { search: "249" })).toHaveLength(1);
  });

  it("returns an empty list rather than failing when nothing matches", async () => {
    expect(await mcp.call<any[]>("list_clubs", { search: "zzzz" })).toEqual([]);
  });
});

describe("get_club", () => {
  it("keeps the fields a club page needs and trims the noisy team objects", async () => {
    const club = await mcp.call<any>("get_club", { club_guid: fx.CLUB_GUID });
    expect(club.naam).toBe("Antwerp Giants");
    expect(club.website).toBeTruthy();
    expect(club.adres.postcode).toBe("2170");
    expect(club.accomms).toHaveLength(1);
    expect(club.bestuur[0].kenmerk).toBe("Voorzitter");
    expect(club.teams[0]).toEqual({
      guid: fx.TEAM_GUID,
      naam: "Antwerp Giants HSE B",
      categorie: "Heren Senioren",
      shirtKleur: "#ffffff",
      shirtReserve: "#ff0000",
      poules: [
        { guid: fx.POULE_GUID, naam: "Top Division Men 1 Regular Season" },
        { guid: "BVBL26279180BNAHSEPJ", naam: "Beker van België Heren Poule J" },
      ],
    });
  });

  it("passes the club guid through untouched", async () => {
    await mcp.call("get_club", { club_guid: fx.CLUB_GUID });
    expect(lastRequest().query.issguid).toBe(fx.CLUB_GUID);
  });

  it("returns the empty upstream response instead of throwing for an unknown club", async () => {
    upstream.setResponse("OrgDetailByGuid", []);
    expect(await mcp.call<any>("get_club", { club_guid: "BVBL0000" })).toEqual([]);
  });
});

describe("GUID encoding", () => {
  // Team GUIDs contain two internal spaces; mangling them silently returns
  // the wrong team, so pin the wire format.
  it("url-encodes the spaces in a team guid and the server decodes them back", async () => {
    await mcp.call("get_team", { team_guid: fx.TEAM_GUID });
    const req = lastRequest();
    expect(req.query.teamguid).toBe(fx.TEAM_GUID);
    expect(req.rawQuery).toContain("%20%20");
    expect(req.rawQuery).not.toContain("+");
  });

  it("encodes team guids the same way for match lookups", async () => {
    await mcp.call("get_team_matches", { team_guid: fx.TEAM_GUID });
    expect(lastRequest().query.teamguid).toBe(fx.TEAM_GUID);
  });
});

describe("get_team", () => {
  it("returns the roster, staff and the poules with their rankings", async () => {
    const [team] = await mcp.call<any[]>("get_team", { team_guid: fx.TEAM_GUID });
    expect(team.naam).toBe("Antwerp Giants HSE B");
    expect(team.spelers).toHaveLength(1);
    expect(team.tvlijst[0].tvCaC).toBe("Coach");
    expect(team.poules[0].teams).toHaveLength(2);
  });
});

describe("get_poule_standings", () => {
  it("returns the official ranking when the upstream exposes one", async () => {
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });
    expect(result.source).toBe("official");
    expect(result.poule.guid).toBe(fx.POULE_GUID);
    expect(result.standings).toHaveLength(2);
    expect(result.standings[0]).toMatchObject({
      rangNr: "1",
      team: "Antwerp Giants HSE B",
      teamGuid: fx.TEAM_GUID,
      wedPunt: "4",
      ptVoor: "160",
    });
  });

  it("trims the padding the upstream puts around rank numbers", async () => {
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });
    expect(result.standings.map((s: any) => s.rangNr)).toEqual(["1", "2"]);
  });

  it("computes a fallback table when no official ranking is published", async () => {
    upstream.setResponse("TeamDetailByGuid", fx.teamDetailNoPoules);
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });

    expect(result.source).toBe("computed");
    expect(result.note).toMatch(/computed from played matches/i);
    // One played match, 80-70: winner 2 pts, loser 1 pt. The unplayed one is ignored.
    expect(result.standings[0]).toMatchObject({
      rank: 1,
      team: "Antwerp Giants HSE B",
      played: 1,
      wins: 1,
      points: 2,
      pointsFor: 80,
      pointsAgainst: 70,
      diff: 10,
    });
    expect(result.standings[1]).toMatchObject({ rank: 2, losses: 1, points: 1, diff: -10 });
  });

  it("lists teams with no played matches instead of dropping them", async () => {
    upstream.setResponse("TeamDetailByGuid", fx.teamDetailNoPoules);
    upstream.setResponse("PouleMatchesByGuid", [
      { ...fx.pouleMatches[1] }, // only the unplayed fixture
    ]);
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });
    expect(result.standings).toHaveLength(2);
    expect(result.standings.every((s: any) => s.played === 0)).toBe(true);
  });

  it("gives the loser of a forfeit zero points instead of the usual one", async () => {
    upstream.setResponse("TeamDetailByGuid", fx.teamDetailNoPoules);
    upstream.setResponse("PouleMatchesByGuid", [
      { ...fx.pouleMatches[0], uitslag: " 20-  0 FOR", gespeeld: "J" },
    ]);
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });

    expect(result.standings[0]).toMatchObject({ points: 2, wins: 1 });
    expect(result.standings[1]).toMatchObject({ points: 0, losses: 1 });
  });

  it("ignores a played match whose result cannot be parsed", async () => {
    upstream.setResponse("TeamDetailByGuid", fx.teamDetailNoPoules);
    upstream.setResponse("PouleMatchesByGuid", [
      { ...fx.pouleMatches[0], uitslag: "n/a", gespeeld: "J" },
    ]);
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: fx.POULE_GUID });
    expect(result.standings.every((s: any) => s.played === 0)).toBe(true);
  });

  it("handles an empty poule without crashing", async () => {
    upstream.setResponse("PouleMatchesByGuid", []);
    const result = await mcp.call<any>("get_poule_standings", { poule_guid: "BVBL_EMPTY" });
    expect(result.source).toBe("computed");
    expect(result.standings).toEqual([]);
  });
});

describe("get_match", () => {
  it("drops the verbose rescheduling history by default", async () => {
    const [match] = await mcp.call<any[]>("get_match", { match_guid: fx.MATCH_GUID });
    expect(match._default.wedID).toBe("NAHSE11AAB06");
    expect(match._default).not.toHaveProperty("planHistorie");
  });

  it("includes the history when explicitly asked for", async () => {
    const [match] = await mcp.call<any[]>("get_match", {
      match_guid: fx.MATCH_GUID,
      include_history: true,
    });
    expect(match._default).toHaveProperty("planHistorie");
  });
});

describe("get_match_lineup", () => {
  it("asks the DWF endpoint with a PUT, as the upstream requires", async () => {
    await mcp.call("get_match_lineup", { match_guid: fx.MATCH_GUID });
    expect(lastRequest().method).toBe("PUT");
    expect(lastRequest().path).toBe("DwfDeelByWedGuid");
  });

  it("passes through a null lineup for matches without a scoresheet yet", async () => {
    upstream.setResponse("DwfDeelByWedGuid", null);
    expect(await mcp.call<any>("get_match_lineup", { match_guid: fx.MATCH_GUID })).toBeNull();
  });
});

describe("upstream failures", () => {
  it("surfaces an upstream 500 as a tool error naming the status", async () => {
    upstream.failNext("OrgList", 500);
    const message = await mcp.callExpectingError("list_clubs");
    expect(message).toContain("500");
  });

  it("surfaces an upstream 404 without pretending the club is empty", async () => {
    upstream.failNext("OrgDetailByGuid", 404);
    const message = await mcp.callExpectingError("get_club", { club_guid: "BVBL1004" });
    expect(message).toContain("404");
  });

  it("reports a connection failure instead of hanging", async () => {
    const previous = process.env.VBL_BASE_URL;
    process.env.VBL_BASE_URL = "http://127.0.0.1:9/dead";
    try {
      const message = await mcp.callExpectingError("list_clubs");
      expect(message.length).toBeGreaterThan(0);
    } finally {
      process.env.VBL_BASE_URL = previous;
    }
  });

  it("keeps serving after an upstream error", async () => {
    upstream.failNext("OrgList", 500);
    await mcp.callExpectingError("list_clubs");
    expect(await mcp.call<any[]>("list_clubs")).toHaveLength(fx.orgList.length);
  });
});

describe("input validation", () => {
  it("returns a schema error instead of calling the upstream", async () => {
    const before = upstream.requests.length;
    const result = await mcp.raw("get_club", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("club_guid");
    expect(upstream.requests).toHaveLength(before);
  });

  it("does not meter a call rejected by the schema (nothing was consumed)", async () => {
    await mcp.raw("get_club", {});
    expect(mcp.records).toHaveLength(0);
  });
});
