import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// ---------- CACHE SIMPLU ----------
const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const competitionsCache = {
  timestamp: 0,
  data: null,
};

const matchesCache = {}; // cheie: competitionId -> { timestamp, data }

// ---------- HELPERI RANDOM / HASH ----------

function pseudoRandomFromString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) % 1000000007;
  }
  return (h % 10000) / 10000; // 0..1
}

function pct(x) {
  return Math.round(x * 100);
}

// ---------- MODEL BAZĂ (goluri, BTTS, etc) ----------

function generateBasePrediction(match) {
  const key = `${match.homeTeam?.name || ""}-${match.awayTeam?.name || ""}-${
    match.utcDate || ""
  }`;

  const r1 = pseudoRandomFromString(key + "h");
  const r2 = pseudoRandomFromString(key + "d");
  const r3 = pseudoRandomFromString(key + "a");

  const rawHome = 0.35 + 0.25 * r1;
  const rawAway = 0.25 + 0.25 * r2;
  let rawDraw = 1 - (rawHome + rawAway);

  if (rawDraw < 0.15) rawDraw = 0.15;
  if (rawDraw > 0.35) rawDraw = 0.35;

  const sum = rawHome + rawDraw + rawAway;
  const pHome = rawHome / sum;
  const pDraw = rawDraw / sum;
  const pAway = rawAway / sum;

  const probHome = pct(pHome);
  const probDraw = pct(pDraw);
  const probAway = pct(pAway);

  const arr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...arr);
  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  const gSeed = pseudoRandomFromString(key + "goals");
  const over25 = 45 + Math.round(gSeed * 35);
  const under25 = 100 - over25;

  const bttsSeed = pseudoRandomFromString(key + "btts");
  const bttsYes = 40 + Math.round(bttsSeed * 40);
  const bttsNo = 100 - bttsYes;

  const cSeed = pseudoRandomFromString(key + "corners");
  const cornersOver = 40 + Math.round(cSeed * 40);
  const cornersUnder = 100 - cornersOver;

  const cardsSeed = pseudoRandomFromString(key + "cards");
  const cardsOver = 40 + Math.round(cardsSeed * 40);
  const cardsUnder = 100 - cardsOver;

  const xgHome = 0.9 + 1.4 * r1;
  const xgAway = 0.7 + 1.3 * r3;

  const confidence = maxProb;

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
    corners: {
      over9_5: cornersOver,
      under9_5: cornersUnder,
    },
    cards: {
      over4_5: cardsOver,
      under4_5: cardsUnder,
    },
    xg: {
      home: Number(xgHome.toFixed(2)),
      away: Number(xgAway.toFixed(2)),
      total: Number((xgHome + xgAway).toFixed(2)),
    },
  };
}

// ---------- MODEL ELO FOARTE SIMPLU ----------

function computeEloPrediction(match) {
  const key = `${match.homeTeam?.name || ""}-${match.awayTeam?.name || ""}-${
    match.utcDate || ""
  }`;

  const eloSeed = pseudoRandomFromString(key + "elo");
  const diff = eloSeed * 0.6 - 0.3; // -0.3..+0.3

  let baseHome = 0.45 + diff;
  let baseAway = 0.30 - diff;
  let baseDraw = 1 - (baseHome + baseAway);

  if (baseDraw < 0.18) baseDraw = 0.18;
  if (baseDraw > 0.32) baseDraw = 0.32;

  const sum = baseHome + baseDraw + baseAway;
  baseHome /= sum;
  baseDraw /= sum;
  baseAway /= sum;

  const probHome = pct(baseHome);
  const probDraw = pct(baseDraw);
  const probAway = pct(baseAway);

  const arr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...arr);
  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  const confidence = maxProb;

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence,
  };
}

// ---------- ROOT ----------

app.get("/", (req, res) => {
  res.send("Football backend OK (with backtest)");
});

// ---------- COMPETIȚII ----------

app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const now = Date.now();
    if (
      competitionsCache.data &&
      now - competitionsCache.timestamp < CACHE_TTL_MS
    ) {
      return res.json(competitionsCache.data);
    }

    const response = await fetch(`${API_BASE}/competitions`, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /competitions:", response.status, text);
      return res
        .status(response.status)
        .json({ error: "Eroare de la football-data.org", status: response.status });
    }

    const data = await response.json();

    const allowedCodes = ["CL", "PL", "PD", "SA", "BL1", "FL1", "DED", "PPL"];
    const filtered = (data.competitions || []).filter((c) =>
      allowedCodes.includes(c.code)
    );

    competitionsCache.timestamp = now;
    competitionsCache.data = filtered;

    res.json(filtered);
  } catch (err) {
    console.error("Eroare server /api/competitions:", err);
    res.status(500).json({ error: "Eroare internă server competiții" });
  }
});

// ---------- MECIURI LIVE (următoarele 7 zile) ----------

app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res
        .status(400)
        .json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const now = Date.now();
    const cacheKey = String(competitionId);
    const existing = matchesCache[cacheKey];

    if (existing && now - existing.timestamp < CACHE_TTL_MS) {
      return res.json(existing.data);
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /matches:", response.status, text);

      if (response.status === 429) {
        return res
          .status(429)
          .json({ error: "Prea multe cereri la football-data.org (429)" });
      }

      return res
        .status(response.status)
        .json({ error: "Eroare de la football-data.org", status: response.status });
    }

    const data = await response.json();

    const matches = (data.matches || []).map((m) => {
      const basePrediction = generateBasePrediction(m);
      const elo = computeEloPrediction(m);

      const combinedConfidence = Math.round(
        (basePrediction.confidence * 0.5 + elo.confidence * 0.5)
      );

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction: {
          ...basePrediction,
          eloPick: elo.mainPick,
          eloConfidence: elo.confidence,
          finalConfidence: combinedConfidence,
        },
      };
    });

    matchesCache[cacheKey] = {
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
        .json({ error: "Prea multe cereri la football-data.org (429)" });
    }

    res.status(status).json({ error: "Eroare internă la meciuri" });
  }
});

// ---------- BACKTEST: MECIURI JUCATE ----------

app.get("/api/backtest", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    let days = Number(req.query.days || 30);

    if (!competitionId) {
      return res
        .status(400)
        .json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
