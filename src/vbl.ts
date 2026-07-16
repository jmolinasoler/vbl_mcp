/**
 * Basketball Vlaanderen (VBL) API client and MCP tool definitions.
 *
 * Backend: vblcb.wisseq.eu (the API behind basketbal.vlaanderen).
 * Official spec: docs/ApiDocV2.pdf. All data is read-only. GUIDs may contain
 * spaces (e.g. team GUIDs like "BVBL1004HSE  2"), URL-encoded automatically.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const VERSION = "0.3.0";
export const BASE_URL = "http://vblcb.wisseq.eu/VBLCB_WebService/data";

export type ToolCallListener = (tool: string, args: Record<string, unknown>) => void;

async function apiGet(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${BASE_URL}/${path}?${qs}`);
  if (!res.ok) {
    throw new Error(`VBL API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** DWF (digital scoresheet) endpoints require PUT with a wisseq envelope body. */
async function apiPutDwf(path: string, params: Record<string, string>): Promise<unknown> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const res = await fetch(`${BASE_URL}/${path}?${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ AuthHeader: "na", WQVer: "wqd2.0", CRUD: "GET" }),
  });
  if (!res.ok) {
    throw new Error(`VBL API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function run<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}

interface Club {
  guid: string;
  naam: string;
  plaats: string;
  regioNaam: string;
  stamNr: string;
}

interface Match {
  guid: string;
  wedID: string;
  tTGUID: string;
  tTNaam: string;
  tUGUID: string;
  tUNaam: string;
  datumString: string;
  beginTijd: string;
  accNaam: string;
  pouleGUID: string;
  pouleNaam: string;
  gespeeld: string;
  uitslag: string;
}

