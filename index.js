// index.js – backend API-FOOTBALL pentru Football Pro Analyzer

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

// verificare cheie în logs (nu blocăm serverul dacă lipsește)
if (!API_KEY) {
  console.error(
    "ATENȚIE: variabila de mediu API_FOOTBALL_KEY nu este setată!"
  );
}

const API_BASE = "https://v3.football.api-sports.io";

// Ligile din frontend (id = id folosit de frontend)
const COMPETITIONS = [
  { id: 39, code: "PL", name: "Premier League", country: "England", apiLeagueId: 39, season: 2024 },
  { id: 135, code: "SA", name: "Serie A", country: "Italy", apiLeagueId: 135, season: 2024 },
  { id: 140, code: "PD", name: "La Liga", country: "Spain", apiLeagueId: 140, season: 2024 },
  { id: 61, code: "L1", name: "Ligue 1", country: "France", apiLeagueId: 61, season: 2024 },
  { id: 78, code: "BL1", name: "Bundesliga", country: "Germany", apiLeagueId: 78, season: 2024 },
  { id: 88, code: "DED", name: "Eredivisie", country: "Netherlands", apiLeagueId: 88, season: 2024 },
  { id: 283, code: "RO1", name: "Superliga", country: "Romania", apiLeagueId: 283, season: 2024 },
  { id: 284, code: "RO2", name: "Liga 2", country: "Romania", apiLeagueId: 284, season: 2024 }
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

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
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

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

// apel generic la API FOOTBALL
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Status ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data;
}

// ia statistici pentru o echipă (cu cache)
async function getTeamStats(leagueId, season, teamId) {
  const key = `${leagueId}-${season}-${teamId}`;
  if (teamStatsCache.has(key)) {
    return teamStatsCache.get(key);
  }

  try {
    const data = await apiFetch("/teams/statistics", {
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

// calculează lambdas și probabilități din statistici sau fallback
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

  // transformăm în procente
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

// face predicția pentru un meci (folosește statistici, cu fallback sigur)
async function buildPredictionForFixture(comp, fixture) {
  const homeId = fixture.teams?.home?.id;
  const awayId = fixture.teams?.away?.id;

  // fallback implicit: meci mediu de ligă
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

        const homeGF =
          homePlayedHome > 0 ? homeGFHome / homePlayedHome : 1.4;
        const homeGA =
          homePlayedHome > 0 ? homeGAHome / homePlayedHome : 1.2;

        const awayGF =
          awayPlayedAway > 0 ? awayGFAway / awayPlayedAway : 1.3;
        const awayGA =
          awayPlayedAway > 0 ? awayGAAway / awayPlayedAway : 1.2;

        lambdaHome = (homeGF + awayGA) / 2;
        lambdaAway = (awayGF + homeGA) / 2;

        // avantaj teren propriu
        lambdaHome *= 1.10;
        lambdaAway *= 0.95;

        lambdaHome = clamp(lambdaHome, 0.4, 2.8);
        lambdaAway = clamp(lambdaAway, 0.4, 2.8);
      }
    } catch (e) {
      console.error("Eroare la calculul lambdas:", e.message);
      // rămân valorile fallback 1.35 / 1.25
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

// listează competițiile pentru frontend
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

// ia meciurile cu predicții
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
    const today = new Date();
    const from = formatDate(today);
    const toDate = new Date(today);
    toDate.setDate(toDate.getDate() + 14); // 14 zile înainte
    const to = formatDate(toDate);

    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from,
      to
    });

    const fixtures = fixturesData?.response || [];

    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      return res.json({
        matches: [],
        apiErrors
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
    apiErrors.push("Eroare la fixtures API");
    res.json({
      matches: [],
      apiErrors
    });
  }
});

// pornește serverul
app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT}`);
});
