// index.js – backend API-FOOTBALL pentru Football Pro Analyzer
// Rulează ca modul ES (package.json are "type": "module")

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

// Verificare minimă cheie
if (!API_KEY) {
  console.error("ATENȚIE: variabila de mediu API_FOOTBALL_KEY nu este setată!");
}

const API_BASE = "https://v3.football.api-sports.io";

// sezonul curent (ex: 2025)
const CURRENT_SEASON = new Date().getFullYear();

// Ligi vizibile în frontend
const COMPETITIONS = [
  { id: 39, code: "PL",  name: "Premier League", country: "England",  apiLeagueId: 39,  season: CURRENT_SEASON },
  { id: 135, code: "SA", name: "Serie A",        country: "Italy",    apiLeagueId: 135, season: CURRENT_SEASON },
  { id: 140, code: "PD", name: "La Liga",        country: "Spain",    apiLeagueId: 140, season: CURRENT_SEASON },
  { id: 61,  code: "L1", name: "Ligue 1",        country: "France",   apiLeagueId: 61,  season: CURRENT_SEASON },
  { id: 78,  code: "BL1",name: "Bundesliga",     country: "Germany",  apiLeagueId: 78,  season: CURRENT_SEASON },
  { id: 88,  code: "DED",name: "Eredivisie",     country: "Netherlands", apiLeagueId: 88, season: CURRENT_SEASON },
  { id: 283, code: "RO1",name: "Superliga",      country: "Romania",  apiLeagueId: 283, season: CURRENT_SEASON },
  { id: 284, code: "RO2",name: "Liga 2",         country: "Romania",  apiLeagueId: 284, season: CURRENT_SEASON }
];

// Helper pentru apeluri la API-FOOTBALL
async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    headers: { "x-apisports-key": API_KEY }
  });

  if (!res.ok) {
    throw new Error(`API-FOOTBALL HTTP ${res.status}`);
  }

  const json = await res.json();
  return json;
}

// Funcții Poisson simple

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPMF(lambda, k) {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

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

      const totalGoals = h + a;
      if (totalGoals >= 3) probOver25 += p;
      if (h > 0 && a > 0) probBTTS += p;
    }
  }

  const sum1X2 = probHomeWin + probDraw + probAwayWin || 1;
  probHomeWin /= sum1X2;
  probDraw    /= sum1X2;
  probAwayWin /= sum1X2;

  const mainPick =
    probHomeWin >= probDraw && probHomeWin >= probAwayWin
      ? "HOME"
      : probAwayWin >= probDraw
      ? "AWAY"
      : "DRAW";

  const confidence = Math.max(probHomeWin, probDraw, probAwayWin) * 100;

  return {
    probHome: Math.round(probHomeWin * 100),
    probDraw: Math.round(probDraw * 100),
    probAway: Math.round(probAwayWin * 100),
    mainPick,
    confidence: Math.round(confidence),
    goals: {
      over25: Math.round(probOver25 * 100),
      under25: Math.round((1 - probOver25) * 100)
    },
    btts: {
      yes: Math.round(probBTTS * 100),
      no: Math.round((1 - probBTTS) * 100)
    },
    lambdas: {
      home: Number.isFinite(lambdaHome) ? Number(lambdaHome.toFixed(2)) : 0,
      away: Number.isFinite(lambdaAway) ? Number(lambdaAway.toFixed(2)) : 0
    }
  };
}

// Stats echipe (forme simplificate pe ultimele 10 meciuri)

async function getTeamStats(teamId, leagueId, season) {
  try {
    const json = await apiFetch("/teams/statistics", {
      team: teamId,
      league: leagueId,
      season
    });

    const s = json.response;
    if (!s) {
      return {
        goalsFor: 1.3,
        goalsAgainst: 1.3,
        matchCount: 10
      };
    }

    const played =
      s.fixtures?.played?.total ??
      s.fixtures?.played?.home ??
      10;

    const gf = s.goals?.for?.average?.total ?? 1.3;
    const ga = s.goals?.against?.average?.total ?? 1.3;

    return {
      goalsFor: gf,
      goalsAgainst: ga,
      matchCount: played
    };
  } catch (e) {
    console.error("Eroare la getTeamStats:", e.message);
    return {
      goalsFor: 1.3,
      goalsAgainst: 1.3,
      matchCount: 10
    };
  }
}

// ------------------ Rute ------------------

// test cheie
app.get("/api/key", (req, res) => {
  if (API_KEY) {
    res.json({ ok: true, message: "Cheie OK" });
  } else {
    res.json({ ok: false, message: "Cheia NU este setată pe server" });
  }
});

// listează competițiile configurate
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
  const { competitionId } = req.query;

  const comp = COMPETITIONS.find(
    (c) => c.id === Number(competitionId)
  );

  if (!comp) {
    return res.json({
      matches: [],
      apiErrors: ["Competiție necunoscută în backend"]
    });
  }

  const today = new Date();
  const from = today.toISOString().slice(0, 10);

  const toDate = new Date(today.getTime() + 21 * 24 * 60 * 60 * 1000);
  const to = toDate.toISOString().slice(0, 10);

  const apiErrors = [];

  try {
    const json = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from,
      to,
      timezone: "Europe/Bucharest"
    });

    const fixtures = Array.isArray(json.response) ? json.response : [];

    if (json.errors && Object.keys(json.errors).length > 0) {
      Object.values(json.errors).forEach((e) =>
        apiErrors.push(String(e))
      );
    }

    const matches = [];

    for (const fx of fixtures) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = await getTeamStats(
        homeId,
        comp.apiLeagueId,
        comp.season
      );
      const awayStats = await getTeamStats(
        awayId,
        comp.apiLeagueId,
        comp.season
      );

      // lambdas simple din medii de goluri
      let lambdaHome =
        (homeStats.goalsFor + awayStats.goalsAgainst) / 2;
      let lambdaAway =
        (awayStats.goalsFor + homeStats.goalsAgainst) / 2;

      // mic avantaj teren propriu
      lambdaHome *= 1.1;

      const prediction = buildPredictionFromLambdas(
        lambdaHome,
        lambdaAway
      );

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name ?? comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction
      });
    }

    res.json({ matches, apiErrors });
  } catch (e) {
    console.error("Eroare la /api/matches:", e);
    apiErrors.push("Eroare la meciuri: " + e.message);
    res.json({ matches: [], apiErrors });
  }
});

// pornire server
app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT}`);
});
