// index.js – backend API-FOOTBALL pentru Football Pro Analyzer

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.error("ATENȚIE: variabila de mediu API_FOOTBALL_KEY nu este setată!");
}

const API_BASE = "https://v3.football.api-sports.io";

// sezonul actual: pentru fotbal european, sezonul începe vara
function getCurrentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1–12
  // dacă suntem din iulie încolo, sezonul începe în anul curent
  return month >= 7 ? year : year - 1;
}

const CURRENT_SEASON = getCurrentSeason();

// Ligile din frontend
const COMPETITIONS = [
  { id: 39, code: "PL", name: "Premier League", country: "England", apiLeagueId: 39, season: CURRENT_SEASON },
  { id: 135, code: "SA", name: "Serie A", country: "Italy", apiLeagueId: 135, season: CURRENT_SEASON },
  { id: 140, code: "PD", name: "La Liga", country: "Spain", apiLeagueId: 140, season: CURRENT_SEASON },
  { id: 61, code: "L1", name: "Ligue 1", country: "France", apiLeagueId: 61, season: CURRENT_SEASON },
  { id: 78, code: "BL1", name: "Bundesliga", country: "Germany", apiLeagueId: 78, season: CURRENT_SEASON },
  { id: 88, code: "DED", name: "Eredivisie", country: "Netherlands", apiLeagueId: 88, season: CURRENT_SEASON },
  { id: 283, code: "RO1", name: "Superliga", country: "Romania", apiLeagueId: 283, season: CURRENT_SEASON },
  { id: 284, code: "RO2", name: "Liga 2", country: "Romania", apiLeagueId: 284, season: CURRENT_SEASON }
];

// cache pentru statistici de echipă
const teamStatsCache = new Map();

// utils
function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const factCache = {};
function factorial(n) {
  if (n < 0) return 0;
  if (n === 0 || n === 1) return 1;
  if (factCache[n]) return factCache[n];
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  factCache[n] = res;
  return res;
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

// apel generic la API FOOTBALL, cu status în eroare
async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }

  const res = await fetch(url.toString(), {
    headers: {
      "x-apisports-key": API_KEY,
      accept: "application/json"
    }
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }

  if (!res.ok) {
    const apiMsg =
      json?.errors?.token ||
      json?.errors?.server ||
      json?.errors?.requests ||
      text ||
      `Status ${res.status}`;
    const err = new Error(apiMsg);
    err.status = res.status;
    err.apiBody = json;
    throw err;
  }

  return json;
}

// wrapper cu retry (3 încercări pe erori 5xx)
async function apiFetchWithRetry(endpoint, params, retries = 2) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      if (i > 0) {
        console.warn(`Retry ${i} pentru ${endpoint}...`);
      }
      return await apiFetch(endpoint, params);
    } catch (e) {
      lastError = e;
      if (e.status && e.status < 500) break; // erori 4xx: nu mai are rost retry
    }
  }
  throw lastError;
}

// ia statistici pentru o echipă (cu cache)
async function getTeamStats(leagueId, season, teamId) {
  const key = `${leagueId}-${season}-${teamId}`;
  if (teamStatsCache.has(key)) return teamStatsCache.get(key);

  try {
    const data = await apiFetchWithRetry("/teams/statistics", {
      league: leagueId,
      season,
      team: teamId
    });

    const stats = data?.response;
    if (!stats) {
      teamStatsCache.set(key, null);
      return null;
    }
    teamStatsCache.set(key, stats);
    return stats;
  } catch (e) {
    console.error("Eroare la /teams/statistics:", e.message);
    teamStatsCache.set(key, null);
    return null;
  }
}

// ia fixtures pentru o competiție, cu fallback next -> from/to
async function getFixturesForCompetition(comp) {
  // 1. următoarele 30 de meciuri
  try {
    const byNext = await apiFetchWithRetry("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      next: 30
    });

    const fixturesNext = byNext?.response || [];
    if (Array.isArray(fixturesNext) && fixturesNext.length > 0) {
      return fixturesNext;
    }
  } catch (e) {
    console.error("Eroare fixtures cu next:", e.message);
  }

  // 2. fallback: interval 30 zile
  try {
    const today = new Date();
    const from = formatDate(today);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 30);
    const to = formatDate(toDate);

    const byRange = await apiFetchWithRetry("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from,
      to
    });

    const fixturesRange = byRange?.response || [];
    if (Array.isArray(fixturesRange) && fixturesRange.length > 0) {
      return fixturesRange;
    }
  } catch (e) {
    console.error("Eroare fixtures cu from/to:", e.message);
  }

  return [];
}

// calculează predicția din lambdas
function buildPredictionFromLambdas(lambdaHome, lambdaAway) {
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
      if (h > 0 && a > 0) probBTTS += p;
    }
  }

  const probHome = probHomeWin * 100;
  const probDrawPct = probDraw * 100;
  const probAway = probAwayWin * 100;
  const over25 = probOver25 * 100;
  const under25 = 100 - over25;
  const bttsYes = probBTTS * 100;
  const bttsNo = 100 - bttsYes;

  const probs = [
    { key: "HOME", val: probHome },
    { key: "DRAW", val: probDrawPct },
    { key: "AWAY", val: probAway }
  ].sort((a, b) => b.val - a.val);

  const mainPick = probs[0].key;
  const confidence = clamp(probs[0].val, 30, 85);

  return {
    probHome,
    probDraw: probDrawPct,
    probAway,
    mainPick,
    confidence,
    goals: {
      over25,
      under25
    },
    btts: {
      yes: bttsYes,
      no: bttsNo
    },
    lambdas: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    }
  };
}

