import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// ---------- CACHE SIMPLU ÎN MEMORIE ----------
const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const cache = {
  competitions: {
    timestamp: 0,
    data: null,
  },
  // matches[competitionId] = { timestamp, data }
  matches: new Map(),
};

function isFresh(timestamp) {
  return Date.now() - timestamp < CACHE_TTL_MS;
}

// ---------- HELPER: REQUEST CU HEADERE + LOGARE ----------
async function apiGet(path) {
  if (!API_KEY) {
    throw new Error("FOOTBALL_DATA_KEY lipsă în backend");
  }

  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": API_KEY },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Eroare API", res.status, url, text.slice(0, 200));
    const err = new Error(`API error ${res.status}`);
    // punem codul HTTP pe eroare, ca să-l putem raporta
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ---------- HELPER: HASH MIC PE STRING (pt variație pe meci) ----------
function hashToUnit(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  // 0..1
  return (h >>> 0) / 4294967295;
}

// ---------- HELPER: GENERARE PREDICȚIE PE MECI ----------
function generatePrediction(matchIndex, match) {
  const homeName = match.homeTeam?.name || "HOME";
  const awayName = match.awayTeam?.name || "AWAY";
  const key = `${homeName}-${awayName}-${matchIndex}`;

  // 1) "forță" echipe: pseudo-ELO din nume + un pic de variație
  const baseHome = hashToUnit(homeName);
  const baseAway = hashToUnit(awayName);
  const rand = hashToUnit(key + "r");

  // scor relativ (pseudo-elo în [1400, 1900])
  const eloHome = 1400 + baseHome * 500;
  const eloAway = 1400 + baseAway * 500;

  const eloDiff = eloHome - eloAway; // >0 favorizează gazdele
  const eloFactor = Math.max(-250, Math.min(250, eloDiff)); // tăiem extremele

  // 2) transformăm eloDiff într-o probabilitate 1X2
  // logistic simplu
  const homeBase = 0.33 + (eloFactor / 500) * 0.25; // ~0.08..0.58
  const awayBase = 0.33 - (eloFactor / 500) * 0.25;
  const drawBase = 1 - (homeBase + awayBase);

  // noise mic pe meci, ca să nu fie două meciuri identice
  const noiseHome = (rand - 0.5) * 0.1;
  const noiseAway = (hashToUnit(key + "a") - 0.5) * 0.1;
  const noiseDraw = (hashToUnit(key + "d") - 0.5) * 0.1;

  let pHome = homeBase + noiseHome;
  let pAway = awayBase + noiseAway;
  let pDraw = drawBase + noiseDraw;

  // nu lăsăm valori negative
  pHome = Math.max(0.05, pHome);
  pAway = Math.max(0.05, pAway);
  pDraw = Math.max(0.05, pDraw);

  const totalProb = pHome + pAway + pDraw;
  pHome /= totalProb;
  pDraw /= totalProb;
  pAway /= totalProb;

  let probHome = Math.round(pHome * 100);
  let probDraw = Math.round(pDraw * 100);
  let probAway = Math.round(pAway * 100);

  // ajustăm la 100%
  let sum = probHome + probDraw + probAway;
  if (sum !== 100) {
    const diff = 100 - sum;
    if (probHome >= probDraw && probHome >= probAway) probHome += diff;
    else if (probAway >= probHome && probAway >= probDraw) probAway += diff;
    else probDraw += diff;
  }

  // 3) Goluri: depind de "forța" totală + stil ligă (folosim doar pseudo)
  const attackFactor =
    (hashToUnit(key + "g1") + hashToUnit(key + "g2") + baseHome + baseAway) /
    4; // 0..1

  const totalXg = 2.0 + attackFactor * 1.2; // între ~2.0 și 3.2
  const homeXg = totalXg * (0.45 + (eloFactor / 500) * 0.1); // mai multe șanse pentru echipa mai bună
  const awayXg = Math.max(0.4, totalXg - homeXg);

  // probabilități aproximative din total xG
  const over25Base = Math.min(0.8, 0.35 + (totalXg - 2) * 0.35); // crește cu totalXg
  const bttsBase = Math.min(
    0.8,
    0.3 + Math.min(homeXg, awayXg) * 0.25
  ); // dacă ambele xG sunt decente, crește BTTS

  // un pic de variație per meci
  const overNoise = (hashToUnit(key + "ov") - 0.5) * 0.08;
  const bttsNoise = (hashToUnit(key + "bt") - 0.5) * 0.08;

  let over25 = over25Base + overNoise;
  let bttsYes = bttsBase + bttsNoise;

  over25 = Math.min(0.9, Math.max(0.3, over25));
  bttsYes = Math.min(0.85, Math.max(0.25, bttsYes));

  const under25 = 1 - over25;
  const bttsNo = 1 - bttsYes;

  // 4) Cornere / Cartonașe / Faulturi – stilistic, dar diferite pe meci
  const cornersOver = 0.55 + (hashToUnit(key + "c") - 0.5) * 0.2; // 45–65%
  const cardsOver = 0.55 + (hashToUnit(key + "y") - 0.5) * 0.25; // 42–68%

  const foulsTilt = hashToUnit(key + "f"); // spre cine merg faulturile
  const foulsHomeMore = Math.round(40 + foulsTilt * 20); // 40–60
  const foulsAwayMore = 100 - foulsHomeMore;

  // 5) alegerea principală + "încredere"
  const arr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...arr);
  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  const confidence = maxProb; // 0–100, folosit de filtrul tău ≥ 80%

  // pentru viitor, poți folosi și xG/correctScore în UI
  const correctScoreTop3 = [
    { score: "1-1", prob: Math.round(10 + hashToUnit(key + "cs1") * 8) },
    { score: "2-1", prob: Math.round(8 + hashToUnit(key + "cs2") * 7) },
    { score: "1-2", prob: Math.round(6 + hashToUnit(key + "cs3") * 6) },
  ];

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence,
    goals: {
      over25: Math.round(over25 * 100),
      under25: Math.round(under25 * 100),
      bttsYes: Math.round(bttsYes * 100),
      bttsNo: Math.round(bttsNo * 100),
    },
    xg: {
      home: Number(homeXg.toFixed(2)),
      away: Number(awayXg.toFixed(2)),
      total: Number(totalXg.toFixed(2)),
    },
    correctScore: {
      top3: correctScoreTop3,
    },
    corners: {
      over9_5: Math.round(cornersOver * 100),
      under9_5: Math.round((1 - cornersOver) * 100),
    },
    cards: {
      over4_5: Math.round(cardsOver * 100),
      under4_5: Math.round((1 - cardsOver) * 100),
    },
    fouls: {
      homeMore: foulsHomeMore,
      awayMore: foulsAwayMore,
    },
  };
}

