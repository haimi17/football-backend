// index.js – backend API-FOOTBALL pentru Football Pro Analyzer (versiune stabilă)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

// verificare cheie (NU blocăm serverul)
if (!API_KEY) {
  console.error("ATENȚIE: API_FOOTBALL_KEY nu este setată în Environment!");
}

// ligile folosite în frontend
const COMPETITIONS = [
  {
    id: 39,
    code: "PL",
    name: "Premier League",
    country: "England",
    apiLeagueId: 39,
    season: 2024,
  },
  {
    id: 135,
    code: "SA",
    name: "Serie A",
    country: "Italy",
    apiLeagueId: 135,
    season: 2024,
  },
  {
    id: 140,
    code: "PD",
    name: "La Liga",
    country: "Spain",
    apiLeagueId: 140,
    season: 2024,
  },
  {
    id: 61,
    code: "L1",
    name: "Ligue 1",
    country: "France",
    apiLeagueId: 61,
    season: 2024,
  },
  {
    id: 78,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany",
    apiLeagueId: 78,
    season: 2024,
  },
  {
    id: 88,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands",
    apiLeagueId: 88,
    season: 2024,
  },
  {
    id: 283,
    code: "RO1",
    name: "Superliga",
    country: "Romania",
    apiLeagueId: 283,
    season: 2024,
  },
  {
    id: 284,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284,
    season: 2024,
  },
];

// medii de goluri pe ligă – fallback realist (NU 0–0)
const LEAGUE_LAMBDAS = {
  39: { home: 1.55, away: 1.23 }, // Premier League
  135: { home: 1.42, away: 1.12 }, // Serie A
  140: { home: 1.25, away: 1.05 }, // La Liga
  61: { home: 1.45, away: 1.25 }, // Ligue 1
  78: { home: 1.75, away: 1.40 }, // Bundesliga
  88: { home: 1.60, away: 1.30 }, // Eredivisie
  283: { home: 1.30, away: 1.10 }, // RO1
  284: { home: 1.25, away: 1.05 }, // RO2
};

const teamStatsCache = new Map();
const factCache = {};

// utils

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

function parseForm(formStr) {
  if (!formStr || typeof formStr !== "string") return 0;
  // form gen "WDWLW"
  let score = 0;
  let count = 0;
  for (const ch of formStr.trim()) {
    if (ch === "W") {
      score += 1;
      count++;
    } else if (ch === "L") {
      score -= 1;
      count++;
    } else if (ch === "D") {
      count++;
    }
  }
  if (!count) return 0;
  // medie între -1 și +1
  return score / count;
}

// apel generic API-FOOTBALL
async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    });
  }

  const res = await fetch(url.toString(), {
    headers: {
      "x-apisports-key": API_KEY || "",
      accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Status ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data;
}

// statistici echipă cu cache
async function getTeamStats(leagueId, season, teamId) {
  const key = `${leagueId}-${season}-${teamId}`;
  if (teamStatsCache.has(key)) {
    return teamStatsCache.get(key);
  }

  try {
    const data = await apiFetch("/teams/statistics", {
      league: leagueId,
      season,
      team: teamId,
    });

    const stats = data?.response || null;
    teamStatsCache.set(key, stats);
    return stats;
  } catch (err) {
    console.error("Eroare /teams/statistics:", err.message);
    teamStatsCache.set(key, null);
    return null;
  }
}

// model Poisson + formă + siguranță
function buildPredictionFromLambdas(lambdaHome, lambdaAway, meta) {
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

  const sorted = [
    { key: "HOME", val: probHome },
    { key: "DRAW", val: probDrawPct },
    { key: "AWAY", val: probAway },
  ].sort((a, b) => b.val - a.val);

  const main = sorted[0];
  const second = sorted[1];

  // bază din Poisson: cât de mare e favorita și diferența față de locul 2
  let baseConf =
    0.6 * main.val + 0.4 * (main.val - second.val); // penalizează meciurile echilibrate

  // ajustare ușoară cu forma echipelor (meta.formDiff ∈ [-1,1])
  if (meta && typeof meta.formDiff === "number") {
    baseConf += meta.formDiff * 10; // max ±10 puncte
  }

  // clamp final între 45 și 80 – NU avem „oracol” 100%
  const confidence = clamp(baseConf, 45, 80);

  return {
    probHome,
    probDraw: probDrawPct,
    probAway,
    mainPick: main.key,
    confidence,
    goals: {
      over25,
      under25,
    },
    btts: {
      yes: bttsYes,
      no: bttsNo,
    },
    lambdas: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2)),
    },
  };
}

