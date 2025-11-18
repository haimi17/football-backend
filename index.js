// index.js - backend API-FOOTBALL pentru Football Pro Analyzer

const express = require("express");
const cors = require("cors");

// -------------------------
// Config
// -------------------------

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.error("ATENȚIE: variabila de mediu API_FOOTBALL_KEY nu este setată!");
}

const API_BASE = "https://v3.football.api-sports.io";

// competițiile pe care le afișăm în frontend
const COMPETITIONS = [
  { id: 39, code: "PL",  name: "Premier League", country: "England",  apiLeagueId: 39,  season: 2024 },
  { id: 135, code: "SA", name: "Serie A",        country: "Italy",    apiLeagueId: 135, season: 2024 },
  { id: 140, code: "PD", name: "La Liga",        country: "Spain",    apiLeagueId: 140, season: 2024 },
  { id: 61,  code: "L1", name: "Ligue 1",        country: "France",   apiLeagueId: 61,  season: 2024 },
  { id: 78,  code: "BL1",name: "Bundesliga",     country: "Germany",  apiLeagueId: 78,  season: 2024 },
  { id: 88,  code: "DED",name: "Eredivisie",     country: "Netherlands", apiLeagueId: 88, season: 2024 },
  { id: 283, code: "RO1",name: "Superliga",      country: "Romania",  apiLeagueId: 283, season: 2024 },
  { id: 284, code: "RO2",name: "Liga 2",         country: "Romania",  apiLeagueId: 284, season: 2024 }
];

// -------------------------
// Helper pentru apel API-FOOTBALL
// -------------------------

