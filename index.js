// index.js - backend Football Pro Analyzer (API-FOOTBALL PRO)

// -----------------------------------------------------
// Importuri
// -----------------------------------------------------
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

// -----------------------------------------------------
// Config de bază
// -----------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

// 10 minute cache
const CACHE_TTL = 10 * 60 * 1000;

// -----------------------------------------------------
// Liste competiții (ID-urile folosite în frontend)
// -----------------------------------------------------
const COMPETITIONS = [
  // England
  {
    id: 2021,
    apiLeagueId: 39,
    season: 2024,
    code: "PL",
    name: "Premier League",
    country: "England"
  },
  // Champions League
  {
    id: 2001,
    apiLeagueId: 2,
    season: 2024,
    code: "CL",
    name: "UEFA Champions League",
    country: "Europe"
  },
  // France
  {
    id: 2015,
    apiLeagueId: 61,
    season: 2024,
    code: "FL1",
    name: "Ligue 1",
    country: "France"
  },
  // Germany
  {
    id: 2002,
    apiLeagueId: 78,
    season: 2024,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany"
  },
  // Italy
  {
    id: 2019,
    apiLeagueId: 135,
    season: 2024,
    code: "SA",
    name: "Serie A",
    country: "Italy"
  },
  // Netherlands
  {
    id: 2003,
    apiLeagueId: 88,
    season: 2024,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands"
  },
  // Portugal
  {
    id: 2017,
    apiLeagueId: 94,
    season: 2024,
    code: "PPL",
    name: "Primeira Liga",
    country: "Portugal"
  },
  // Spain
  {
    id: 2014,
    apiLeagueId: 140,
    season: 2024,
    code: "PD",
    name: "Primera Division",
    country: "Spain"
  },
  // România – Superliga
  {
    id: 2830,
    apiLeagueId: 283,
    season: 2024,
    code: "RO1",
    name: "Superliga",
    country: "Romania"
  },
  // România – Liga 2
  {
    id: 2840,
    apiLeagueId: 284,
    season: 2024,
    code: "RO2",
    name: "Liga 2",
    country: "Romania"
  }
];

// -----------------------------------------------------
// Middleware
// -----------------------------------------------------
app.use(cors());
app.use(express.json());

// -----------------------------------------------------
// Helper: apel către API-FOOTBALL
// -----------------------------------------------------
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
      "x-apisports-key": API_KEY,
      accept: "application/json"
    }
  });

  const data = await res.json();

  if (!res.ok || data.errors) {
    console.error("Eroare API-FOOTBALL", {
      path,
      status: res.status,
      params,
      errors: data.errors
    });
    throw new Error("Eroare de la API-FOOTBALL");
  }

  return data;
}

// -----------------------------------------------------
// Cache în memorie
// -----------------------------------------------------
const standingsCache = {}; // key: leagueId-season
const fixturesCache = {}; // key: leagueId-season-from-to

