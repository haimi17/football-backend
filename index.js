// index.js – backend Football Pro Analyzer (API-FOOTBALL PRO plan)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ------------------------
// Config competiții
// ------------------------
const COMPETITIONS = [
  // Anglia
  { id: 2021, code: "PL",  name: "Premier League",    country: "England",  apiLeagueId: 39,  season: 2024 },
  // Italia
  { id: 2019, code: "SA",  name: "Serie A",           country: "Italy",    apiLeagueId: 135, season: 2024 },
  // Spania
  { id: 2014, code: "PD",  name: "Primera División",  country: "Spain",    apiLeagueId: 140, season: 2024 },
  // Germania
  { id: 2002, code: "BL1", name: "Bundesliga",        country: "Germany",  apiLeagueId: 78,  season: 2024 },
  // Franța
  { id: 2015, code: "FL1", name: "Ligue 1",           country: "France",   apiLeagueId: 61,  season: 2024 },
  // Olanda
  { id: 2003, code: "DED", name: "Eredivisie",        country: "Netherlands", apiLeagueId: 88, season: 2024 },
  // Portugalia
  { id: 2017, code: "PPL", name: "Primeira Liga",     country: "Portugal", apiLeagueId: 94,  season: 2024 },
  // Champions League
  { id: 2001, code: "CL",  name: "UEFA Champions League", country: "Europe", apiLeagueId: 2, season: 2024 },

  // România – Superliga + Liga 2
  { id: 2501, code: "RO1", name: "Superliga",         country: "Romania",  apiLeagueId: 283, season: 2024 },
  { id: 2502, code: "RO2", name: "Liga 2",            country: "Romania",  apiLeagueId: 284, season: 2024 }
];

// cache simplu
const CACHE_TTL = 60 * 1000;
const cache = {
  matches: {},        // competitionId -> { timestamp, data }
  teamStats: {}       // key "leagueId:season:teamId" -> stats
};

