import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

// ---------------------------
// COMPETIȚII SUPORTATE
// ---------------------------
const COMPETITIONS = [
  { id: 39, code: "PL", name: "Premier League", country: "England", apiLeagueId: 39, season: 2024 },
  { id: 135, code: "SA", name: "Serie A", country: "Italy", apiLeagueId: 135, season: 2024 },
  { id: 140, code: "PD", name: "La Liga", country: "Spain", apiLeagueId: 140, season: 2024 },
  { id: 61, code: "L1", name: "Ligue 1", country: "France", apiLeagueId: 61, season: 2024 },
  { id: 78, code: "BL1", name: "Bundesliga", country: "Germany", apiLeagueId: 78, season: 2024 },
  { id: 88, code: "DED", name: "Eredivisie", country: "Netherlands", apiLeagueId: 88, season: 2024 },
  { id: 283, code: "RO1", name: "Superliga", country: "Romania", apiLeagueId: 283, season: 2024 },
  { id: 284, code: "RO2", name: "Liga 2", country: "Romania", apiLeagueId: 284, season: 2024 }
];

// ---------------------------
// CACHE LOCAL
// ---------------------------
const cache = {
  matches: {}  // cache.matches[competitionId] = { data, ts }
};

const CACHE_TTL = 1000 * 60 * 10; // 10 minute

// ---------------------------
// FUNCȚIE PENTRU API-FOOTBALL
// ---------------------------
async function apiFetch(endpoint, params = {}) {
  const BASE = "https://v3.football.api-sports.io";
  const query = new URLSearchParams(params).toString();
  const url = `${BASE}${endpoint}?${query}`;

  const res = await fetch(url, {
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  const json = await res.json();
  return json;
}

// ---------------------------
// FUNCȚII MATEMATICE
// ---------------------------
function factorial(n) {
  return n <= 1 ? 1 : n * factorial(n - 1);
}

function poissonPMF(lambda, k) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

// ---------------------------
// ROUTE: /api/status
// ---------------------------
app.get("/api/status", (req, res) => {
  res.json({ ok: true, message: "Cheie OK" });
});

// ---------------------------
// ROUTE: /api/competitions
// ---------------------------
app.get("/api/competitions", (req, res) => {
  res.json(COMPETITIONS);
});

// ---------------------------
// ROUTE: /api/matches
// ---------------------------
app.get("/api/matches", async (req, res) => {
  const leagueId = req.query.leagueId;
  const season = req.query.season || 2024;

  const today = new Date();
  const end = new Date();
  end.setDate(today.getDate() + 21);

  const fromDate = today.toISOString().split("T")[0];
  const toDate = end.toISOString().split("T")[0];

  try {
    const apiRes = await fetch(
      `https://v3.football.api-sports.io/fixtures?league=${leagueId}&season=${season}&from=${fromDate}&to=${toDate}`,
      {
        headers: { "x-apisports-key": process.env.API_KEY }
      }
    );

    const apiData = await apiRes.json();

    if (!apiData.response) {
      return res.json({
        matches: [],
        apiErrors: ["API nu a trimis câmpul response"]
      });
    }

    return res.json({
      matches: apiData.response,
      apiErrors: apiData.errors || []
    });

  } catch (err) {
    console.error("Eroare reală API:", err);
    return res.json({
      matches: [],
      apiErrors: ["Eroare la fetch", String(err)]
    });
  }
});

    const apiErrors = fixturesJson.errors || {};
    const fixtures = fixturesJson.response || [];

    // Dacă nu avem meciuri → returnăm și erorile API
    if (fixtures.length === 0) {
      console.log(
        `[INFO] Niciun fixture pentru ${comp.name}. API errors:`,
        apiErrors
      );
      const data = { matches: [], apiErrors };
      cache.matches[cacheKey] = { data, ts: now };
      return res.json(data);
    }

    // --------------------------------------------------------
    // STATISTICI PE ECHIPE
    // --------------------------------------------------------
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

      if (!fixture || !teams?.home?.id || !teams?.away?.id) continue;

      const status = fixture.status?.short;
      if (status && status !== "NS" && status !== "TBD") continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeStats = await getTeamStats(homeId);
      const awayStats = await getTeamStats(awayId);

      const homeGF = homeStats?.goals?.for?.total?.home ?? 0;
      const homeGA = homeStats?.goals?.against?.total?.home ?? 0;
      const awayGF = awayStats?.goals?.for?.total?.away ?? 0;
      const awayGA = awayStats?.goals?.against?.total?.away ?? 0;

      const homePlayed = homeStats?.fixtures?.played?.home ?? 1;
      const awayPlayed = awayStats?.fixtures?.played?.away ?? 1;

      let lambdaHome = (homeGF / homePlayed + awayGA / awayPlayed) / 2;
      let lambdaAway = (awayGF / awayPlayed + homeGA / homePlayed) / 2;

      lambdaHome *= 1.1; // avantaj teren propriu

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

      out.push({
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
      });
    }

    const data = { matches: out, apiErrors };
    cache.matches[cacheKey] = { data, ts: now };
    res.json(data);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    res.status(500).json({
      error: "Eroare la meciuri",
      details: String(err.message || err)
    });
  }
});

// ---------------------------
// PORNIRE SERVER
// ---------------------------
app.listen(PORT, () => {
  console.log(`Backend ready on port ${PORT}`);
});