export function createServer(onToolCall?: ToolCallListener): McpServer {
  const server = new McpServer({ name: "vbl-mcp", version: VERSION });

  const tool = (
    name: string,
    config: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: (args: any) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>
  ) => {
    server.registerTool(name, config as any, (async (args: any) => {
      onToolCall?.(name, args ?? {});
      return handler(args ?? {});
    }) as any);
  };

  tool(
    "list_clubs",
    {
      title: "List clubs",
      description:
        "List all Basketball Vlaanderen clubs (organizations). Optionally filter by a search " +
        "string (matched against name, city, region and stam number). Returns guid, naam (name), " +
        "plaats (city), regioNaam (region) and stamNr for each club. Use the guid with the " +
        "get_club* tools.",
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe("Case-insensitive filter on club name, city, region or stam number"),
      },
    },
    async ({ search }) =>
      run(async () => {
        const clubs = (await apiGet("OrgList", { p: "1" })) as Club[];
        if (!search) return clubs;
        const q = search.toLowerCase();
        return clubs.filter((c) =>
          [c.naam, c.plaats, c.regioNaam, c.stamNr, c.guid].some((f) =>
            (f ?? "").toLowerCase().includes(q)
          )
        );
      })
  );

  tool(
    "get_club",
    {
      title: "Get club detail",
      description:
        "Get details of one club by its GUID (e.g. BVBL1004): teams and the poules " +
        "(competitions/series) each team plays in, website, address, venues (accomms) and " +
        "board members (bestuur). Team GUIDs and poule GUIDs returned here can be used with " +
        "get_team, get_team_matches and get_poule_matches.",
      inputSchema: {
        club_guid: z.string().describe("Club GUID, e.g. BVBL1004"),
      },
    },
    async ({ club_guid }) =>
      run(async () => {
        const data = (await apiGet("OrgDetailByGuid", { issguid: club_guid })) as any[];
        if (!data?.length) return data;
        // Trim the verbose team objects down to the useful fields.
        const club = data[0];
        return {
          guid: club.guid,
          naam: club.naam,
          plaats: club.plaats,
          stamNr: club.stamNr,
          website: club.website,
          adres: club.adres,
          accomms: club.accomms,
          bestuur: club.bestuur,
          teams: (club.teams ?? []).map((t: any) => ({
            guid: t.guid,
            naam: t.naam,
            categorie: t.categorie,
            shirtKleur: t.shirtKleur,
            shirtReserve: t.shirtReserve,
            poules: (t.poules ?? []).map((p: any) => ({ guid: p.guid, naam: p.naam })),
          })),
        };
      })
  );

  tool(
    "get_club_members",
    {
      title: "Get club members",
      description:
        "List the registered members (players, coaches, officials) of a club. Can be a large " +
        "list; use the search parameter to filter by name. Returns relGuid, name, first name, " +
        "birth date, gender and category.",
      inputSchema: {
        club_guid: z.string().describe("Club GUID, e.g. BVBL1004"),
        search: z.string().optional().describe("Case-insensitive filter on member name"),
      },
    },
    async ({ club_guid, search }) =>
      run(async () => {
        const members = (await apiGet("RelatiesByOrgGuid", { orgguid: club_guid })) as any[];
        const trimmed = (members ?? []).map((m) => ({
          relGuid: m.relGuid,
          naam: m.naam,
          vnaam: m.vnaam,
          lidNr: m.lidNr,
          gebdat: m.gebdat,
          mvo: m.mvo,
          cat: m.cat,
        }));
        if (!search) return trimmed;
        const q = search.toLowerCase();
        return trimmed.filter((m) => `${m.vnaam} ${m.naam}`.toLowerCase().includes(q));
      })
  );

  tool(
    "get_club_matches",
    {
      title: "Get club matches",
      description:
        "List all matches (played and upcoming) of every team of a club, across all its " +
        "competitions. Each match has home/away team, date, time, venue, poule and result " +
        "(uitslag, empty if not played yet; gespeeld = J means played).",
      inputSchema: {
        club_guid: z.string().describe("Club GUID, e.g. BVBL1004"),
      },
    },
    async ({ club_guid }) => run(() => apiGet("OrgMatchesByGuid", { issguid: club_guid }))
  );

  tool(
    "get_team",
    {
      title: "Get team detail",
      description:
        "Get details of one team by its team GUID (e.g. 'BVBL1004HSE  2' — note team GUIDs " +
        "contain spaces, pass them exactly as returned by get_club). Includes the official " +
        "standings of every poule the team plays in, the player roster (spelers) and the " +
        "staff list (tvlijst, e.g. coaches).",
      inputSchema: {
        team_guid: z.string().describe("Team GUID, e.g. 'BVBL1004HSE  2' (keep the spaces)"),
      },
    },
    async ({ team_guid }) => run(() => apiGet("TeamDetailByGuid", { teamguid: team_guid }))
  );

  tool(
    "get_team_matches",
    {
      title: "Get team matches",
      description:
        "List all matches (played and upcoming) of one team across all its competitions. " +
        "Each match includes date, time, venue, opponent, poule and result.",
      inputSchema: {
        team_guid: z.string().describe("Team GUID, e.g. 'BVBL1004HSE  2' (keep the spaces)"),
      },
    },
    async ({ team_guid }) => run(() => apiGet("TeamMatchesByGuid", { teamguid: team_guid }))
  );

  tool(
    "get_poule_matches",
    {
      title: "Get poule matches",
      description:
        "List all matches of a poule (competition/series), e.g. the full calendar and results " +
        "of 'Top Division Men 1'. Poule GUIDs come from get_club (e.g. BVBL26279180NAHSE11A).",
      inputSchema: {
        poule_guid: z.string().describe("Poule GUID, e.g. BVBL26279180NAHSE11A"),
      },
    },
    async ({ poule_guid }) => run(() => apiGet("PouleMatchesByGuid", { issguid: poule_guid }))
  );

  tool(
    "get_poule_standings",
    {
      title: "Get poule standings",
      description:
        "Get the official standings (rangschikking/klassement) of a poule. Returns teams " +
        "ranked with games played (wedAant), competition points (wedPunt), wins/losses and " +
        "points scored/conceded. Falls back to standings computed from played matches if the " +
        "official ranking is not exposed for this poule.",
      inputSchema: {
        poule_guid: z.string().describe("Poule GUID, e.g. BVBL26279180NAHSE11A"),
      },
    },
    async ({ poule_guid }) =>
      run(async () => {
        const matches = (await apiGet("PouleMatchesByGuid", { issguid: poule_guid })) as Match[];

        // The official ranking is embedded in TeamDetailByGuid (see VBL ApiDocV2):
        // fetch any team of the poule and read the ranked team list of that poule.
        const anyTeamGuid = matches?.find((m) => m.tTGUID)?.tTGUID;
        if (anyTeamGuid) {
          const detail = (await apiGet("TeamDetailByGuid", { teamguid: anyTeamGuid })) as any[];
          const poule = (detail?.[0]?.poules ?? []).find((p: any) => p.guid === poule_guid);
          if (poule?.teams?.length) {
            return {
              source: "official",
              poule: { guid: poule.guid, naam: poule.naam },
              standings: poule.teams.map((t: any) => ({
                rangNr: (t.rangNr ?? "").trim(),
                team: t.naam,
                teamGuid: t.guid,
                wedAant: t.wedAant,
                wedPunt: t.wedPunt,
                wedWinst: t.wedWinst,
                wedGelijk: t.wedGelijk,
                wedVerloren: t.wedVerloren,
                ptVoor: t.ptVoor,
                ptTegen: t.ptTegen,
                opmerk: t.opmerk,
              })),
            };
          }
        }

        // Fallback: compute from played matches (2 pts win / 1 pt loss / 0 forfeit loss).
        type Row = {
          teamGuid: string;
          team: string;
          played: number;
          wins: number;
          losses: number;
          pointsFor: number;
          pointsAgainst: number;
          points: number;
        };
        const table = new Map<string, Row>();
        const rowFor = (guid: string, name: string): Row => {
          let r = table.get(guid);
          if (!r) {
            r = { teamGuid: guid, team: name, played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, points: 0 };
            table.set(guid, r);
          }
          return r;
        };
        // Register every team in the poule, even those without played matches.
        for (const m of matches ?? []) {
          if (m.tTGUID) rowFor(m.tTGUID, m.tTNaam);
          if (m.tUGUID) rowFor(m.tUGUID, m.tUNaam);
        }
        for (const m of matches ?? []) {
          if (m.gespeeld !== "J") continue;
          const score = /(\d+)\s*-\s*(\d+)/.exec(m.uitslag ?? "");
          if (!score) continue;
          const [, hs, as] = score;
          const home = rowFor(m.tTGUID, m.tTNaam);
          const away = rowFor(m.tUGUID, m.tUNaam);
          const h = parseInt(hs, 10);
          const a = parseInt(as, 10);
          const forfeit = /FOR/i.test(m.uitslag);
          home.played++; away.played++;
          home.pointsFor += h; home.pointsAgainst += a;
          away.pointsFor += a; away.pointsAgainst += h;
          const [winner, loser] = h >= a ? [home, away] : [away, home];
          winner.wins++; winner.points += 2;
          loser.losses++; loser.points += forfeit ? 0 : 1;
        }
        const rows = [...table.values()].sort(
          (x, y) =>
            y.points - x.points ||
            (y.pointsFor - y.pointsAgainst) - (x.pointsFor - x.pointsAgainst) ||
            y.pointsFor - x.pointsFor
        );
        return {
          source: "computed",
          note: "Official ranking unavailable for this poule; standings computed from played matches (2 pts win / 1 pt loss / 0 forfeit loss). Official VBL tie-break rules may differ.",
          standings: rows.map((r, i) => ({ rank: i + 1, ...r, diff: r.pointsFor - r.pointsAgainst })),
        };
      })
  );

  tool(
    "get_match",
    {
      title: "Get match detail",
      description:
        "Get full details of one match by its match GUID (e.g. BVBL26279180NAHSE11AAB, as " +
        "returned by the *matches tools). Includes teams, venue, officials and planning status. " +
        "Set include_history to true to also get the raw rescheduling history.",
      inputSchema: {
        match_guid: z.string().describe("Match GUID, e.g. BVBL26279180NAHSE11AAB"),
        include_history: z
          .boolean()
          .optional()
          .describe("Include the verbose planHistorie field (default false)"),
      },
    },
    async ({ match_guid, include_history }) =>
      run(async () => {
        const data = (await apiGet("MatchesByWedGuid", { issguid: match_guid })) as any[];
        if (include_history) return data;
        return (data ?? []).map((m) => {
          if (m?._default && "planHistorie" in m._default) {
            const { planHistorie, ...rest } = m._default;
            return { ...m, _default: rest };
          }
          return m;
        });
      })
  );

  tool(
    "get_match_lineup",
    {
      title: "Get match lineup (DWF)",
      description:
        "Get the digital scoresheet participants (players and coaches of both teams, with " +
        "jersey numbers) of a match. Only available once the digital match form exists — " +
        "returns null for matches without DWF data (e.g. far in the future or past seasons).",
      inputSchema: {
        match_guid: z.string().describe("Match GUID, e.g. BVBL26279180NAHSE11AAB"),
      },
    },
    async ({ match_guid }) => run(() => apiPutDwf("DwfDeelByWedGuid", { issguid: match_guid }))
  );

  return server;
}
