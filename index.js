import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------
// Config competiții (id intern + id ligă din API-FOOTBALL + sezon)
// ---------------------------------------------------------------------
const COMPETITIONS = [
  // Anglia
  { id: 39, apiLeagueId: 39, season: 2024, code: "PL",  name: "Premier League",       country: "England" },
  // Italia
  { id: 135, apiLeagueId: 135, season: 2024, code: "SA",  name: "Serie A",             country: "Italy" },
  // Germania
  { id: 78, apiLeagueId: 78, season: 2024, code: "BL1", name: "Bundesliga",          country: "Germany" },
  // Spania
  { id: 140, apiLeagueId: 140, season: 2024, code: "PD",  name: "La Liga",             country: "Spain" },
  // Franța
  { id: 61, apiLeagueId: 61, season: 2024, code: "FL1", name: "Ligue 1",             country: "France" },
  // Olanda
  { id: 88, apiLeagueId: 88, season: 2024, code: "DED", name: "Eredivisie",          country: "Netherlands" },
  // Portugalia
  { id: 94, apiLeagueId: 94, season: 2024, code: "PPL", name: "Primeira Liga",       country: "Portugal" },
  // Champions League
  { id: 2, apiLeagueId: 2, season: 2024, code: "CL",  name: "UEFA Champions League", country: "Europe" },
  // România – Superliga și Liga 2 (id-urile sunt cele din API-FOOTBALL)
  { id: 283, apiLeagueId: 283, season: 2024, code: "RO1", name: "Superliga", country: "Romania" },
  { id: 284, apiLeagueId: 284, season: 2024, code: "RO2", name: "Liga 2",   country: "Romania" }
];

// ---------------------------------------------------------------------
// Cache simplu pentru standings și fixtures
// ---------------------------------------------------------------------
const CACHE_TTL = 10 * 60 * 1000; // 10 minute

const cache = {
  standings: {
    // [leagueId]: { timestamp, teams: { [teamId]: { homeGF, homeGA, homeP, awayGF, awayGA, awayP } } }
  },
  fixtures: {
    // [leagueId]: { [season]: { timestamp, fixtures: [...] } }
  }
};

// ---------------------------------------------------------------------
// Helper apel API-FOOTBALL
// ---------------------------------------------------------------------
async function apiFetch(path, params = {}) {
  if (!API_KEY) {
    throw new Error("Lipsă API_FOOTBALL_KEY în backend");
  }

  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      search.append(k, String(v));
    }
  }

  const url = `${API_BASE}${path}?${search.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} la ${path}: ${JSON.stringify(json.errors || json)}`);
  }

  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`Eroare API la ${path}: ${JSON.stringify(json.errors)}`);
  }

  return json.response || [];
}

// ---------------------------------------------------------------------
// Ia fixtures pentru următoarele 7 zile, cu cache
// ---------------------------------------------------------------------
async function getUpcomingFixtures(comp) {
  const leagueId = comp.apiLeagueId;
  const season = comp.season;

  const leagueCache = cache.fixtures[leagueId]?.[season];
  const now = Date.now();

  if (leagueCache && now - leagueCache.timestamp < CACHE_TTL) {
    return leagueCache.fixtures;
  }

  const today = new Date();
  const toDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000); // următoarele 7 zile

  const fromStr = today.toISOString().split("T")[0];
  const toStr = toDate.toISOString().split("T")[0];

  const fixtures = await apiFetch("/fixtures", {
    league: leagueId,
    season,
    from: fromStr,
    to: toStr
  });

  if (!cache.fixtures[leagueId]) cache.fixtures[leagueId] = {};
  cache.fixtures[leagueId][season] = {
    timestamp: now,
    fixtures
  };

  return fixtures;
}

// ---------------------------------------------------------------------
// Ia standings (home/away) și construiește map de statistici pe echipă
// ---------------------------------------------------------------------
async function getStandingsStats(comp) {
  const leagueId = comp.apiLeagueId;
  const now = Date.now();

  const existing = cache.standings[leagueId];
  if (existing && now - existing.timestamp < CACHE_TTL) {
    return existing.teams;
  }

  const resp = await apiFetch("/standings", {
    league: leagueId,
    season: comp.season
  });

  const leagueData = resp[0]?.league?.standings?.[0] || [];

  const teams = {};

  for (const row of leagueData) {
    const teamId = row.team?.id;
    if (!teamId) continue;

    const home = row.home || {};
    const away = row.away || {};

    teams[teamId] = {
      homeGF: home.goals?.for ?? 0,
      homeGA: home.goals?.against ?? 0,
      homeP: home.played ?? home.played ?? 0,
      awayGF: away.goals?.for ?? 0,
      awayGA: away.goals?.against ?? 0,
      awayP: away.played ?? 0
    };
  }

  cache.standings[leagueId] = {
    timestamp: now,
    teams
  };

  return teams;
}

