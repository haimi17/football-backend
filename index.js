import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// =============== UTILITARE GENERALE ===============

async function apiGet(path) {
  if (!API_KEY) {
    const err = new Error("FOOTBALL_DATA_KEY lipsă în backend");
    err.status = 500;
    throw err;
  }

  const url = `${API_BASE}${path}`;

  const res = await fetch(url, {
    headers: { "X-Auth-Token": API_KEY },
  });

  if (res.status === 429) {
    const err = new Error("Prea multe cereri la football-data.org (429)");
    err.status = 429;
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    console.error("Eroare API", res.status, text);
    const err = new Error("Eroare de la football-data.org");
    err.status = res.status;
    throw err;
  }

  return res.json();
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

// factorial precomputat pentru Poisson
const fact = [];
function initFactorials(n) {
  fact[0] = 1;
  for (let i = 1; i <= n; i++) {
    fact[i] = fact[i - 1] * i;
  }
}
initFactorials(10);

function poissonProb(lambda, k) {
  if (lambda <= 0) {
    return k === 0 ? 1 : 0;
  }
  if (k < 0 || k > 10) return 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact[k];
}

// =============== CACHE SIMPLU ===============

const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const cache = {
  competitions: { timestamp: 0, data: null },
  standingsByCompetition: {}, // id -> { timestamp, data }
  matchesByCompetition: {},   // id -> { timestamp, data }
};

function isFresh(entry) {
  if (!entry) return false;
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// =============== ROOT ===============

app.get("/", (req, res) => {
  res.send("Football backend OK (model Poisson pe goluri reale)");
});

// =============== /api/competitions ===============

app.get("/api/competitions", async (req, res) => {
  try {
    if (isFresh(cache.competitions)) {
      return res.json(cache.competitions.data);
    }

    const data = await apiGet("/competitions");

    const allowedCodes = ["CL", "PL", "PD", "SA", "BL1", "FL1", "DED", "PPL"];
    const filtered = (data.competitions || []).filter((c) =>
      allowedCodes.includes(c.code)
    );

    cache.competitions = {
      timestamp: Date.now(),
      data: filtered,
    };

    res.json(filtered);
  } catch (err) {
    console.error("Eroare /api/competitions:", err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// =============== MODEL BAZAT PE CLASAMENTE ===============

// Construiește un "map" de echipe cu medii reale de goluri
function buildTeamStatsFromStandings(standingsData) {
  const table =
    standingsData.standings?.find((s) => s.type === "TOTAL")?.table || [];

  if (!table.length) return { teams: {}, leagueAvgGoals: 2.6 };

  let sumGoalsFor = 0;
  let sumMatches = 0;

  const teams = {};

  for (const row of table) {
    const name = row.team?.name;
    const played = row.playedGames || 0;
    const gf = row.goalsFor || 0;
    const ga = row.goalsAgainst || 0;

    if (!name || played === 0) continue;

    const gfPerGame = gf / played;
    const gaPerGame = ga / played;

    teams[name] = {
      name,
      played,
      gf,
      ga,
      gfPerGame,
      gaPerGame,
    };

    sumGoalsFor += gf;
    sumMatches += played;
  }

  // medie de goluri pe echipă per meci, din ligă
  const leagueAvgGoalsPerTeam =
    sumMatches > 0 ? sumGoalsFor / sumMatches : 1.3; // ex ~1.3

  const leagueAvgGoalsPerMatch = leagueAvgGoalsPerTeam * 2; // ex ~2.6

  return { teams, leagueAvgGoalsPerMatch };
}

// calculează așteptările de goluri și probabilități folosind Poisson
function computeMatchPredictionFromTeams(
  homeName,
  awayName,
  teamsMap,
  leagueAvgGoalsPerMatch
) {
  const avgTeam = leagueAvgGoalsPerMatch / 2; // medie pe echipă

  const home = teamsMap[homeName];
  const away = teamsMap[awayName];

  // dacă nu găsim echipa în clasament, o considerăm neutră
  const homeGf = home ? home.gfPerGame : avgTeam;
  const homeGa = home ? home.gaPerGame : avgTeam;
  const awayGf = away ? away.gfPerGame : avgTeam;
  const awayGa = away ? away.gaPerGame : avgTeam;

  // forță ofensivă / defensivă relativ la medie
  const homeAttack = homeGf / avgTeam;
  const homeDefense = homeGa / avgTeam;
  const awayAttack = awayGf / avgTeam;
  const awayDefense = awayGa / avgTeam;

  // avantaj mic de teren pentru gazde
  const homeAdv = 1.1;

  const lambdaHome =
    homeAdv * homeAttack * (awayDefense > 0 ? 1 / awayDefense : 1) * avgTeam;
  const lambdaAway =
    awayAttack * (homeDefense > 0 ? 1 / homeDefense : 1) * avgTeam;

  const lamH = clamp(lambdaHome, 0.3, 3.5);
  const lamA = clamp(lambdaAway, 0.3, 3.5);

  // calculăm distribuția până la 6 goluri
  const maxGoals = 6;
  const probMatrix = [];

  let pHomeWin = 0;
  let pDraw = 0;
  let pAwayWin = 0;
  let pOver25 = 0;
  let pBttsYes = 0;

  for (let gh = 0; gh <= maxGoals; gh++) {
    const pGh = poissonProb(lamH, gh);
    for (let ga = 0; ga <= maxGoals; ga++) {
      const pGa = poissonProb(lamA, ga);
      const p = pGh * pGa;

      if (gh > ga) pHomeWin += p;
      if (gh === ga) pDraw += p;
      if (gh < ga) pAwayWin += p;

      if (gh + ga >= 3) pOver25 += p;
      if (gh >= 1 && ga >= 1) pBttsYes += p;

      probMatrix.push({ gh, ga, p });
    }
  }

  // ce iese peste 6 goluri tăiem, dar contribuția e mică

  const pUnder25 = 1 - pOver25;
  const pBttsNo = 1 - pBttsYes;

  const probHome = clamp(pHomeWin, 0, 1);
  const probDraw = clamp(pDraw, 0, 1);
  const probAway = clamp(pAwayWin, 0, 1);

  let probSum = probHome + probDraw + probAway;
  // normalizare 1X2
  if (probSum > 0) {
    pHomeWin /= probSum;
    pDraw /= probSum;
    pAwayWin /= probSum;
  }

  let ph = Math.round(pHomeWin * 100);
  let pd = Math.round(pDraw * 100);
  let pa = Math.round(pAwayWin * 100);
  let s = ph + pd + pa;
  if (s !== 100) {
    const diff = 100 - s;
    if (ph >= pd && ph >= pa) ph += diff;
    else if (pa >= ph && pa >= pd) pa += diff;
    else pd += diff;
  }

  const probs = [ph, pd, pa];
  const maxP = Math.max(...probs);
  let mainPick = "HOME";
  if (maxP === pd) mainPick = "DRAW";
  if (maxP === pa) mainPick = "AWAY";

  // scor de încredere: când diferența e mare, încredere mai mare
  const normalizedMax = maxP / 100; // 0.33–0.7+
  let confidence = 40 + Math.round((normalizedMax - 0.33) * (50 / 0.37));
  confidence = clamp(confidence, 45, 90);

  return {
    probHome: ph,
    probDraw: pd,
    probAway: pa,
    mainPick,
    confidence,
    xg: {
      home: Number(lamH.toFixed(2)),
      away: Number(lamA.toFixed(2)),
      total: Number((lamH + lamA).toFixed(2)),
    },
    goals: {
      over25: Math.round(pOver25 * 100),
      under25: Math.round(pUnder25 * 100),
      bttsYes: Math.round(pBttsYes * 100),
      bttsNo: Math.round(pBttsNo * 100),
    },
  };
}

// =============== /api/matches ===============

app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res
        .status(400)
        .json({ error: "Lipsește parametrul competitionId" });
    }

    // cache meciuri
    const cacheEntry = cache.matchesByCompetition[competitionId];
    if (cacheEntry && isFresh(cacheEntry)) {
      return res.json(cacheEntry.data);
    }

    // 1. standings (goluri reale)
    let standingsEntry = cache.standingsByCompetition[competitionId];
    if (!standingsEntry || !isFresh(standingsEntry)) {
      const standingsData = await apiGet(
        `/competitions/${competitionId}/standings`
      );
      standingsEntry = {
        timestamp: Date.now(),
        data: standingsData,
      };
      cache.standingsByCompetition[competitionId] = standingsEntry;
    }

    const { teams, leagueAvgGoalsPerMatch } = buildTeamStatsFromStandings(
      standingsEntry.data
    );

    // 2. meciurile următoare 7 zile
    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const matchesData = await apiGet(
      `/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`
    );

    const matches = (matchesData.matches || []).map((m) => {
      const homeName = m.homeTeam?.name || "Home";
      const awayName = m.awayTeam?.name || "Away";

      const prediction = computeMatchPredictionFromTeams(
        homeName,
        awayName,
        teams,
        leagueAvgGoalsPerMatch
      );

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: homeName,
        awayTeam: awayName,
        prediction,
      };
    });

    cache.matchesByCompetition[competitionId] = {
      timestamp: Date.now(),
      data: matches,
    };

    res.json(matches);
  } catch (err) {
    console.error("Eroare /api/matches:", err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// =============== START SERVER ===============

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