// ---------- ROOT SIMPLU ----------
app.get("/", (req, res) => {
  res.send("Football backend OK (cache + ELO-like model)");
});

// ---------- 1. COMPETIȚII CU CACHE ----------
app.get("/api/competitions", async (req, res) => {
  try {
    // folosim cache dacă e proaspăt
    if (cache.competitions.data && isFresh(cache.competitions.timestamp)) {
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
    console.error("Eroare server /api/competitions:", err.message);
    const status = err.status || 500;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: "Prea multe cereri la football-data.org (429)" });
    }
    res.status(status).json({ error: "Eroare internă la competiții" });
  }
});

// ---------- 2. MECIURI CU CACHE + PREDICȚII ----------
app.get("/api/matches", async (req, res) => {
  try {
  try
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res.status(400).json({ error: "Lipsește parametrul competitionId" });
    }

    // cache pe competiție
    const cached = cache.matches.get(competitionId);
    if (cached && isFresh(cached.timestamp)) {
      return res.json(cached.data);
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const path = `/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const data = await apiGet(path);

    const matches = (data.matches || []).map((m, idx) => {
      const prediction = generatePrediction(idx, m);

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction,
      };
    });

    cache.matches.set(competitionId, {
      timestamp: Date.now(),
      data: matches,
    });

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err.message);
    const status = err.status || 500;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: "Prea multe cereri la football-data.org (429)" });
    }
    res.status(status).json({ error: "Eroare internă la meciuri" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
