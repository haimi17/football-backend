import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

// =========================
// Config competiții
// =========================

const COMPETITIONS = [
  // ID-urile 2021, 2019 etc le folosim în frontend
  // leagueId este ID-ul din API-FOOTBALL
  { id: 2021, code: "PL",  name: "Premier League",       country: "England",   leagueId: 39,  season: 2024 },
  { id: 2001, code: "CL",  name: "UEFA Champions League",country: "Europe",    leagueId: 2,   season: 2024 },
  { id: 2015, code: "FL1", name: "Ligue 1",              country: "France",    leagueId: 61,  season: 2024 },
  { id: 2002, code: "BL1", name: "Bundesliga",           country: "Germany",   leagueId: 78,  season: 2024 },
  { id: 2019, code: "SA",  name: "Serie A",              country: "Italy",     leagueId: 135, season: 2024 },
  { id: 2003, code: "DED", name: "Eredivisie",           country: "Netherlands",leagueId: 88, season: 2024 },
  { id: 2017, code: "PPL", name: "Primeira Liga",        country: "Portugal",  leagueId: 94,  season: 2024 },
  { id: 2014, code: "PD",  name: "Primera Division",     country: "Spain",     leagueId: 140, season: 2024 },

  // România – dacă nu încarcă, vom ajusta leagueId după ce vezi ID-urile corecte în dashboard API-FOOTBALL
  { id: 3001, code: "RO1", name: "SuperLiga",            country: "Romania",   leagueId: 284, season: 2024 },
  { id: 3002, code: "RO2", name: "Liga 2",               country: "Romania",   leagueId: 285, season: 2024 }
];

// =========================
// Helper API
// =========================

async function apiFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error("Lipsește API_FOOTBALL_KEY în environment");
  }

  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.append(k, v);
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const data = await res.json();

  if (!res.ok || (data.errors && Object.keys(data.errors).length > 0)) {
    const err = new Error("Eroare API-FOOTBALL");
    err.status = res.status;
    err.apiErrors = data.errors || data.response || data.message;
    throw err;
  }

  return data.response;
}

// =========================
// Cache simplu în memorie
// =========================

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minute

const cache = {
  matches: {} // cheie: competitionId, valoare: { timestamp, data }
};

function getCached(key) {
  const item = cache.matches[key];
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL_MS) return null;
  return item.data;
}

function setCached(key, data) {
  cache.matches[key] = {
    timestamp: Date.now(),
    data
  };
}

// =========================
// Poisson + probabilități
// =========================

const FACT = [];
function factorial(n) {
  if (FACT[n] != null) return FACT[n];
  if (n === 0 || n === 1) return (FACT[n] = 1);
  return (FACT[n] = n * factorial(n - 1));
}

function poisson(k, lambda) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function calcProbs(lambdaHome, lambdaAway) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pOver25 = 0;
  let pUnder25 = 0;
  let pBttsYes = 0;

  const MAX_GOALS = 6;

  for (let gh = 0; gh <= MAX_GOALS; gh++) {
    const pH = poisson(gh, lambdaHome);
    for (let ga = 0; ga <= MAX_GOALS; ga++) {
      const pA = poisson(ga, lambdaAway);
      const p = pH * pA;

      if (gh > ga) pHome += p;
      else if (gh === ga) pDraw += p;
      else pAway += p;

      const total = gh + ga;
      if (total > 2) pOver25 += p;
      else pUnder25 += p;

      if (gh > 0 && ga > 0) pBttsYes += p;
    }
  }

  const sum1x2 = pHome + pDraw + pAway || 1;

  return {
    probHome: pHome / sum1x2,
    probDraw: pDraw / sum1x2,
    probAway: pAway / sum1x2,
    over25: pOver25,
    under25: pUnder25,
    bttsYes: pBttsYes,
    bttsNo: 1 - pBttsYes
  };
}

function clamp(num, min, max) {
  return Math.min(max, Math.max(min, num));
}

// =========================
// Formă echipă pe ultimele meciuri
// =========================

const teamFormCache = new Map();

async function getTeamForm(teamId, leagueId, season) {
  const key = `${teamId}-${leagueId}-${season}`;
  const cached = teamFormCache.get(key);
  if (cached && Date.now() - cached.timestamp < 10 * 60 * 1000) {
    return cached.data;
  }

  const fixtures = await apiFetch("/fixtures", {
    team: teamId,
    league: leagueId,
    season,
    last: 10
  });

  let played = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;

  for (const fx of fixtures) {
    const goals = fx.goals;
    const isHome = fx.teams.home.id === teamId;

    const gf = isHome ? goals.home : goals.away;
    const ga = isHome ? goals.away : goals.home;

    goalsFor += gf;
    goalsAgainst += ga;
    played += 1;
  }

  const data = {
    matches: played,
    avgGF: played ? goalsFor / played : 1.2,
    avgGA: played ? goalsAgainst / played : 1.2
  };

  teamFormCache.set(key, { timestamp: Date.now(), data });
  return data;
}