// predicție pentru un fixture
async function buildPredictionForFixture(comp, fixture) {
  const leagueId = comp.apiLeagueId;
  const season = comp.season;

  const homeId = fixture?.teams?.home?.id;
  const awayId = fixture?.teams?.away?.id;

  // fallback pe ligă
  const leagueLambda =
    LEAGUE_LAMBDAS[leagueId] || { home: 1.4, away: 1.2 };

  let lambdaHome = leagueLambda.home;
  let lambdaAway = leagueLambda.away;

  let formHome = 0;
  let formAway = 0;

  if (homeId && awayId && API_KEY) {
    try {
      const [homeStats, awayStats] = await Promise.all([
        getTeamStats(leagueId, season, homeId),
        getTeamStats(leagueId, season, awayId),
      ]);

      if (homeStats && awayStats) {
        const homePlayedHome = homeStats.fixtures?.played?.home || 0;
        const homeGFHome = homeStats.goals?.for?.total?.home || 0;
        const homeGAHome = homeStats.goals?.against?.total?.home || 0;

        const awayPlayedAway = awayStats.fixtures?.played?.away || 0;
        const awayGFAway = awayStats.goals?.for?.total?.away || 0;
        const awayGAAway = awayStats.goals?.against?.total?.away || 0;

        const homeGF =
          homePlayedHome > 0 ? homeGFHome / homePlayedHome : leagueLambda.home;
        const homeGA =
          homePlayedHome > 0 ? homeGAHome / homePlayedHome : leagueLambda.away;
        const awayGF =
          awayPlayedAway > 0 ? awayGFAway / awayPlayedAway : leagueLambda.away;
        const awayGA =
          awayPlayedAway > 0 ? awayGAAway / awayPlayedAway : leagueLambda.home;

        lambdaHome = (homeGF + awayGA) / 2;
        lambdaAway = (awayGF + homeGA) / 2;

        // avantaj teren propriu și penalizare ușoară pentru oaspeți
        lambdaHome *= 1.08;
        lambdaAway *= 0.96;

        lambdaHome = clamp(lambdaHome, 0.4, 2.8);
        lambdaAway = clamp(lambdaAway, 0.4, 2.8);

        // formă ultimele meciuri – doar pentru încredere
        formHome = parseForm(homeStats.form);
        formAway = parseForm(awayStats.form);
      }
    } catch (err) {
      console.error("Eroare la calculul lambdas:", err.message);
      // rămân valorile fallback pe ligă
    }
  }

  const meta = {
    formDiff: formHome - formAway, // >0 avantaj gazde în formă
  };

  return buildPredictionFromLambdas(lambdaHome, lambdaAway, meta);
}

// rute simple de test

app.get("/api/test-key", (req, res) => {
  res.json({
    ok: !!API_KEY,
    message: API_KEY ? "Cheie OK" : "Lipsește API_FOOTBALL_KEY",
  });
});

app.get("/api/competitions", (req, res) => {
  res.json(
    COMPETITIONS.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      country: c.country,
      apiLeagueId: c.apiLeagueId,
      season: c.season,
    }))
  );
});

// rute meciuri cu predicții
app.get("/api/matches", async (req, res) => {
  const compId = Number(req.query.competitionId);
  const comp = COMPETITIONS.find((c) => c.id === compId);

  if (!comp) {
    return res.json({
      matches: [],
      apiErrors: ["Competiție necunoscută"],
    });
  }

  const apiErrors = [];

  try {
    const today = new Date();
    const from = formatDate(today);
    const toDate = new Date(today);
    // 21 zile înainte – mai multe meciuri, mai puține ferestre goale
    toDate.setDate(toDate.getDate() + 21);
    const to = formatDate(toDate);

    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from,
      to,
    });

    const fixtures = fixturesData?.response || [];

    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      return res.json({
        matches: [],
        apiErrors,
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
        prediction,
      });
    }

    res.json({ matches, apiErrors });
  } catch (err) {
    console.error("Eroare /api/matches:", err.message);
    apiErrors.push("Eroare API-FOOTBALL la fixtures");
    res.json({
      matches: [],
      apiErrors,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT}`);
});
