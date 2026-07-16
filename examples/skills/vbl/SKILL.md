---
name: vbl
description: Answer a question about Basketball Vlaanderen (Flemish/Belgian basketball) — clubs, teams, calendars, results, standings — by querying the vbl MCP server. Invoke as /vbl <question>.
---

# /vbl — Basketball Vlaanderen

Answer this question using the `vbl` MCP tools, then reply in the user's language:

**$ARGUMENTS**

If no question was given, ask what they want to know (a club, a team, standings, calendar, a match…).

## Resolving a query

Everything is addressed by GUIDs, discovered top-down — never retype or trim a GUID; pass it exactly as a previous tool returned it (team GUIDs contain internal spaces, e.g. `BVBL1004HSE  2`).

1. **Club named?** → `list_clubs` with `search` (name, city, region or stam number). Several matches → ask which one, mentioning the city.
2. **Need teams or poule GUIDs?** → `get_club(club_guid)` lists teams and the poules (series) each plays in.
3. Then pick the tool that answers the question:
   - Standings/klassement → `get_poule_standings(poule_guid)` — if `source` is `"computed"` (not `"official"`), say the table is an estimate.
   - Calendar/results → `get_team_matches`, `get_poule_matches` or `get_club_matches`.
   - One match → `get_match(match_guid)`; lineups → `get_match_lineup` (returns `null` until the digital match form exists — normal for future matches).
   - People → `get_team` (roster + coaches) or `get_club_members` (use `search`; the full list is huge).

## Reading the data

Fields are Dutch: `naam` name · `plaats` city · `uitslag` result · `gespeeld` played (`J`/`N`) · `tT*` home / `tU*` away team · `accNaam` sports hall · `datumString` date DD-MM-YYYY · `beginTijd` time HH.MM · `wedPunt` competition points · `wedAant` games played · `ptVoor`/`ptTegen` points for/against · `rangNr` rank.

Only the **current season** exists — for past seasons, say the data is purged rather than guessing. For upcoming matches (`gespeeld: "N"`), mention date, time and sports hall.
