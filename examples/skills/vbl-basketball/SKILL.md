---
name: vbl-basketball
description: Query Basketball Vlaanderen (Flemish/Belgian basketball) data — clubs, teams, rosters, calendars, results and standings — through the vbl MCP server. Use when the user asks about Belgian or Flemish basketball clubs, matches, klassement/standings, poules/series, or Basketbal Vlaanderen.
---

# Basketball Vlaanderen (VBL)

You have access to the `vbl` MCP server, which wraps the public Basketball
Vlaanderen API (the data behind basketbal.vlaanderen). All data is read-only
and covers the **current season only**.

## Core concepts

Everything is addressed by GUIDs, discovered top-down:

| Entity | Example GUID | Found via |
|---|---|---|
| Club | `BVBL1004` | `list_clubs` |
| Team | `BVBL1004HSE  2` | `get_club` → `teams[].guid` |
| Poule (series/competition) | `BVBL26279180NAHSE11A` | `get_club` → `teams[].poules[].guid` |
| Match | `BVBL26279180NAHSE11AAB` | any `*_matches` tool → `guid` |

**Critical:** team GUIDs contain internal spaces (often two, e.g.
`BVBL1004HSE  2`). Always pass GUIDs exactly as returned by a previous tool —
never retype, trim or normalize them.

Field names are Dutch. Glossary: `naam` = name, `plaats` = city/venue town,
`uitslag` = result/score, `gespeeld` = played (`J` yes / `N` no), `tT*` = home
team, `tU*` = away team, `accNaam` = sports hall, `beginTijd` = start time,
`datumString` = date (DD-MM-YYYY), `wedPunt` = competition points, `wedAant` =
games played, `ptVoor`/`ptTegen` = points for/against, `rangNr` = rank,
`spelers` = players, `tvlijst` = staff (coaches), `bestuur` = club board,
`accomms` = club venues.

## Typical workflows

**Find a club** → `list_clubs` with `search` (matches name, city, region or
stam number). Never call it without `search` unless the user wants all ~450
clubs.

**Club overview** → `get_club(club_guid)`: teams with their poules, venues,
board, website.

**Standings / klassement** → `get_poule_standings(poule_guid)`. Get the poule
GUID from `get_club` or from a match. `source: "official"` is the real VBL
ranking; `source: "computed"` is a fallback estimate — say so if you present it.

**Calendar / results** → `get_team_matches(team_guid)` for one team,
`get_poule_matches(poule_guid)` for a whole series, `get_club_matches(club_guid)`
for every team of a club. Upcoming matches have `gespeeld: "N"` and empty
`uitslag`.

**Match deep-dive** → `get_match(match_guid)` for venue/officials/planning;
`get_match_lineup(match_guid)` for the digital scoresheet lineups (returns
`null` until the match form exists — normal for future matches).

**People** → `get_club_members(club_guid, search?)` for licensed members;
`get_team(team_guid)` for the roster and coaches of one team.

## Answering guidelines

- Resolve ambiguous club names with `list_clubs` first and, if several match,
  ask the user which one they mean (include the city).
- Dates are `DD-MM-YYYY` and times `HH.MM` (e.g. `20.30`); present them in the
  user's locale and mention the sports hall (`accNaam`) for upcoming matches.
- The API purges past seasons: if the user asks about a previous season, say
  the data is no longer available rather than guessing.
- Members and match lists can be large — prefer filtered queries (`search`
  parameter, a specific team instead of the whole club) when the question
  allows it.
