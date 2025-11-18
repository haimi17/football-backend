import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ----------------------
// Config competiții
// ----------------------
const COMPETITIONS = [
  {
    id: 39,
    code: "PL",
    name: "Premier League",
    country: "England",
    apiLeagueId: 39,
    season: 2024
  },
  {
    id: 135,
    code: "SA",
    name: "Serie A",
    country: "Italy",
    apiLeagueId: 135,
    season: 2024
  },
  {
    id: 140,
    code: "PD",
    name: "La Liga",
    country: "Spain",
    apiLeagueId: 140,
    season: 2024
  },
  {
    id: 61,
    code: "L1",
    name: "Ligue 1",
    country: "France",
    apiLeagueId: 61,
    season: 2024
  },
  {
    id: 78,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany",
    apiLeagueId: 78,
    season: 2024
  },
  {
    id: 88,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands",
    apiLeagueId: 88,
    season: 2024
  },
  {
    id: 283,
    code: "RO1",
    name: "Superliga",
    country: "Romania",
    apiLeagueId: 283,
    season: 2024
  },
  {
    id: 284,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284,
    season: 2024
  }
];

// cache simplu în memorie
const CACHE_TTL = 60 * 1000;
const cache = {
  competitions: { data: null, ts: 0 },
  matches: {}
};

// ----------------------
// Helper pentru API-FOOTBALL
// ----------------------
async function apiFetch(endpoint, params = {}) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) =>
    url.searchParams.append(k, String(v))
  );

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io"
    }
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HTTP ${res.status} la ${endpoint}: ${txt}`);
  }

  const json = await res.json();

  // doar logăm eventualele erori ale API-ului, nu oprim execuția
  if (json.errors && Object.keys(json.errors).length > 0) {
    console.error("Erori API-FOOTBALL la", endpoint, json.errors);
  }

  return json;
}

// Poisson PMF
function poissonPMF(lambda, k) {
  if (lambda <= 0) return 0;
  let num = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) {
    num *= lambda / i;
  }
  return num;
}

// ----------------------
// Test cheie
// ----------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "Cheie lipsă" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// ----------------------
// Competitions
// ----------------------
app.get("/api/competitions", (req, res) => {
  const now = Date.now();
  if (cache.competitions.data && now - cache.competitions.ts < CACHE_TTL) {
    return res.json(cache.competitions.data);
  }

  const list = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));

  cache.competitions = { data: list, ts: now };
  res.json(list);
});

// ----------------------
// Matches + predicții
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = Number(req.query.competitionId);
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === competitionId);
    if (!comp) {
      return res.status(400).json({ error: "competitionId necunoscut" });
    }

    const cacheKey = String(competitionId);
    const now = Date.now();
    if (
      cache.matches[cacheKey] &&
      now - cache.matches[cacheKey].ts < CACHE_TTL
    ) {
      return res.json(cache.matches[cacheKey].data);
    }

    // luăm următoarele 20 meciuri din ligă (nu mai folosim from/to)
    const fixturesJson = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      next: 20,
      timezone: "Europe/Bucharest"
    });

    const fixtures = fixturesJson.response || [];

    if (fixtures.length === 0) {
      console.log(
        `Niciun fixture pentru ${comp.name} cu next=20 (league=${comp.apiLeagueId}, season=${comp.season})`
      );
      const empty = { matches: [] };
      cache.matches[cacheKey] = { data: empty, ts: now };
      return res.json(empty);
    }

    // cache pentru statistics pe echipă
    const teamStatsCache = {};

    async function getTeamStats(teamId) {
      if (teamStatsCache[teamId]) return teamStatsCache[teamId];

      const statsJson = await apiFetch("/teams/statistics", {
        league: comp.apiLeagueId,
        season: comp.season,
        team: teamId
      });

      const stats = statsJson.response;
      teamStatsCache[teamId] = stats;
      return stats;
    }

    const out = [];

    for (const fx of fixtures) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home?.id || !teams?.away?.id) {
        continue;
      }

      const status = fixture.status?.short;
      if (status && status !== "NS" && status !== "TBD") {
        continue;
      }

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = await getTeamStats(homeId);
      const awayStats = await getTeamStats(awayId);

      const homeGF =
        homeStats?.goals?.for?.total?.home ?? 0;
      const homeGA =
        homeStats?.goals?.against?.total?.home ?? 0;
      const awayGF =
        awayStats?.goals?.for?.total?.away ?? 0;
      const awayGA =
        awayStats?.goals?.against?.total?.away ?? 0;

      const homePlayed =
        homeStats?.fixtures?.played?.home ?? 1;
      const awayPlayed =
        awayStats?.fixtures?.played?.away ?? 1;

      let lambdaHome = (homeGF / homePlayed + awayGA / awayPlayed) / 2;
      let lambdaAway = (awayGF / awayPlayed + homeGA / homePlayed) / 2;

      // mic avantaj teren propriu
      lambdaHome *= 1.1;
      lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 3.5);
      lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 3.5);

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
        const pH = pHome[h];
        for (let a = 0; a <= maxGoals; a++) {
          const pA = pAway[a];
          const joint = pH * pA;
          const goals = h + a;

          if (h > a) probHomeWin += joint;
          else if (h === a) probDraw += joint;
          else probAwayWin += joint;

          if (goals >= 3) probOver25 += joint;
          if (h > 0 && a > 0) probBTTS += joint;
        }
      }

      const probHome = probHomeWin * 100;
      const probDrawP = probDraw * 100;
      const probAway = probAwayWin * 100;
      const over25 = probOver25 * 100;
      const under25 = 100 - over25;
      const bttsYes = probBTTS * 100;
      const bttsNo = 100 - bttsYes;

      const probs = [probHome, probDrawP, probAway];
      const maxProb = Math.max(...probs);
      let mainPick = "HOME";
      if (maxProb === probDrawP) mainPick = "DRAW";
      else if (maxProb === probAway) mainPick = "AWAY";

      const matchObj = {
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome,
          probDraw: probDrawP,
          probAway,
          mainPick,
          confidence: maxProb,
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
      };

      out.push(matchObj);
    }

    const result = { matches: out };
    cache.matches[cacheKey] = { data: result, ts: now };
    res.json(result);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    res.status(500).json({
      error: "Eroare la meciuri",
      details: String(err.message || err)
    });
  }
});

// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
