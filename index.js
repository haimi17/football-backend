// index.js – backend „profi” cu calibrare pe ligă (API-FOOTBALL PRO)

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ---------------- Utils de timp / sezon ----------------

function getCurrentSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1–12
  // Sezon european începe vara
  return month >= 7 ? year : year - 1;
}

// Interval de căutare meciuri: azi + următoarele 5 zile
function getFixtureWindow() {
  const today = new Date();
  const from = today.toISOString().split("T")[0];

  const toDate = new Date(today.getTime() + 5 * 24 * 60 * 60 * 1000);
  const to = toDate.toISOString().split("T")[0];

  return { from, to };
}

// ------------ Config competiții (inclus Superliga + Liga 2) ------------

const SEASON = getCurrentSeason();

const COMPETITIONS = [
  { id: 2021, apiLeagueId: 39,  code: "PL",  name: "Premier League",        country: "England",   season: SEASON },
  { id: 2019, apiLeagueId: 135, code: "SA",  name: "Serie A",               country: "Italy",     season: SEASON },
  { id: 2014, apiLeagueId: 140, code: "PD",  name: "La Liga",               country: "Spain",     season: SEASON },
  { id: 2002, apiLeagueId: 78,  code: "BL1", name: "Bundesliga",            country: "Germany",   season: SEASON },
  { id: 2015, apiLeagueId: 61,  code: "FL1", name: "Ligue 1",               country: "France",    season: SEASON },
  { id: 2001, apiLeagueId: 2,   code: "CL",  name: "UEFA Champions League", country: "Europe",    season: SEASON },
  { id: 2003, apiLeagueId: 88,  code: "DED", name: "Eredivisie",            country: "Netherlands", season: SEASON },
  { id: 2017, apiLeagueId: 94,  code: "PPL", name: "Primeira Liga",         country: "Portugal",  season: SEASON },

  // România
  { id: 3001, apiLeagueId: 283, code: "RO1", name: "Superliga",             country: "Romania",   season: SEASON },
  { id: 3002, apiLeagueId: 284, code: "RO2", name: "Liga 2",                country: "Romania",   season: SEASON }
];

// --------- Calibrare pe ligă (home edge, număr goluri, BTTS) ---------

const DEFAULT_CALIB = {
  homeEdge: 0.05,     // avantaj mediu acasă
  goalsFactor: 1.0,   // multiplicator pe lambda goluri
  bttsBias: 0.0       // mică ajustare pe BTTS
};

const LEAGUE_CALIBRATION = {
  PL:   { homeEdge: 0.06, goalsFactor: 1.03, bttsBias: 0.02 },
  SA:   { homeEdge: 0.05, goalsFactor: 0.98, bttsBias: -0.01 },
  PD:   { homeEdge: 0.05, goalsFactor: 0.97, bttsBias: -0.02 },
  BL1:  { homeEdge: 0.07, goalsFactor: 1.06, bttsBias: 0.03 },
  FL1:  { homeEdge: 0.05, goalsFactor: 0.95, bttsBias: -0.01 },
  CL:   { homeEdge: 0.04, goalsFactor: 1.02, bttsBias: 0.01 },
  DED:  { homeEdge: 0.05, goalsFactor: 1.07, bttsBias: 0.03 },
  PPL:  { homeEdge: 0.04, goalsFactor: 0.96, bttsBias: -0.01 },
  RO1:  { homeEdge: 0.08, goalsFactor: 0.93, bttsBias: -0.03 }, // Superliga mai strânsă, home important
  RO2:  { homeEdge: 0.09, goalsFactor: 0.90, bttsBias: -0.04 }  // Liga 2 și mai strânsă, goluri mai puține
};

// ---------------- Helper pentru apel la API-FOOTBALL ----------------

async function apiFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.append(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const data = await res.json();

  if (!res.ok || data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(
      `Eroare API-FOOTBALL la ${path}: ` +
      JSON.stringify({ status: res.status, errors: data.errors || data.error })
    );
  }

  return data;
}

// ---------------- Poisson helpers ----------------

function poissonPmf(lambda, k) {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function factorial(n) {
  if (n < 0) return 1;
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poissonDistribution(lambda, maxGoals = 6) {
  const probs = [];
  let sum = 0;
  for (let k = 0; k <= maxGoals; k++) {
    const p = poissonPmf(lambda, k);
    probs.push(p);
    sum += p;
  }
  if (sum < 0.999) {
    // pune restul pe „>maxGoals”
    probs.push(1 - sum);
  } else {
    probs.push(0);
  }
  return probs;
}

// Din două distribuții Poisson (home, away) derivăm 1X2, O/U, BTTS
function deriveProbabilities(lambdaHome, lambdaAway) {
  const maxGoals = 6;
  const homeDist = poissonDistribution(lambdaHome, maxGoals);
  const awayDist = poissonDistribution(lambdaAway, maxGoals);

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pBTTS = 0;
  let pUnder25 = 0;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = homeDist[h] * awayDist[a];
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      const total = h + a;
      if (total < 3) pUnder25 += p;
      if (h > 0 && a > 0) pBTTS += p;
    }
  }

  const pOver25 = 1 - pUnder25;

  // Convertim în procente
  const toPct = (x) => Math.round(x * 100);

  return {
    probHome: toPct(pHome),
    probDraw: toPct(pDraw),
    probAway: toPct(pAway),
    goals: {
      over25: toPct(pOver25),
      under25: toPct(pUnder25)
    },
    btts: {
      yes: toPct(pBTTS),
      no: toPct(1 - pBTTS)
    }
  };
}

