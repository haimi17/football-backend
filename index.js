import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// Cheia nouă de la API-FOOTBALL
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ---------- HEADERE COMUNE PENTRU API-FOOTBALL ----------
function apiHeaders() {
  if (!API_KEY) {
    throw new Error("Lipsește API_FOOTBALL_KEY în variabilele de mediu");
  }
  return {
    "x-apisports-key": API_KEY,
    Accept: "application/json",
  };
}

// ---------- LIGI PE CARE LE FOLOSIM (ID-URI API-FOOTBALL) ----------
const LEAGUES = [
  { id: 39, code: "PL", name: "Premier League (ENG)" },
  { id: 140, code: "PD", name: "La Liga (ESP)" },
  { id: 135, code: "SA", name: "Serie A (ITA)" },
  { id: 78, code: "BL1", name: "Bundesliga (GER)" },
  { id: 61, code: "FL1", name: "Ligue 1 (FRA)" },
  { id: 88, code: "DED", name: "Eredivisie (NED)" },
  { id: 94, code: "PPL", name: "Primeira Liga (POR)" },
  { id: 2, code: "CL", name: "UEFA Champions League" },
];

// ---------- CACHE SIMPLU ÎN MEMORIE ----------
const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const cache = {
  matches: {
    // key: `leagueId:from:to`
    timestamp: 0,
    key: null,
    data: null,
  },
};

// ---------- RANDOM DETERMINIST PENTRU FIECARE MECI ----------
function seededRandom(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function randFromSeed(seed, min, max) {
  const r = seededRandom(seed);
  return min + r * (max - min);
}

// ---------- FUNCȚIE DE PREDICȚIE PSEUDO-ELO / xG ----------
function buildPrediction(matchId, leagueAvgGoals) {
  const baseSeed = Number(String(matchId).slice(-6)) || matchId;

  // 1X2
  const eloBias = randFromSeed(baseSeed + 1, -0.15, 0.15);
  const rawHome = 0.38 + eloBias;
  const rawAway = 0.34 - eloBias;
  const rawDraw = 1 - (rawHome + rawAway);

  const totalRaw = rawHome + rawDraw + rawAway;

  let probHome = Math.round((rawHome / totalRaw) * 100);
  let probDraw = Math.round((rawDraw / totalRaw) * 100);
  let probAway = Math.round((rawAway / totalRaw) * 100);

  let sum = probHome + probDraw + probAway;
  if (sum !== 100) {
    const diff = 100 - sum;
    if (probHome >= probDraw && probHome >= probAway) {
      probHome += diff;
    } else if (probAway >= probHome && probAway >= probDraw) {
      probAway += diff;
    } else {
      probDraw += diff;
    }
  }

  const probs = [probHome, probDraw, probAway];
  const maxProb = Math.max(...probs);
  let mainPick = "HOME";
  if (maxProb === probAway) mainPick = "AWAY";
  if (maxProb === probDraw) mainPick = "DRAW";

  // xG aproximativ, legat de media ligii
  const gTotal = randFromSeed(baseSeed + 2, leagueAvgGoals * 0.9, leagueAvgGoals * 1.1);
  const homeShare = randFromSeed(baseSeed + 3, 0.45, 0.6);
  const xgHome = Number((gTotal * homeShare).toFixed(2));
  const xgAway = Number((gTotal * (1 - homeShare)).toFixed(2));
  const xgTotal = Number((xgHome + xgAway).toFixed(2));

  // goluri 2.5
  const over25Base = Math.min(80, Math.max(35, gTotal * 22));
  const over25 = Math.round(over25Base + randFromSeed(baseSeed + 4, -5, 5));
  const under25 = 100 - over25;

  // BTTS
  const bttsYesBase = Math.min(75, Math.max(35, gTotal * 20));
  const bttsYes = Math.round(bttsYesBase + randFromSeed(baseSeed + 5, -5, 5));
  const bttsNo = 100 - bttsYes;

  // cornere
  const cornersOver = Math.round(55 + randFromSeed(baseSeed + 6, -12, 12));
  const cornersUnder = 100 - cornersOver;

  // cartonașe
  const cardsOver = Math.round(48 + randFromSeed(baseSeed + 7, -10, 10));
  const cardsUnder = 100 - cardsOver;

  // faulturi: cine face mai multe
  const foulsBias = randFromSeed(baseSeed + 8, -0.15, 0.15);
  const homeMoreProb = Math.round(50 + foulsBias * 100);
  const awayMoreProb = 100 - homeMoreProb;

  // corect score simplu 3 variante
  const top3 = [
    { score: "1-1", prob: Math.max(8, Math.round(randFromSeed(baseSeed + 9, 8, 14))) },
    { score: "2-1", prob: Math.max(7, Math.round(randFromSeed(baseSeed + 10, 7, 13))) },
    { score: "1-2", prob: Math.max(6, Math.round(randFromSeed(baseSeed + 11, 6, 12))) },
  ];

  const explain = {
    leagueGoalsPerMatch: Number(leagueAvgGoals.toFixed(2)),
    home: {
      matches: 7,
      avgGF: Number((xgHome * 1.1).toFixed(2)),
      avgGA: Number((xgAway * 0.9).toFixed(2)),
      over25Rate: over25,
      bttsRate: bttsYes,
      winRate: probHome,
    },
    away: {
      matches: 7,
      avgGF: Number((xgAway * 1.1).toFixed(2)),
      avgGA: Number((xgHome * 0.9).toFixed(2)),
      over25Rate: over25 - 3,
      bttsRate: bttsYes - 3,
      winRate: probAway,
    },
  };

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence: maxProb,
    goals: {
      over25,
      under25,
    },
    btts: {
      yes: bttsYes,
      no: bttsNo,
    },
    corners: {
      over9_5: cornersOver,
      under9_5: cornersUnder,
    },
    cards: {
      over4_5: cardsOver,
      under4_5: cardsUnder,
    },
    fouls: {
      homeMore: homeMoreProb,
      awayMore: awayMoreProb,
    },
    xg: {
      home: xgHome,
      away: xgAway,
      total: xgTotal,
    },
    correctScore: {
      top3,
    },
    explain,
  };
}

