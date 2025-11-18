// index.js – backend API-FOOTBALL cu fereastră 21 zile

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";
const DAYS_AHEAD = 21;

// competițiile folosite în aplicație
const COMPETITIONS = [
  {
    id: 39,
    code: "PL",
    name: "Premier League",
    country: "England",
    apiLeagueId: 39,
    season: 2024
  },
  {
    id: 135,
    code: "SA",
    name: "Serie A",
    country: "Italy",
    apiLeagueId: 135,
    season: 2024
  },
  {
    id: 140,
    code: "PD",
    name: "La Liga",
    country: "Spain",
    apiLeagueId: 140,
    season: 2024
  },
  {
    id: 61,
    code: "L1",
    name: "Ligue 1",
    country: "France",
    apiLeagueId: 61,
    season: 2024
  },
  {
    id: 78,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany",
    apiLeagueId: 78,
    season: 2024
  },
  {
    id: 88,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands",
    apiLeagueId: 88,
    season: 2024
  },
  {
    id: 283,
    code: "RO1",
    name: "Superliga",
    country: "Romania",
    apiLeagueId: 283,
    season: 2024
  },
  {
    id: 284,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284,
    season: 2024
  }
];

app.use(cors());
app.use(express.json());

// cache simplu în memorie
const CACHE_TTL_FIXTURES = 5 * 60 * 1000; // 5 minute
const CACHE_TTL_STATS = 60 * 60 * 1000; // 1 oră

const fixturesCache = {}; // { [competitionId]: { timestamp, data } }
const teamStatsCache = {}; // { `${leagueId}_${season}_${teamId}`: { timestamp, data } }

// utilitar pentru apeluri către API-FOOTBALL
async function apiFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const data = await res.json();

  if (!res.ok || data.errors || data.error) {
    throw new Error(
      `Eroare API-FOOTBALL la ${path}: ` +
        JSON.stringify(data.errors || data.error || data)
    );
  }

  return data;
}

// Poisson
function poissonPMF(lambda, k) {
  if (lambda <= 0) return 0;
  const e = Math.exp(-lambda);
  let num = 1;
  for (let i = 1; i <= k; i++) {
    num *= lambda / i;
  }
  return e * num;
}

// statistici echipă cu cache
async function getTeamStats(leagueId, season, teamId) {
  const key = `${leagueId}_${season}_${teamId}`;
  const now = Date.now();

  if (
    teamStatsCache[key] &&
    now - teamStatsCache[key].timestamp < CACHE_TTL_STATS
  ) {
    return teamStatsCache[key].data;
  }

  const data = await apiFetch("/teams/statistics", {
    league: leagueId,
    season,
    team: teamId
  });

  teamStatsCache[key] = {
    timestamp: now,
    data
  };

  return data;
}

// calculează predicțiile pentru un meci
async function buildPrediction(comp, fixture) {
  const leagueId = comp.apiLeagueId;
  const season = comp.season;

  const teams = fixture.teams;
  const homeId = teams.home.id;
  const awayId = teams.away.id;

  if (!homeId || !awayId) {
    return null;
  }

  const homeStats = await getTeamStats(leagueId, season, homeId);
  const awayStats = await getTeamStats(leagueId, season, awayId);

  const homeGF = homeStats.goals.for.average.home || 1.2;
  const homeGA = homeStats.goals.against.average.home || 1.2;
  const awayGF = awayStats.goals.for.average.away || 1.2;
  const awayGA = awayStats.goals.against.average.away || 1.2;

  let lambdaHome = (homeGF + awayGA) / 2;
  let lambdaAway = (awayGF + homeGA) / 2;

  lambdaHome *= 1.1; // avantaj teren propriu

  lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 4);
  lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 4);

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

      if (h > a) probHomeWin += p;
      else if (h === a) probDraw += p;
      else probAwayWin += p;

      if (h + a >= 3) probOver25 += p;
      if (h >= 1 && a >= 1) probBTTS += p;
    }
  }

  const probHomePct = Math.round(probHomeWin * 100);
  const probDrawPct = Math.round(probDraw * 100);
  const probAwayPct = Math.round(probAwayWin * 100);
  const over25Pct = Math.round(probOver25 * 100);
  const under25Pct = 100 - over25Pct;
  const bttsYesPct = Math.round(probBTTS * 100);
  const bttsNoPct = 100 - bttsYesPct;

  let mainPick = "HOME";
  let maxProb = probHomePct;

  if (probDrawPct > maxProb) {
    maxProb = probDrawPct;
    mainPick = "DRAW";
  }
  if (probAwayPct > maxProb) {
    maxProb = probAwayPct;
    mainPick = "AWAY";
  }

  const confidence = Math.min(100, Math.max(30, maxProb));

  return {
    probHome: probHomePct,
    probDraw: probDrawPct,
    probAway: probAwayPct,
    mainPick,
    confidence,
    goals: {
      over25: over25Pct,
      under25: under25Pct
    },
    btts: {
      yes: bttsYesPct,
      no: bttsNoPct
    },
    lambdas: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    }
  };
}

// ----------------------
// test cheie
// ----------------------
app.get("/api/test-key", (req, res) => {
  const ok = !!API_KEY;
  res.json({
    ok,
    message: ok ? "Cheie OK" : "API_FOOTBALL_KEY lipsă în backend"
  });
});

// ----------------------
// liste competiții
// ----------------------
app.get("/api/competitions", (req, res) => {
  const out = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));
  res.json(out);
});

// ----------------------
// meciuri + predicții
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = Number(req.query.competitionId);
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === competitionId);
    if (!comp) {
      return res.status(400).json({ error: "competitionId necunoscut" });
    }

    const now = Date.now();

    if (
      fixturesCache[competitionId] &&
      now - fixturesCache[competitionId].timestamp < CACHE_TTL_FIXTURES
    ) {
      return res.json({ matches: fixturesCache[competitionId].data });
    }

    const today = new Date();
    const toDate = new Date(today.getTime() + DAYS_AHEAD * 24 * 60 * 60 * 1000);

    const fromStr = today.toISOString().split("T")[0];
    const toStr = toDate.toISOString().split("T")[0];

    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from: fromStr,
      to: toStr
    });

    const fixtures = fixturesData.response || [];

    const upcoming = fixtures.filter((fx) => {
      const status = fx.fixture?.status?.short;
      return status === "NS" || status === "TBD";
    });

    const matches = [];

    for (const fx of upcoming) {
      const prediction = await buildPrediction(comp, fx);
      if (!prediction) continue;

      matches.push({
        id: fx.fixture.id,
        utcDate: fx.fixture.date,
        competition: comp.name,
        homeTeam: fx.teams.home.name,
        awayTeam: fx.teams.away.name,
        prediction
      });
    }

    fixturesCache[competitionId] = {
      timestamp: now,
      data: matches
    };

    res.json({ matches });
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    res.status(500).json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe portul ${PORT}`);
});