// ------------------------
// Helpers generale
// ------------------------
function buildUrl(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

async function apiFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY lipsă în backend");
  }

  const url = buildUrl(path, params);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  if (!res.ok) {
    throw new Error(`API-Football ${path} status ${res.status}`);
  }

  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football errors: ${JSON.stringify(data.errors)}`);
  }

  return data;
}

function formScore(formStr) {
  if (!formStr || typeof formStr !== "string") return 0.5;
  const letters = formStr.trim().split("").slice(-5);
  if (letters.length === 0) return 0.5;

  let pts = 0;
  for (const ch of letters) {
    if (ch === "W") pts += 3;
    else if (ch === "D") pts += 1;
  }
  const maxPts = letters.length * 3;
  return maxPts > 0 ? pts / maxPts : 0.5;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

// ------------------------
// Poisson helpers
// ------------------------
const FACT = [1];
for (let i = 1; i <= 10; i++) {
  FACT[i] = FACT[i - 1] * i;
}

function poissonProb(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  if (k > 10) k = 10;
  return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
}

function buildPoissonModel(lambdaHome, lambdaAway) {
  const MAX_GOALS = 7;

  const ph = [];
  const pa = [];
  for (let k = 0; k <= MAX_GOALS; k++) {
    ph[k] = poissonProb(k, lambdaHome);
    pa[k] = poissonProb(k, lambdaAway);
  }

  let probHomeWin = 0;
  let probDraw = 0;
  let probAwayWin = 0;

  const totalGoals = Array(MAX_GOALS * 2 + 1).fill(0);

  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph[h] * pa[a];
      if (h > a) probHomeWin += p;
      else if (h === a) probDraw += p;
      else probAwayWin += p;

      totalGoals[h + a] += p;
    }
  }

  const pOver25 =
    totalGoals
      .map((p, g) => (g >= 3 ? p : 0))
      .reduce((s, p) => s + p, 0);

  const pUnder25 = 1 - pOver25;

  const pBTTSraw =
    1 - ph[0] - pa[0] + ph[0] * pa[0];

  const PRIOR_OVER25 = 0.52;
  const PRIOR_BTTS = 0.5;
  const W = 0.6;

  const pOver25Adj = clamp(
    W * pOver25 + (1 - W) * PRIOR_OVER25,
    0.20,
    0.80
  );

  const pBTTSAdj = clamp(
    W * pBTTSraw + (1 - W) * PRIOR_BTTS,
    0.20,
    0.80
  );

  const pBTTSNo = 1 - pBTTSAdj;

  return {
    probHomeWin,
    probDraw,
    probAwayWin,
    goals: {
      over25: pOver25Adj,
      under25: pUnder25
    },
    btts: {
      yes: pBTTSAdj,
      no: pBTTSNo
    }
  };
}

// ------------------------
// Statistici echipă
// ------------------------
async function getTeamStats(teamId, comp) {
  const key = `${comp.apiLeagueId}:${comp.season}:${teamId}`;
  const cached = cache.teamStats[key];
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.data;
  }

  const data = await apiFetch("/teams/statistics", {
    league: comp.apiLeagueId,
    season: comp.season,
    team: teamId
  });

  const st = Array.isArray(data.response)
    ? data.response[0]
    : data.response;

  const goals = st?.goals || {};
  const gForAvg = goals.for?.average || {};
  const gAgAvg = goals.against?.average || {};

  const stats = {
    avgGFHome: parseFloat(gForAvg.home ?? gForAvg.total ?? "1.4"),
    avgGFAway: parseFloat(gForAvg.away ?? gForAvg.total ?? "1.2"),
    avgGFTotal: parseFloat(gForAvg.total ?? "1.3"),
    avgGAHome: parseFloat(gAgAvg.home ?? gAgAvg.total ?? "1.2"),
    avgGAAway: parseFloat(gAgAvg.away ?? gAgAvg.total ?? "1.3"),
    avgGATotal: parseFloat(gAgAvg.total ?? "1.25"),
    formScore: formScore(st?.form)
  };

  cache.teamStats[key] = { data: stats, timestamp: Date.now() };
  return stats;
}

// ------------------------
// API routes
// ------------------------

// test cheie
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "API_FOOTBALL_KEY lipsă" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// liste competiții
app.get("/api/competitions", (req, res) => {
  const list = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));
  res.json(list);
});

// meciuri + predicții
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = Number(req.query.competitionId);
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === competitionId);
    if (!comp) {
      return res.status(400).json({ error: "Competiție necunoscută" });
    }

    const cacheEntry = cache.matches[competitionId];
    if (cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_TTL) {
      return res.json(cacheEntry.data);
    }

    const today = new Date();
    const toDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const fromStr = today.toISOString().split("T")[0];
    const toStr = toDate.toISOString().split("T")[0];

    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from: fromStr,
      to: toStr
    });

    const fixtures = fixturesData.response || [];

    const nowTs = Math.floor(Date.now() / 1000);
    const upcoming = fixtures.filter((fx) => {
      const ts = fx.fixture?.timestamp;
      return typeof ts === "number" && ts >= nowTs - 30 * 60; // nu mai vechi de 30 min
    });

    const matches = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = await getTeamStats(homeId, comp);
      const awayStats = await getTeamStats(awayId, comp);

      let lambdaHome =
        0.6 * homeStats.avgGFHome + 0.4 * awayStats.avgGAAway;
      let lambdaAway =
        0.6 * awayStats.avgGFAway + 0.4 * homeStats.avgGAHome;

      lambdaHome = clamp(lambdaHome, 0.3, 3.5);
      lambdaAway = clamp(lambdaAway, 0.3, 3.5);

      const diffForm = homeStats.formScore - awayStats.formScore;
      const formFactorHome = clamp(1 + diffForm * 0.2, 0.8, 1.2);
      const formFactorAway = clamp(1 - diffForm * 0.2, 0.8, 1.2);

      lambdaHome = clamp(lambdaHome * formFactorHome, 0.3, 3.8);
      lambdaAway = clamp(lambdaAway * formFactorAway, 0.3, 3.8);

      const model = buildPoissonModel(lambdaHome, lambdaAway);

      const pHome = model.probHomeWin;
      const pDraw = model.probDraw;
      const pAway = model.probAwayWin;

      const bestProb = Math.max(pHome, pDraw, pAway);
      let mainPick = "HOME";
      if (bestProb === pDraw) mainPick = "DRAW";
      else if (bestProb === pAway) mainPick = "AWAY";

      const confidence = Math.round(bestProb * 100);

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome: Math.round(pHome * 100),
          probDraw: Math.round(pDraw * 100),
          probAway: Math.round(pAway * 100),
          mainPick,
          confidence,
          goals: {
            over25: Math.round(model.goals.over25 * 100),
            under25: Math.round(model.goals.under25 * 100)
          },
          btts: {
            yes: Math.round(model.btts.yes * 100),
            no: Math.round(model.btts.no * 100)
          },
          lambdas: {
            home: parseFloat(lambdaHome.toFixed(2)),
            away: parseFloat(lambdaAway.toFixed(2))
          }
        }
      });
    }

    const out = { matches };
    cache.matches[competitionId] = {
      timestamp: Date.now(),
      data: out
    };

    res.json(out);
  } catch (e) {
    console.error("Eroare la /api/matches:", e);
    res.status(500).json({ error: "Eroare la meciuri" });
  }
});

// ------------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