// ---------------------------------------------------------------------
// Poisson helpers
// ---------------------------------------------------------------------
function factorial(n) {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return 0;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

// ---------------------------------------------------------------------
// Endpoint: liste competiții
// ---------------------------------------------------------------------
app.get("/api/competitions", (req, res) => {
  const out = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));
  res.json(out);
});

// ---------------------------------------------------------------------
// Endpoint: meciuri + predicții
// ---------------------------------------------------------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = Number(req.query.competitionId);
    const comp = COMPETITIONS.find((c) => c.id === competitionId);

    if (!comp) {
      return res.status(400).json({ error: "competitionId invalid" });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const fixtures = await getUpcomingFixtures(comp);
    const standings = await getStandingsStats(comp);

    // luăm doar meciuri încă neîncepute
    const upcoming = fixtures.filter((fx) => {
      const status = fx.fixture?.status?.short;
      return status === "NS" || status === "TBD";
    });

    const matches = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = standings[homeId];
      const awayStats = standings[awayId];

      let lambdaHome = 1.4;
      let lambdaAway = 1.2;

      if (homeStats && awayStats) {
        const homeGF = homeStats.homeGF / Math.max(homeStats.homeP, 1);
        const homeGA = homeStats.homeGA / Math.max(homeStats.homeP, 1);
        const awayGF = awayStats.awayGF / Math.max(awayStats.awayP, 1);
        const awayGA = awayStats.awayGA / Math.max(awayStats.awayP, 1);

        // estimare simplă: atac gazde vs apărare oaspeți și invers
        lambdaHome = (homeGF + awayGA) / 2;
        lambdaAway = (awayGF + homeGA) / 2;

        // ajustare mică pentru avantaj teren propriu
        lambdaHome *= 1.10;
        lambdaAway *= 0.95;
      }

      // limite sigure
      lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 3.5);
      lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 3.5);

      // distribuții Poisson până la 7 goluri
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

      // în teorie suma = 1, dar normalizăm oricum
      const sum1X2 = probHomeWin + probDraw + probAwayWin || 1;

      const p1 = (probHomeWin / sum1X2) * 100;
      const pX = (probDraw / sum1X2) * 100;
      const p2 = (probAwayWin / sum1X2) * 100;

      const over25 = probOver25 * 100;
      const under25 = (1 - probOver25) * 100;
      const bttsYes = probBTTS * 100;
      const bttsNo = (1 - probBTTS) * 100;

      // alegem pick-ul principal și un „confidence” rațional
      let mainPick = "HOME";
      let mainProb = p1;
      let secondProb = Math.max(pX, p2);

      if (p2 > mainProb) {
        mainPick = "AWAY";
        mainProb = p2;
        secondProb = Math.max(p1, pX);
      }
      if (pX > mainProb) {
        mainPick = "DRAW";
        mainProb = pX;
        secondProb = Math.max(p1, p2);
      }

      const rawDiff = Math.max(mainProb - secondProb, 0); // 0–100
      const confidence = Math.min(80, Math.max(30, rawDiff + 30)); // tipic 40–65

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome: p1,
          probDraw: pX,
          probAway: p2,
          mainPick,
          confidence,
          goals: {
            over25,
            under25
          },
          btts: {
            yes: bttsYes,
            no: bttsNo
          },
          lambdas: {
            home: lambdaHome,
            away: lambdaAway
          }
        }
      });
    }

    res.json({ matches });
  } catch (e) {
    console.error("Eroare /api/matches:", e);
    res.json({ error: "Eroare la meciuri" });
  }
});

// ---------------------------------------------------------------------
// Test key
// ---------------------------------------------------------------------
app.get("/api/test-key", (req, res) => {
  const ok = !!API_KEY;
  res.json({
    ok,
    message: ok ? "Cheie OK" : "Cheie lipsă"
  });
});

// ---------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe portul ${PORT}`);
});