// ---------------- API routes ----------------

// Test cheie
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "Cheie lipsă" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// Lista competiții
app.get("/api/competitions", (req, res) => {
  const out = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country,
    season: c.season
  }));
  res.json(out);
});

// Meciuri + predicții
app.get("/api/matches", async (req, res) => {
  try {
    const id = Number(req.query.competitionId);
    if (!id) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === id);
    if (!comp) {
      return res.status(404).json({ error: "Competiție necunoscută" });
    }

    const calib = LEAGUE_CALIBRATION[comp.code] || DEFAULT_CALIB;
    const { from, to } = getFixtureWindow();

    // Fixtures viitoare
   const fixtures = await apiFetch("/fixtures", {
  league: comp.apiLeagueId,
  season: comp.season,
  from: fromStr,
  to: toStr
});

// nu mai filtrăm după status, lăsăm toate meciurile din intervalul de date
const upcoming = fixtures;

    const matchesOut = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;
      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      // Statistici echipe, acasă / deplasare
      // Statistici echipe, acasă / deplasare
      const [homeStatsRaw, awayStatsRaw] = await Promise.all([
        apiFetch("/teams/statistics", {
          league: comp.apiLeagueId,
          season: comp.season,
          team: homeId
        }),
        apiFetch("/teams/statistics", {
          league: comp.apiLeagueId,
          season: comp.season,
          team: awayId
        })
      ]);

      const homeStats = homeStatsRaw.response || {};
      const awayStats = awayStatsRaw.response || {};

      // Medii goluri (conversie la număr)
      const homeGF = parseFloat(homeStats.goals?.for?.average?.home) || 1;
      const homeGA = parseFloat(homeStats.goals?.against?.average?.home) || 1;
      const awayGF = parseFloat(awayStats.goals?.for?.average?.away) || 1;
      const awayGA = parseFloat(awayStats.goals?.against?.average?.away) || 1;

      // Lambda brute
      let lambdaHome = (homeGF + awayGA) / 2;
      let lambdaAway = (awayGF + homeGA) / 2;

      // Aplicăm calibrarea pe ligă
      const total = lambdaHome + lambdaAway || 1;
      lambdaHome = (lambdaHome / total) * total * calib.goalsFactor;
      lambdaAway = (lambdaAway / total) * total * calib.goalsFactor;

      // Home edge: mutăm puțin masa spre gazde
      lambdaHome *= 1 + calib.homeEdge;
      lambdaAway *= 1 - calib.homeEdge;

      // Bază Poisson
      const base = deriveProbabilities(lambdaHome, lambdaAway);

      // Ajustare ușoară BTTS pe ligă
      const bttsYes = Math.min(
        100,
        Math.max(0, base.btts.yes + Math.round(calib.bttsBias * 100))
      );
      const bttsNo = 100 - bttsYes;

      let { probHome, probDraw, probAway } = base;

      // Normalizare (în caz de rotunjiri)
      const sum1x2 = probHome + probDraw + probAway;
      if (sum1x2 !== 100 && sum1x2 > 0) {
        probHome = Math.round((probHome / sum1x2) * 100);
        probDraw = Math.round((probDraw / sum1x2) * 100);
        probAway = 100 - probHome - probDraw;
      }

      // Alegem recomandarea
      const arr = [
        { key: "HOME", val: probHome },
        { key: "DRAW", val: probDraw },
        { key: "AWAY", val: probAway }
      ].sort((a, b) => b.val - a.val);

      const best = arr[0];
      const second = arr[1];

      // Încredere: diferența între primele două + bonus dacă total xG este decent
      const totalXg = lambdaHome + lambdaAway;
      let confidence = best.val - second.val;

      if (totalXg >= 2.2 && totalXg <= 3.2) {
        confidence += 5;
      } else if (totalXg < 1.8 || totalXg > 3.6) {
        confidence -= 5;
      }

      confidence = Math.max(0, Math.min(100, confidence));

      matchesOut.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome,
          probDraw,
          probAway,
          mainPick: best.key,
          confidence,
          goals: {
            over25: base.goals.over25,
            under25: base.goals.under25
          },
          btts: {
            yes: bttsYes,
            no: bttsNo
          },
          lambdas: {
            home: Number(lambdaHome.toFixed(2)),
            away: Number(lambdaAway.toFixed(2))
          }
        }
      });
    }

    res.json({ matches: matchesOut });
  } catch (e) {
    console.error("Eroare la /api/matches", e.message || e);
    res.json({ matches: [] });
  }
});

// ---------------- Pornire server ----------------

app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}, sezon ${SEASON}`);
});