// predicție pentru un fixture
async function buildPredictionForFixture(comp, fixture) {
  const homeId = fixture.teams?.home?.id;
  const awayId = fixture.teams?.away?.id;

  // fallback implicit
  let lambdaHome = 1.35;
  let lambdaAway = 1.25;

  if (homeId && awayId) {
    try {
      const [homeStats, awayStats] = await Promise.all([
        getTeamStats(comp.apiLeagueId, comp.season, homeId),
        getTeamStats(comp.apiLeagueId, comp.season, awayId)
      ]);

      if (homeStats && awayStats) {
        const homePlayedHome = homeStats.fixtures?.played?.home || 0;
        const homeGFHome = homeStats.goals?.for?.total?.home || 0;
        const homeGAHome = homeStats.goals?.against?.total?.home || 0;

        const awayPlayedAway = awayStats.fixtures?.played?.away || 0;
        const awayGFAway = awayStats.goals?.for?.total?.away || 0;
        const awayGAAway = awayStats.goals?.against?.total?.away || 0;

        const homeGF = homePlayedHome > 0 ? homeGFHome / homePlayedHome : 1.4;
        const homeGA = homePlayedHome > 0 ? homeGAHome / homePlayedHome : 1.2;

        const awayGF = awayPlayedAway > 0 ? awayGFAway / awayPlayedAway : 1.3;
        const awayGA = awayPlayedAway > 0 ? awayGAAway / awayPlayedAway : 1.2;

        lambdaHome = (homeGF + awayGA) / 2;
        lambdaAway = (awayGF + homeGA) / 2;

        lambdaHome *= 1.1; // avantaj teren
        lambdaAway *= 0.95;

        lambdaHome = clamp(lambdaHome, 0.4, 2.8);
        lambdaAway = clamp(lambdaAway, 0.4, 2.8);
      }
    } catch (e) {
      console.error("Eroare la calculul lambdas:", e.message);
    }
  }

  return buildPredictionFromLambdas(lambdaHome, lambdaAway);
}

// rute

// test cheie
app.get("/api/test-key", (req, res) => {
  res.json({
    ok: !!API_KEY,
    message: API_KEY ? "Cheie OK" : "Lipsește API_FOOTBALL_KEY"
  });
});

// status furnizor
app.get("/api/provider-status", async (req, res) => {
  if (!API_KEY) {
    return res.json({
      ok: false,
      status: "NO_KEY",
      message: "Lipsește API_FOOTBALL_KEY"
    });
  }

  try {
    const data = await apiFetchWithRetry("/status", null, 1);
    res.json({
      ok: true,
      status: "OK",
      raw: data
    });
  } catch (e) {
    res.json({
      ok: false,
      status: e.status || "ERROR",
      message: e.message
    });
  }
});

// competiții pentru frontend
app.get("/api/competitions", (req, res) => {
  res.json(
    COMPETITIONS.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      country: c.country,
      apiLeagueId: c.apiLeagueId,
      season: c.season
    }))
  );
});

// meciuri + predicții
app.get("/api/matches", async (req, res) => {
  const compId = Number(req.query.competitionId);
  const comp = COMPETITIONS.find((c) => c.id === compId);

  if (!comp) {
    return res.json({
      matches: [],
      apiErrors: ["Competiție necunoscută"]
    });
  }

  const apiErrors = [];

  try {
    const fixtures = await getFixturesForCompetition(comp);

    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      return res.json({
        matches: [],
        apiErrors: ["Nu există meciuri programate în perioada cerută"]
      });
    }

    const matches = [];
    for (const fixture of fixtures) {
      const prediction = await buildPredictionForFixture(comp, fixture);

      matches.push({
        id: fixture.fixture?.id,
        utcDate: fixture.fixture?.date,
        competition: comp.name,
        homeTeam: fixture.teams?.home?.name,
        awayTeam: fixture.teams?.away?.name,
        prediction
      });
    }

    res.json({ matches, apiErrors });
  } catch (e) {
    console.error("Eroare /api/matches:", e.message);

    if (e.status === 500) {
      apiErrors.push("API-FOOTBALL: eroare internă (500) sau server offline");
    } else if (
      e.message?.includes("Missing application key") ||
      e.status === 401 ||
      e.status === 403
    ) {
      apiErrors.push("API-FOOTBALL: problemă cu cheia (Missing application key / 401 / 403)");
    } else {
      apiErrors.push(`Eroare API-FOOTBALL la fixtures: ${e.message}`);
    }

    res.json({
      matches: [],
      apiErrors
    });
  }
});

// pornește serverul
app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT} | sezon curent ${CURRENT_SEASON}`);
});