function cacheKey(obj) {
  return Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

// -----------------------------------------------------
// Helper: standings + stats echipe
// -----------------------------------------------------
async function getStandingsStats(leagueId, season) {
  const key = `${leagueId}-${season}`;
  const now = Date.now();

  if (
    standingsCache[key] &&
    now - standingsCache[key].timestamp < CACHE_TTL
  ) {
    return standingsCache[key].stats;
  }

  const data = await apiFetch("/standings", { league: leagueId, season });
  const table =
    data.response?.[0]?.league?.standings?.[0] || [];

  const stats = {};
  for (const row of table) {
    const teamId = row.team?.id;
    if (!teamId) continue;
    stats[teamId] = {
      played: row.all?.played ?? 0,
      goalsFor: row.all?.goals?.for ?? 0,
      goalsAgainst: row.all?.goals?.against ?? 0,
      points: row.points ?? 0,
      rank: row.rank ?? null
    };
  }

  standingsCache[key] = { stats, timestamp: now };
  return stats;
}

// -----------------------------------------------------
// Helper: Poisson și probabilități
// -----------------------------------------------------
function factorial(n) {
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function buildPrediction(homeStats, awayStats) {
  // fallback dacă lipsesc statistici
  if (!homeStats || !awayStats || homeStats.played === 0 || awayStats.played === 0) {
    const probHome = 33;
    const probDraw = 34;
    const probAway = 33;
    return {
      probHome,
      probDraw,
      probAway,
      mainPick: "DRAW",
      confidence: 34,
      goals: { over25: 50, under25: 50 },
      btts: { yes: 50, no: 50 },
      lambdas: { home: 1.2, away: 1.2 }
    };
  }

  const homeGF = homeStats.goalsFor / homeStats.played;
  const homeGA = homeStats.goalsAgainst / homeStats.played;
  const awayGF = awayStats.goalsFor / awayStats.played;
  const awayGA = awayStats.goalsAgainst / awayStats.played;

  let lambdaHome = (homeGF + awayGA) / 2;
  let lambdaAway = (awayGF + homeGA) / 2;

  // Avantaj teren propriu ușor
  lambdaHome *= 1.1;

  lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 3.5);
  lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 3.5);

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
      const total = h + a;

      if (h > a) probHomeWin += p;
      else if (h === a) probDraw += p;
      else probAwayWin += p;

      if (total >= 3) probOver25 += p;
      if (h >= 1 && a >= 1) probBTTS += p;
    }
  }

  const probHomePct = Math.round(probHomeWin * 100);
  const probDrawPct = Math.round(probDraw * 100);
  const probAwayPct = Math.round(probAwayWin * 100);

  const mainArray = [
    { key: "HOME", val: probHomePct },
    { key: "DRAW", val: probDrawPct },
    { key: "AWAY", val: probAwayPct }
  ].sort((a, b) => b.val - a.val);

  const best = mainArray[0];

  return {
    probHome: probHomePct,
    probDraw: probDrawPct,
    probAway: probAwayPct,
    mainPick: best.key,
    confidence: best.val,
    goals: {
      over25: Math.round(probOver25 * 100),
      under25: Math.round((1 - probOver25) * 100)
    },
    btts: {
      yes: Math.round(probBTTS * 100),
      no: Math.round((1 - probBTTS) * 100)
    },
    lambdas: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    }
  };
}

// -----------------------------------------------------
// Route: test cheie
// -----------------------------------------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "API_FOOTBALL_KEY lipsă în backend" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// -----------------------------------------------------
// Route: competiții
// -----------------------------------------------------
app.get("/api/competitions", (req, res) => {
  const out = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));
  res.json(out);
});

// -----------------------------------------------------
// Route: meciuri cu predicții
// -----------------------------------------------------
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

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    // Interval: azi + 21 zile
    const now = new Date();
    const fromDate = now;
    const toDate = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);

    const fromStr = fromDate.toISOString().split("T")[0];
    const toStr = toDate.toISOString().split("T")[0];

    const fixturesKey = cacheKey({
      league: comp.apiLeagueId,
      season: comp.season,
      from: fromStr,
      to: toStr
    });

    let fixturesData;
    const nowTs = Date.now();

    if (
      fixturesCache[fixturesKey] &&
      nowTs - fixturesCache[fixturesKey].timestamp < CACHE_TTL
    ) {
      fixturesData = fixturesCache[fixturesKey].data;
    } else {
      fixturesData = await apiFetch("/fixtures", {
        league: comp.apiLeagueId,
        season: comp.season,
        from: fromStr,
        to: toStr,
        timezone: "Europe/Bucharest"
      });
      fixturesCache[fixturesKey] = {
        data: fixturesData,
        timestamp: nowTs
      };
    }

    const fixtures = fixturesData.response || [];

    // vrem doar meciuri nenîncepute sau programate
    const upcoming = fixtures.filter((fx) => {
      const status = fx.fixture?.status?.short;
      return status === "NS" || status === "TBD" || status === "PST";
    });

    const stats = await getStandingsStats(comp.apiLeagueId, comp.season);

    const matches = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = stats[homeId];
      const awayStats = stats[awayId];

      const prediction = buildPrediction(homeStats, awayStats);

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction
      });
    }

    res.json({ matches });
  } catch (e) {
    console.error("Eroare la /api/matches:", e);
    res.status(500).json({ error: "Eroare la meciuri" });
  }
});

// -----------------------------------------------------
// Pornire server
// -----------------------------------------------------
app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT}`);
});
