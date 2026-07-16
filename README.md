# vbl-mcp

Servidor MCP (Model Context Protocol) para la API pública de **Basketball Vlaanderen** (VBL), el backend `vblcb.wisseq.eu` que usa [basketbal.vlaanderen](https://www.basketbal.vlaanderen). Solo lectura.

Documentación oficial de la API: [ApiDocV2.pdf](docs/ApiDocV2.pdf) ([fuente](https://www.basketbal.vlaanderen/documenten/Clubondersteuning/ApiDocV2.pdf)).

> **Condiciones de uso (según el documento oficial):** las APIs solo pueden usarse para integrar calendarios, resultados y clasificaciones en webs de clubes afiliados a Basketbal Vlaanderen vzw. Cualquier otro uso requiere contactar con info@basketbal.vlaanderen.

## Instalación

```bash
npm install
npm run build
```

## Uso con Claude Code

El proyecto incluye un `.mcp.json`, así que al abrir este directorio con Claude Code el servidor se registra solo. Para registrarlo globalmente:

```bash
claude mcp add vbl -- node /ruta/a/vbl_mcp/dist/index.js
```

## Uso con Claude Desktop

En `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vbl": {
      "command": "node",
      "args": ["/ruta/a/vbl_mcp/dist/index.js"]
    }
  }
}
```

## Herramientas

| Herramienta | Endpoint VBL | Descripción |
|---|---|---|
| `list_clubs` | `OrgList?p=1` | Lista todos los clubes, con filtro opcional por nombre/ciudad/región/nº de stam |
| `get_club` | `OrgDetailByGuid` | Detalle de un club: equipos y sus poules, web, dirección, pabellones (`accomms`) y junta (`bestuur`) |
| `get_club_members` | `RelatiesByOrgGuid` | Miembros federados del club (jugadores, coaches…) |
| `get_club_matches` | `OrgMatchesByGuid` | Todos los partidos de todos los equipos del club |
| `get_team` | `TeamDetailByGuid` | Detalle de un equipo: clasificación oficial de sus poules, plantilla (`spelers`) y staff (`tvlijst`) |
| `get_team_matches` | `TeamMatchesByGuid` | Calendario y resultados de un equipo |
| `get_poule_matches` | `PouleMatchesByGuid` | Calendario y resultados de una poule (serie) completa |
| `get_poule_standings` | `TeamDetailByGuid` | Clasificación **oficial** de la poule (rangNr, wedPunt, ptVoor/ptTegen…); si no está disponible, se calcula desde los partidos jugados |
| `get_match` | `MatchesByWedGuid` | Detalle completo de un partido (con historial de cambios opcional) |
| `get_match_lineup` | `DwfDeelByWedGuid` (PUT) | Alineaciones del acta digital (DWF); `null` si aún no existe |

## GUIDs

- **Club**: `BVBL1004` (Antwerp Giants)
- **Equipo**: `BVBL1004HSE  2` — ojo: los GUID de equipo contienen **dos espacios**; hay que pasarlos tal cual los devuelve `get_club`
- **Poule**: `BVBL26279180NAHSE11A` (Top Division Men 1, temporada 2026-27; los 4 dígitos tras `BVBL` codifican la temporada)
- **Partido**: `BVBL26279180NAHSE11AAB`

## Notas

- La API solo sirve datos de la temporada en curso; las temporadas pasadas se purgan.
- Los campos están en neerlandés (`naam`, `plaats`, `uitslag` = resultado, `gespeeld` = jugado, `tT`/`tU` = equipo local/visitante, `wedPunt` = puntos de clasificación, `ptVoor`/`ptTegen` = puntos a favor/en contra).
- Los endpoints documentados oficialmente son los 5 de la tabla marcados con su nombre wisseq (`OrgDetailByGuid`, `OrgMatchesByGuid`, `RelatiesByOrgGuid`, `TeamDetailByGuid`, `TeamMatchesByGuid`). `OrgList`, `PouleMatchesByGuid`, `MatchesByWedGuid` y los DWF son endpoints del mismo backend usados por la web oficial, pero no aparecen en el PDF.
- Respuestas de error: códigos HTTP estándar (400, 404, 500…) según el documento oficial.