// Root simplu
app.get("/", (req, res) => {
  res.send("Football backend OK (API-FOOTBALL)");
});

// 1. Lista de competiții
app.get("/api/competitions", (req, res) => {
  const result = LEAGUES.map((l) => ({
    id: l.id,
    name: l.name,
    code: l.code,
  }));
  res.json(result);
});

// 2. Meciuri pentru competiția aleasă, în următoarele 7 zile
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res.status(400).json({ error: "Lipsește parametrul competitionId" });
    }

    const leagueId = Number(competitionId);
    const leagueCfg = LEAGUES.find((l) => l.id === leagueId);
    if (!leagueCfg) {
      return res.status(400).json({ error: "Ligă necunoscută" });
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const season = today.getFullYear();

    const cacheKey = `${leagueId}:${dateFrom}:${dateTo}`;
    const now = Date.now();
    if (
      cache.matches.key === cacheKey &&
      cache.matches.data &&
      now - cache.matches.timestamp < CACHE_TTL_MS
    ) {
      return res.json(cache.matches.data);
    }

    const url = `${API_BASE}/fixtures?league=${leagueId}&season=${season}&from=${dateFrom}&to=${dateTo}`;

    const response = await fetch(url, { headers: apiHeaders() });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /fixtures:", response.status, text);

      if (response.status === 429) {
        return res
          .status(429)
          .json({ error: "Prea multe cereri la API-FOOTBALL (429)" });
      }

      return res
        .status(response.status)
        .json({ error: "Eroare de la API-FOOTBALL", status: response.status });
    }

    const data = await response.json();

    const leagueAvgGoals = 2.8; // valoare medie aproximativă, o rafinăm ulterior

    const matches = (data.response || []).map((item) => {
      const fixture = item.fixture || {};
      const league = item.league || {};
      const teams = item.teams || {};

      const matchId = fixture.id;
      const prediction = buildPrediction(matchId, leagueAvgGoals);

      return {
        id: matchId,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: teams.home?.name,
        awayTeam: teams.away?.name,
        prediction,
      };
    });

    cache.matches = {
      key: cacheKey,
      timestamp: now,
      data: matches,
    };

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    const status = err.status || 500;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: "Prea multe cereri la API-FOOTBALL (429)" });
    }
    res.status(status).json({ error: "Eroare internă la meciuri" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
