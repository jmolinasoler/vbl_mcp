/**
 * Canned VBL API payloads, shaped like the real backend (Dutch fields, GUIDs
 * with internal spaces, string-typed numbers). Trimmed from real responses.
 */

export const CLUB_GUID = "BVBL1004";
/** Team GUIDs really do carry two internal spaces — the harness relies on it. */
export const TEAM_GUID = "BVBL1004HSE  2";
export const POULE_GUID = "BVBL26279180NAHSE11A";
export const MATCH_GUID = "BVBL26279180NAHSE11AAB";

export const orgList = [
  {
    guid: "BVBL1004",
    naam: "Antwerp Giants",
    plaats: "Mechelen",
    regioNaam: "Antwerpen",
    stamNr: "71",
  },
  {
    guid: "BVBL1022",
    naam: "BC Oostende",
    plaats: "Oostende",
    regioNaam: "West-Vlaanderen",
    stamNr: "245",
  },
  {
    guid: "BVBL1024",
    naam: "Okapi Aalst",
    plaats: "Aalst",
    regioNaam: "Oost-Vlaanderen",
    stamNr: "249",
  },
];

export const orgDetail = [
  {
    guid: CLUB_GUID,
    stamNr: "71",
    naam: "Antwerp Giants",
    plaats: "Mechelen",
    website: "www.antwerpgiants.be",
    adres: {
      straat: "Gasthuishoevestraat",
      huisNr: "71",
      huisNrToev: null,
      postcode: "2170",
      plaats: "Merksem",
      land: "België",
    },
    accomms: [
      {
        naam: "Heylen Vastgoed Basketcampus",
        adres: { straat: "Ruggeveldlaan", huisNr: "485", postcode: "2100", plaats: "Deurne" },
        telefoon: "",
        website: "",
        guid: "BVBL600029",
      },
    ],
    bestuur: [
      {
        relGuid: "BVBL700001",
        kmGroep: "BESTUUR",
        kenmerk: "Voorzitter",
        naam: "Jan Janssens",
        telefoon: "0470000000",
        email: "voorzitter@example.be",
      },
    ],
    teams: [
      {
        naam: "Antwerp Giants HSE B",
        categorie: "Heren Senioren",
        organisationGUID: CLUB_GUID,
        shirtKleur: "#ffffff",
        shirtReserve: "#ff0000",
        poules: [
          { naam: "Top Division Men 1 Regular Season", guid: POULE_GUID },
          { naam: "Beker van België Heren Poule J", guid: "BVBL26279180BNAHSEPJ" },
        ],
        guid: TEAM_GUID,
      },
    ],
  },
];

/** TeamDetailByGuid carries the official ranking inside poules[].teams[]. */
export const teamDetail = [
  {
    guid: TEAM_GUID,
    naam: "Antwerp Giants HSE B",
    shirtKleur: "#ffffff",
    shirtReserve: "#ff0000",
    poules: [
      {
        naam: "Top Division Men 1 Regular Season",
        sort: "101NAHSE11A",
        guid: POULE_GUID,
        categorie: "Heren Senioren",
        teams: [
          {
            naam: "Antwerp Giants HSE B",
            guid: TEAM_GUID,
            rangNr: "  1",
            wedAant: "2",
            wedPunt: "4",
            wedWinst: "2",
            wedGelijk: "0",
            wedVerloren: "0",
            ptVoor: "160",
            ptTegen: "140",
            opmerk: "",
          },
          {
            naam: "Basket SKT Ieper HSE A",
            guid: "BVBL1426HSE  1",
            rangNr: "  2",
            wedAant: "2",
            wedPunt: "2",
            wedWinst: "0",
            wedGelijk: "0",
            wedVerloren: "2",
            ptVoor: "140",
            ptTegen: "160",
            opmerk: "",
          },
        ],
      },
    ],
    spelers: [
      { naam: "Peter Verfrindi", lidNr: "218412", sGebDat: "12-01-1981", sAanslDat: "02-09-2015 21:16" },
    ],
    tvlijst: [{ naam: "Kurt VanBeers", lidNr: "123438", tvCaC: "Coach", tvNr: "56254HSE1_170928" }],
  },
];

/** A team that plays in no poule at all — the standings fallback path. */
export const teamDetailNoPoules = [
  { guid: "BVBL9999HSE  1", naam: "Ghost Team", poules: [], spelers: null, tvlijst: null },
];

export const pouleMatches = [
  {
    guid: MATCH_GUID,
    wedID: "NAHSE11AAB06",
    tTGUID: TEAM_GUID,
    tTNaam: "Antwerp Giants HSE B",
    tUGUID: "BVBL1426HSE  1",
    tUNaam: "Basket SKT Ieper HSE A",
    datumString: "18-10-2026",
    accGUID: "BVBL600029",
    accNaam: "Heylen Vastgoed Basketcampus",
    pouleGUID: POULE_GUID,
    pouleNaam: "Top Division Men 1 Regular Season",
    gespeeld: "J",
    uitslag: " 80- 70",
    beginTijd: "16.00",
  },
  {
    guid: "BVBL26279180NAHSE11AAC",
    wedID: "NAHSE11AAC14",
    tTGUID: "BVBL1426HSE  1",
    tTNaam: "Basket SKT Ieper HSE A",
    tUGUID: TEAM_GUID,
    tUNaam: "Antwerp Giants HSE B",
    datumString: "15-01-2027",
    accGUID: "BVBL600030",
    accNaam: "Sporthal Ieper",
    pouleGUID: POULE_GUID,
    pouleNaam: "Top Division Men 1 Regular Season",
    gespeeld: "N",
    uitslag: "",
    beginTijd: "20.30",
  },
];

export const teamMatches = pouleMatches;

export const relaties = [
  {
    relGuid: "BVBL800001",
    naam: "Doe",
    vnaam: "Kees",
    lidNr: "218412",
    gebdat: "26-10-1987",
    mvo: "M",
    cat: "Senior",
  },
  {
    relGuid: "BVBL800002",
    naam: "Peeters",
    vnaam: "Anke",
    lidNr: "218413",
    gebdat: "01-02-1995",
    mvo: "V",
    cat: "Senior",
  },
];

export const matchDetail = [
  {
    _default: {
      wedID: "NAHSE11AAB06",
      planStatus: "ihabf",
      planHistorie: '{"lstHist":[{"dtMod":["20260612_134904"],"message":["Wijziging"]}]}',
      tTNaam: "Antwerp Giants HSE B",
      tUNaam: "Basket SKT Ieper HSE A",
      accNaam: "Heylen Vastgoed Basketcampus",
    },
  },
];

export const dwfLineup = [
  {
    wedGUID: MATCH_GUID,
    thuis: [{ naam: "Peter Verfrindi", rugNr: "7" }],
    uit: [{ naam: "Jan Peeters", rugNr: "12" }],
  },
];
