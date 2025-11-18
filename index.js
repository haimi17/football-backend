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

// Ligile folosite de frontend
// apiLeagueId + season vin direct din API-FOOTBALL (ex: sezon 2024 = 2024/2025)
const COMPETITIONS = [
  { id: 39, code: "PL",  name: "Premier League", country: "England",   apiLeagueId: 39,  season: 2024 },
  { id: 135, code: "SA", name: "Serie A",        country: "Italy",     apiLeagueId: 135, season: 2024 },
  { id: 140, code: "PD", name: "La Liga",        country: "Spain",     apiLeagueId: 140, season: 2024 },
  { id: 61,  code: "L1", name: "Ligue 1",        country: "France",    apiLeagueId: 61,  season: 2024 },
  { id: 78,  code: "BL1",name: "Bundesliga",     country: "Germany",   apiLeagueId: 78,  season: 2024 },
  { id: 88,  code: "DED",name: "Eredivisie",     country: "Netherlands", apiLeagueId: 88, season: 2024 },
  { id: 283, code: "RO1",name: "Superliga",      country: "Romania",   apiLeagueId: 283, season: 2024 },
  { id: 284, code: "RO2",name: "Liga 2",         country: "Romania",   apiLeagueId: 284, season: 2024 }
];

// Helper general pentru apel API-FOOTBALL
async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API status ${res.status} la ${path}: ${text}`);
  }

  const data = await res.json();
  return data;
}

// Poisson helpers pentru goluri și over/BTTS
const FACT = [1];
for (let i = 1; i <= 10; i++) {
  FACT[i] = FACT[i - 1] * i;
}
function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
}

// Predictie bazată pe clasament (standings)
function buildPredictionFromStats(homeStats, awayStats) {
  // fallback neutru
  if (!homeStats || !awayStats || !homeStats.played || !awayStats.played) {
    return {
      probHome: 34,
      probDraw: 32,
      probAway: 34,
      mainPick: "HOME",
      confidence: 34,
      goals: { over25: 50, under25: 50 },
      btts: { yes: 50, no: 50 },
      lambdas: { home: 1.3, away: 1.2 }
    };
  }

  const homeGF = homeStats.goalsFor / homeStats.played;
  const homeGA = homeStats.goalsAgainst / homeStats.played;
  const awayGF = awayStats.goalsFor / awayStats.played;
  const awayGA = awayStats.goalsAgainst / awayStats.played;

  let lambdaHome = (homeGF + awayGA) / 2;
  let lambdaAway = (awayGF + homeGA) / 2;

  // avantaj teren propriu
  lambdaHome *= 1.15;

  // limite xG
  lambdaHome = Math.min(Math.max(lambdaHome, 0.3), 3.5);
  lambdaAway = Math.min(Math.max(lambdaAway, 0.3), 3.5);

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

  let pH = probHomeWin;
  let pD = probDraw;
  let pA = probAwayWin;
  const sum = pH + pD + pA || 1;
  pH /= sum;
  pD /= sum;
  pA /= sum;

  const percHome = Math.round(pH * 100);
  const percDraw = Math.round(pD * 100);
  const percAway = Math.round(pA * 100);

  let mainPick = "HOME";
  let maxProb = pH;
  if (pD > maxProb) {
    mainPick = "DRAW";
    maxProb = pD;
  }
  if (pA > maxProb) {
    mainPick = "AWAY";
    maxProb = pA;
  }

  const over25 = Math.round(Math.min(Math.max(probOver25 * 100, 5), 95));
  const bttsYes = Math.round(Math.min(Math.max(probBTTS * 100, 5), 95));

  const confidence = Math.round(maxProb * 100);

  return {
    probHome: percHome,
    probDraw: percDraw,
    probAway: percAway,
    mainPick,
    confidence,
    goals: {
      over25,
      under25: 100 - over25
    },
    btts: {
      yes: bttsYes,
      no: 100 - bttsYes
    },
    lambdas: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    }
  };
}

// =======================================
// Rute API
// =======================================

// Test cheie
app.get("/api/key", (req, res) => {
  res.json({
    ok: !!API_KEY,
    message: API_KEY ? "Cheie OK" : "Cheie lipsă"
  });
});

// Listează ligile către frontend
app.get("/api/leagues", (req, res) => {
  const list = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country,
    apiLeagueId: c.apiLeagueId,
    season: c.season
  }));
  res.json(list);
});

// /api/matches?competitionId=39  sau ?leagueId=39
app.get("/api/matches", async (req, res) => {
  const compId = Number(req.query.competitionId || req.query.leagueId);

  const comp = COMPETITIONS.find((c) => c.id === compId);
  if (!comp) {
    return res.json({ matches: [], apiErrors: ["Competiție necunoscută"] });
  }

  try {
    // Luăm o singură dată clasamentul pentru ligă
    const standingsData = await apiFetch("/standings", {
      league: comp.apiLeagueId,
      season: comp.season
    });

    const table =
      standingsData?.response?.[0]?.league?.standings?.[0] || [];

    const teamStats = {};
    for (const row of table) {
      const teamId = row.team?.id;
      if (!teamId) continue;
      teamStats[teamId] = {
        rank: row.rank,
        played: row.all?.played ?? 0,
        goalsFor: row.all?.goals?.for ?? 0,
        goalsAgainst: row.all?.goals?.against ?? 0
      };
    }

    // Luăm următoarele meciuri (evităm problemele cu from/to)
    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      next: 50
    });

    const fixtures = fixturesData.response || [];
    const out = [];

    const now = new Date();

    for (const fx of fixtures) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const date = new Date(fixture.date);
      if (isNaN(date.getTime())) continue;
      if (date < now) continue; // doar viitoare

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const prediction = buildPredictionFromStats(
        teamStats[homeId],
        teamStats[awayId]
      );

      out.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction
      });
    }

    res.json({
      matches: out,
      apiErrors: fixturesData?.errors || []
    });
  } catch (e) {
    console.error("Eroare /api/matches:", e);
    res.json({
      matches: [],
      apiErrors: [e.message || "Eroare necunoscută"]
    });
  }
});

// Pornire server
app.listen(PORT, () => {
  console.log(`Backend pornit pe portul ${PORT}`);
});