// =========================
// Rute API
// =========================

// Test cheie
app.get("/api/test-key", (req, res) => {
  res.json({
    ok: !!API_KEY,
    message: API_KEY ? "Cheie OK" : "Cheie lipsă"
  });
});

// Listă competiții pentru dropdown în frontend
app.get("/api/competitions", (req, res) => {
  const out = COMPETITIONS.map(({ id, code, name, country }) => ({
    id,
    code,
    name,
    country
  }));
  res.json(out);
});

// Meciuri + predicții
app.get("/api/matches", async (req, res) => {
  try {
    const competitionIdRaw = req.query.competitionId;
    if (!competitionIdRaw) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const competitionId = Number(competitionIdRaw);
    const comp = COMPETITIONS.find(c => c.id === competitionId);
    if (!comp) {
      return res.status(404).json({ error: "Competiție necunoscută" });
    }

    const cacheKey = `${competitionId}`;
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json({ matches: cached });
    }

    const today = new Date();
    const toDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    const fromStr = today.toISOString().split("T")[0];
    const toStr = toDate.toISOString().split("T")[0];

    const fixtures = await apiFetch("/fixtures", {
      league: comp.leagueId,
      season: comp.season,
      from: fromStr,
      to: toStr
    });

    const upcoming = fixtures.filter(fx => {
      const s = fx.fixture?.status?.short;
      return s === "NS" || s === "TBD" || s === "PST";
    });

    const matches = [];
    const teamFormMap = new Map();

    // Preluare formă pentru toate echipele implicate
    for (const fx of upcoming) {
      const homeId = fx.teams.home.id;
      const awayId = fx.teams.away.id;

      if (!teamFormMap.has(homeId)) {
        teamFormMap.set(
          homeId,
          await getTeamForm(homeId, comp.leagueId, comp.season)
        );
      }
      if (!teamFormMap.has(awayId)) {
        teamFormMap.set(
          awayId,
          await getTeamForm(awayId, comp.leagueId, comp.season)
        );
      }
    }

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeForm = teamFormMap.get(homeId);
      const awayForm = teamFormMap.get(awayId);

      const lambdaHome = clamp(
        0.7 * homeForm.avgGF + 0.3 * awayForm.avgGA,
        0.2,
        3.5
      );
      const lambdaAway = clamp(
        0.7 * awayForm.avgGF + 0.3 * homeForm.avgGA,
        0.2,
        3.5
      );

      const probs = calcProbs(lambdaHome, lambdaAway);

      const probs1x2 = {
        home: probs.probHome,
        draw: probs.probDraw,
        away: probs.probAway
      };

      let mainPick = "HOME";
      let maxProb = probs1x2.home;

      if (probs1x2.draw > maxProb) {
        maxProb = probs1x2.draw;
        mainPick = "DRAW";
      }
      if (probs1x2.away > maxProb) {
        maxProb = probs1x2.away;
        mainPick = "AWAY";
      }

      const matchOut = {
        id: fixture.id,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome: Math.round(probs1x2.home * 100),
          probDraw: Math.round(probs1x2.draw * 100),
          probAway: Math.round(probs1x2.away * 100),
          mainPick,
          confidence: Math.round(maxProb * 100),
          goals: {
            over25: Math.round(probs.over25 * 100),
            under25: Math.round(probs.under25 * 100),
            bttsYes: Math.round(probs.bttsYes * 100),
            bttsNo: Math.round(probs.bttsNo * 100)
          },
          xg: {
            home: Number(lambdaHome.toFixed(2)),
            away: Number(lambdaAway.toFixed(2)),
            total: Number((lambdaHome + lambdaAway).toFixed(2))
          }
        },
        explain: {
          leagueCode: comp.code,
          home: {
            matches: homeForm.matches,
            avgGF: Number(homeForm.avgGF.toFixed(2)),
            avgGA: Number(homeForm.avgGA.toFixed(2))
          },
          away: {
            matches: awayForm.matches,
            avgGF: Number(awayForm.avgGF.toFixed(2)),
            avgGA: Number(awayForm.avgGA.toFixed(2))
          }
        }
      };

      matches.push(matchOut);
    }

    setCached(cacheKey, matches);
    res.json({ matches });
  } catch (e) {
    console.error("Eroare /api/matches:", e.message, e.apiErrors || "");
    res
      .status(e.status || 500)
      .json({ error: "Eroare la meciuri", detail: e.apiErrors || e.message });
  }
});

// =========================
// Pornire server
// =========================

app.use(cors());
app.use(express.json());

app.listen(PORT, () => {
  console.log(`Backend ready pe port ${PORT}`);
});