async function apiFetch(endpoint, params = {}) {
  const qs = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      qs.append(key, String(value));
    }
  });

  const url = `${API_BASE}${endpoint}?${qs.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY,
      accept: "application/json"
    }
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      (json && json.message) ||
      (json && json.errors && JSON.stringify(json.errors)) ||
      `Status ${res.status}`;
    throw new Error(msg);
  }

  return json;
}

// factorial mic pentru Poisson
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040];

function poissonPMF(lambda, k) {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  if (k < 0 || k >= FACT.length) return 0;
  return Math.pow(lambda, k) * Math.exp(-lambda) / FACT[k];
}

function safeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// -------------------------
// Rute simple
// -------------------------

app.get("/", (req, res) => {
  res.send("Football backend OK");
});

app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "Lipsește API_FOOTBALL_KEY" });
  }
  res.json({ ok: true, message: "Cheie OK" });
});

app.get("/api/competitions", (req, res) => {
  res.json(COMPETITIONS);
});

// -------------------------
// Rută principală: /api/matches
// -------------------------

app.get("/api/matches", async (req, res) => {
  const competitionId = Number(req.query.competitionId || req.query.league);
  const comp = COMPETITIONS.find((c) => c.id === competitionId);

  if (!comp) {
    return res.status(400).json({
      matches: [],
      apiErrors: ["Competiție invalidă"]
    });
  }

  const apiErrors = [];

  try {
    // 1) preluăm clasamentul pentru a calcula medii de goluri
    let teamStatsMap = new Map();

    try {
      const standingsJson = await apiFetch("/standings", {
        league: comp.apiLeagueId,
        season: comp.season
      });

      const standingsResp = standingsJson.response?.[0]?.league?.standings?.[0];

      if (Array.isArray(standingsResp)) {
        for (const row of standingsResp) {
          const teamId = row.team?.id;
          if (!teamId) continue;

          teamStatsMap.set(teamId, {
            homePlayed: safeNumber(row.home?.played, 1),
            homeGF: safeNumber(row.home?.goals?.for, 1),
            homeGA: safeNumber(row.home?.goals?.against, 1),
            awayPlayed: safeNumber(row.away?.played, 1),
            awayGF: safeNumber(row.away?.goals?.for, 1),
            awayGA: safeNumber(row.away?.goals?.against, 1)
          });
        }
      } else {
        apiErrors.push("Standings lipsă sau format necunoscut");
      }
    } catch (err) {
      console.error("Eroare la standings:", err.message);
      apiErrors.push("Eroare la standings: " + err.message);
    }

    // funcție locală pentru a obține medii GF/GA
    function getTeamModel(teamId) {
      const row = teamStatsMap.get(teamId);
      if (!row) {
        return {
          homeGF: 1.4,
          homeGA: 1.2,
          awayGF: 1.2,
          awayGA: 1.4
        };
      }

      const homeGF = row.homeGF / Math.max(1, row.homePlayed);
      const homeGA = row.homeGA / Math.max(1, row.homePlayed);
      const awayGF = row.awayGF / Math.max(1, row.awayPlayed);
      const awayGA = row.awayGA / Math.max(1, row.awayPlayed);

      return { homeGF, homeGA, awayGF, awayGA };
    }

    // 2) luăm următoarele meciuri cu parametru "next"
    //    nu mai folosim from/to ca să evităm problemele de calendar
    let fixturesJson;
    try {
      fixturesJson = await apiFetch("/fixtures", {
        league: comp.apiLeagueId,
        season: comp.season,
        next: 20,
        timezone: "Europe/Bucharest"
      });
    } catch (err) {
      console.error("Eroare API-FOOTBALL la /fixtures:", err.message);
      apiErrors.push("Eroare API-FOOTBALL la /fixtures: " + err.message);
      return res.json({ matches: [], apiErrors });
    }

    const fixtures = Array.isArray(fixturesJson.response)
      ? fixturesJson.response
      : [];

    const upcoming = fixtures.filter((fx) => {
      const status = fx?.fixture?.status?.short;
      return status === "NS" || status === "TBD";
    });

    const matchesOut = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home?.id || !teams?.away?.id) {
        continue;
      }

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeModel = getTeamModel(homeId);
      const awayModel = getTeamModel(awayId);

      // λ pentru Poisson
      let lambdaHome = (homeModel.homeGF + awayModel.awayGA) / 2;
      let lambdaAway = (awayModel.awayGF + homeModel.homeGA) / 2;

      // avantaj casă
      lambdaHome *= 1.1;

      // limite rezonabile
      lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 3.5);
      lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 3.5);

      // distribuție Poisson până la 7 goluri
      const maxGoals = 7;
      const pHome = [];
      const pAway = [];

      for (let k = 0; k <= maxGoals; k++) {
        pHome[k] = poissonPMF(lambdaHome, k);
        pAway[k] = poissonPMF(lambdaAway, k);
      }

      let probHomeWin = 0;
      let probDraw = 0;
      let probAwayWin = 0;
      let probOver25 = 0;
      let probBTTS = 0;

      for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
          const p = pHome[h] * pAway[a];
          if (p <= 0) continue;

          if (h > a) probHomeWin += p;
          else if (h === a) probDraw += p;
          else probAwayWin += p;

          if (h + a >= 3) probOver25 += p;
          if (h > 0 && a > 0) probBTTS += p;
        }
      }

      // rotunjire în procente
      const probHomePct = Math.round(probHomeWin * 100);
      const probDrawPct = Math.round(probDraw * 100);
      const probAwayPct = Math.round(probAwayWin * 100);
      const over25Pct = Math.round(probOver25 * 100);
      const bttsYesPct = Math.round(probBTTS * 100);

      // alegere pronostic principal
      let mainPick = "HOME";
      let best = probHomePct;

      if (probDrawPct > best) {
        best = probDrawPct;
        mainPick = "DRAW";
      }
      if (probAwayPct > best) {
        best = probAwayPct;
        mainPick = "AWAY";
      }

      // "încredere" = cel mai mare procent dintre 1/X/2,
      // tăiat între 40% și 80% ca să nu devină "oracol"
      let confidence = best;
      confidence = Math.max(confidence, 40);
      confidence = Math.min(confidence, 80);

      matchesOut.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome: probHomePct,
          probDraw: probDrawPct,
          probAway: probAwayPct,
          mainPick,
          confidence,
          goals: {
            over25: over25Pct,
            under25: 100 - over25Pct
          },
          btts: {
            yes: bttsYesPct,
            no: 100 - bttsYesPct
          },
          lambdas: {
            home: Number(lambdaHome.toFixed(2)),
            away: Number(lambdaAway.toFixed(2))
          }
        }
      });
    }

    return res.json({
      matches: matchesOut,
      apiErrors
    });
  } catch (err) {
    console.error("Eroare generală la /api/matches:", err);
    return res.status(500).json({
      matches: [],
      apiErrors: ["Eroare generală la /api/matches: " + err.message]
    });
  }
});

// -------------------------
// Pornire server
// -------------------------

app.listen(PORT, () => {
  console.log(`Backend ready on port ${PORT}`);
});
