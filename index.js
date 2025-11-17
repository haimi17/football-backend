import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// cheia din Render → Environment → FOOTBALL_DATA_KEY
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// cache simplu (2 minute)
const CACHE_TTL_MS = 2 * 60 * 1000;

const cache = {
  competitions: { data: null, timestamp: 0 },
  standings: {}, // [competitionId] → { data, timestamp }
  matches: {},   // [competitionId] → { data, timestamp }
};

function isValidCache(entry) {
  return entry && entry.data && Date.now() - entry.timestamp < CACHE_TTL_MS;
}

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

// ----------------------
// Root + test cheie
// ----------------------
app.get("/", (req, res) => {
  res.send("Football backend OK (football-data.org, Poisson model)");
});

app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({
      ok: false,
      message: "FOOTBALL_DATA_KEY lipsă în backend",
    });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// ----------------------
// Helper: apel generic la football-data.org
// ----------------------
async function fdGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error("FOOTBALL_DATA_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const resp = await fetch(url.toString(), {
    headers: {
      "X-Auth-Token": API_KEY,
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Eroare ${resp.status} la ${url.toString()}:`, text);
    const err = new Error("Eroare la football-data.org");
    err.status = resp.status;
    throw err;
  }

  return resp.json();
}

// ----------------------
// 1. COMPETIȚII (ligile mari)
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (isValidCache(cache.competitions)) {
      return res.json(cache.competitions.data);
    }

    const data = await fdGet("/competitions");

    const allowedCodes = ["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "CL"];

    const comps = (data.competitions || [])
      .filter((c) => allowedCodes.includes(c.code))
      .map((c) => ({
        id: c.id,          // ex: 2021 pentru Premier League
        code: c.code,      // ex: "PL"
        name: c.name,      // ex: "Premier League"
        country: c.area?.name || "",
      }));

    cache.competitions = {
      data: comps,
      timestamp: Date.now(),
    };

    return res.json(comps);
  } catch (err) {
    console.error("Eroare /api/competitions:", err);
    const status = err.status || 500;
    return res.status(status).json({ error: "Eroare la competiții" });
  }
});

// ----------------------
// 2. STANDINGS + statistici ligă
// ----------------------
async function getStandings(competitionId) {
  const cached = cache.standings[competitionId];
  if (isValidCache(cached)) return cached.data;

  const data = await fdGet(`/competitions/${competitionId}/standings`);

  const totalTable = (data.standings || []).find(
    (s) => s.type === "TOTAL"
  );
  const table = totalTable?.table || [];

  cache.standings[competitionId] = {
    data: table,
    timestamp: Date.now(),
  };

  return table;
}

function computeLeagueStats(table) {
  if (!table || table.length === 0) {
    return {
      leagueAvgGoalsPerMatch: 2.6,
      leagueAvgGoalsPerTeam: 1.3,
    };
  }

  let totalPlayed = 0;
  let totalGF = 0;

  for (const row of table) {
    const played = row.playedGames || 0;
    const gf = row.goalsFor || 0;
    totalPlayed += played;
    totalGF += gf;
  }

  const matchesTotal = totalPlayed / 2 || 1; // fiecare meci are 2 echipe
  const leagueTotalGoals = totalGF; // fiecare gol aparține unei echipe
  const leagueAvgGoalsPerMatch = leagueTotalGoals / matchesTotal; // ex: 2.7
  const leagueAvgGoalsPerTeam = leagueAvgGoalsPerMatch / 2;       // ex: 1.35

  return { leagueAvgGoalsPerMatch, leagueAvgGoalsPerTeam };
}

function buildTeamStats(entry, leagueAvgGoalsPerTeam) {
  const played = entry.playedGames || 1;
  const gf = entry.goalsFor || 0;
  const ga = entry.goalsAgainst || 0;

  const avgGF = gf / played;
  const avgGA = ga / played;

  const base = leagueAvgGoalsPerTeam || 1.3;
  const attackStrength = avgGF / base; 
  const defenseWeakness = avgGA / base; 

  return {
    avgGF,
    avgGA,
    attackStrength,
    defenseWeakness,
  };
}

// ----------------------
// Poisson helpers
// ----------------------
function factorial(k) {
  let res = 1;
  for (let i = 2; i <= k; i++) res *= i;
  return res;
}

function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function buildPoissonPrediction(homeStats, awayStats, leagueStats) {
  const { leagueAvgGoalsPerMatch } = leagueStats;

  const baseMatchGoals = leagueAvgGoalsPerMatch || 2.6;
  const baseTeamGoals = baseMatchGoals / 2 || 1.3;

  const homeAdvFactor = 1.15;

  let lambdaHome =
    baseTeamGoals *
    homeStats.attackStrength *
    awayStats.defenseWeakness *
    homeAdvFactor;

  let lambdaAway =
    baseTeamGoals *
    awayStats.attackStrength *
    homeStats.defenseWeakness;

  lambdaHome = Math.max(0.1, Math.min(4.5, lambdaHome));
  lambdaAway = Math.max(0.1, Math.min(4.5, lambdaAway));

  const maxGoals = 7;

  const pHomeGoals = [];
  const pAwayGoals = [];

  for (let k = 0; k <= maxGoals; k++) {
    pHomeGoals[k] = poissonProb(lambdaHome, k);
    pAwayGoals[k] = poissonProb(lambdaAway, k);
  }

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pOver25 = 0;
  let pBTTSyes = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = pHomeGoals[i] * pAwayGoals[j];

      if (i > j) pHome += p;
      else if (i === j) pDraw += p;
      else pAway += p;

      if (i + j >= 3) pOver25 += p;

      if (i >= 1 && j >= 1) pBTTSyes += p;
    }
  }

  const pUnder25 = 1 - pOver25;
  const pBTTSno = 1 - pBTTSyes;

  let probHome = Math.round(pHome * 100);
  let probDraw = Math.round(pDraw * 100);
  let probAway = Math.round(pAway * 100);
  let over25 = Math.round(pOver25 * 100);
  let under25 = 100 - over25;
  let bttsYes = Math.round(pBTTSyes * 100);
  let bttsNo = 100 - bttsYes;

  const sum1x2 = probHome + probDraw + probAway;
  if (sum1x2 !== 100) {
    const diff = 100 - sum1x2;
    if (probHome >= probDraw && probHome >= probAway) probHome += diff;
    else if (probAway >= probHome && probAway >= probDraw) probAway += diff;
    else probDraw += diff;
  }

  const sumOU = over25 + under25;
  if (sumOU !== 100) {
    const diff = 100 - sumOU;
    if (over25 >= under25) over25 += diff;
    else under25 += diff;
  }

  const sumBTTS = bttsYes + bttsNo;
  if (sumBTTS !== 100) {
    const diff = 100 - sumBTTS;
    if (bttsYes >= bttsNo) bttsYes += diff;
    else bttsNo += diff;
  }

  const maxMain = Math.max(probHome, probDraw, probAway);
  let mainPick = "HOME";
  if (maxMain === probDraw) mainPick = "DRAW";
  if (maxMain === probAway) mainPick = "AWAY";

  const sorted = [probHome, probDraw, probAway].sort((a, b) => b - a);
  const gap = sorted[0] - sorted[1];
  let confidence = Math.round(sorted[0] - gap * 0.3);
  confidence = Math.max(35, Math.min(90, confidence));

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
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
      home: +lambdaHome.toFixed(2),
      away: +lambdaAway.toFixed(2),
    },
  };
}

// ----------------------
// 3. MECIURI + PREDICȚII
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;

    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const cached = cache.matches[competitionId];
    if (isValidCache(cached)) {
      return res.json(cached.data);
    }

    const today = new Date();
    const dateFrom = formatDate(today);

    const to = new Date(today);
    to.setDate(today.getDate() + 7);
    const dateTo = formatDate(to);

    const table = await getStandings(competitionId);
    const leagueStats = computeLeagueStats(table);
    const leagueAvgGoalsPerTeam = leagueStats.leagueAvgGoalsPerTeam;

    const statsByTeamId = {};
    for (const row of table) {
      const teamId = row.team?.id;
      if (!teamId) continue;
      statsByTeamId[teamId] = buildTeamStats(row, leagueAvgGoalsPerTeam);
    }

    const data = await fdGet(`/competitions/${competitionId}/matches`, {
      status: "SCHEDULED",
      dateFrom,
      dateTo,
    });

    const matchesRaw = data.matches || [];

    const defaultEntry = {
      playedGames: 1,
      goalsFor: leagueAvgGoalsPerTeam,
      goalsAgainst: leagueAvgGoalsPerTeam,
    };

    const defaultStats = buildTeamStats(defaultEntry, leagueAvgGoalsPerTeam);

    const matches = matchesRaw.map((m) => {
      const homeTeam = m.homeTeam || {};
      const awayTeam = m.awayTeam || {};

      const homeStats =
        statsByTeamId[homeTeam.id] || defaultStats;
      const awayStats =
        statsByTeamId[awayTeam.id] || defaultStats;

      const prediction = buildPoissonPrediction(
        homeStats,
        awayStats,
        leagueStats
      );

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: homeTeam.name,
        awayTeam: awayTeam.name,
        prediction,
      };
    });

    const payload = { matches };

    cache.matches[competitionId] = {
      data: payload,
      timestamp: Date.now(),
    };

    return res.json(payload);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    const status = err.status || 500;
    return res.status(status).json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
// Pornire server
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
