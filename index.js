import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

if (!API_KEY) {
  console.warn("ATENȚIE: lipsă API_FOOTBALL_KEY în environment.");
}

app.use(cors());
app.use(express.json());

// ----------------------
// Helper pentru apeluri API-FOOTBALL
// ----------------------
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
      "x-rapidapi-host": "v3.football.api-sports.io"
    }
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} la ${path}: ${JSON.stringify(data.errors || data)}`
    );
  }

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(
      `Erori API la ${path}: ${JSON.stringify(data.errors)}`
    );
  }

  return data;
}

// ----------------------
// Competiții urmărite
// ----------------------
// ----------------------
// Competiții urmărite
// ----------------------
const COMPETITIONS = [
  {
    id: 39,
    code: "PL",
    name: "Premier League",
    country: "England",
    apiLeagueId: 39,
    season: 2025
  },
  {
    id: 135,
    code: "SA",
    name: "Serie A",
    country: "Italy",
    apiLeagueId: 135,
    season: 2025
  },
  {
    id: 140,
    code: "PD",
    name: "La Liga",
    country: "Spain",
    apiLeagueId: 140,
    season: 2025
  },
  {
    id: 61,
    code: "L1",
    name: "Ligue 1",
    country: "France",
    apiLeagueId: 61,
    season: 2025
  },
  {
    id: 78,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany",
    apiLeagueId: 78,
    season: 2025
  },
  {
    id: 88,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands",
    apiLeagueId: 88,
    season: 2025
  },
  {
    id: 283,
    code: "RO1",
    name: "Superliga",
    country: "Romania",
    apiLeagueId: 283,
    season: 2025
  },
  {
    id: 284,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284,
    season: 2025
  }
];
  {
    id: 284,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284,
    season: 2024
  }
];

// ----------------------
// Cache simplu
// ----------------------
const CACHE_TTL_MS = 60 * 1000;
const cache = {
  competitions: { data: null, ts: 0 },
  matches: {} // key: competitionId
};

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
// Lista competițiilor
// ----------------------
app.get("/api/competitions", (req, res) => {
  if (
    cache.competitions.data &&
    Date.now() - cache.competitions.ts < CACHE_TTL_MS
  ) {
    return res.json(cache.competitions.data);
  }

  const list = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));

  cache.competitions = { data: list, ts: Date.now() };
  res.json(list);
});

// ----------------------
// Poisson helpers
// ----------------------
function factorial(n) {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

// ----------------------
// Statistici echipă
// ----------------------
async function getTeamStats(teamId, leagueId, season) {
  try {
    const data = await apiFetch("/teams/statistics", {
      team: teamId,
      league: leagueId,
      season
    });

    const played =
      data.response?.fixtures?.played?.total ?? 0;

    const goalsFor =
      data.response?.goals?.for?.total?.total ?? 0;
    const goalsAgainst =
      data.response?.goals?.against?.total?.total ?? 0;

    const gfPerMatch = played > 0 ? goalsFor / played : 1.2;
    const gaPerMatch = played > 0 ? goalsAgainst / played : 1.2;

    return {
      gfPerMatch,
      gaPerMatch
    };
  } catch (e) {
    console.error("Eroare getTeamStats:", e.message);
    return {
      gfPerMatch: 1.2,
      gaPerMatch: 1.2
    };
  }
}

// ----------------------
// Meciuri cu predicții
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = Number(req.query.competitionId);
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === competitionId);
    if (!comp) {
      return res.status(404).json({ error: "Competiție necunoscută" });
    }

    // cache
    const cacheEntry = cache.matches[competitionId];
    if (cacheEntry && Date.now() - cacheEntry.ts < CACHE_TTL_MS) {
      return res.json({ matches: cacheEntry.data });
    }

    // Interval mare: din 2 zile în urmă până în 21 zile în față
    const daysBack = 2;
    const daysAhead = 21;

    const now = new Date();

    const dateFrom = new Date(now);
    dateFrom.setDate(now.getDate() - daysBack);

    const dateTo = new Date(now);
    dateTo.setDate(now.getDate() + daysAhead);

    const fromStr = dateFrom.toISOString().split("T")[0];
    const toStr = dateTo.toISOString().split("T")[0];

    // fixtures
    const fixturesData = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season: comp.season,
      from: fromStr,
      to: toStr
    });

    const fixtures = fixturesData.response ?? [];

    if (!Array.isArray(fixtures) || fixtures.length === 0) {
      console.error("Eroare API-FOOTBALL la /fixtures: []");
      return res.json({ matches: [] });
    }

    // Filtrăm meciuri viitoare sau foarte apropiate
    const upcoming = fixtures.filter((fx) => {
      const status = fx.fixture?.status?.short;
      return (
        status === "NS" ||
        status === "TBD" ||
        status === "PST" ||
        status === "FT" ||
        status === "LIVE"
      );
    });

    const matchesOut = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) {
        continue;
      }

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      if (!homeId || !awayId) {
        continue;
      }

      // Statistici echipe
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

      const homeGF = homeStats.gfPerMatch;
      const homeGA = homeStats.gaPerMatch;
      const awayGF = awayStats.gfPerMatch;
      const awayGA = awayStats.gaPerMatch;

      let lambdaHome = (homeGF + awayGA) / 2;
      let lambdaAway = (awayGF + homeGA) / 2;

      // avantaj teren propriu ușor
      lambdaHome *= 1.1;

      lambdaHome = Math.min(Math.max(lambdaHome, 0.2), 4.0);
      lambdaAway = Math.min(Math.max(lambdaAway, 0.2), 4.0);

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
          const joint = pHome[h] * pAway[a];

          if (h > a) probHomeWin += joint;
          else if (h === a) probDraw += joint;
          else probAwayWin += joint;

          if (h + a >= 3) probOver25 += joint;
          if (h >= 1 && a >= 1) probBTTS += joint;
        }
      }

      const p1 = probHomeWin * 100;
      const px = probDraw * 100;
      const p2 = probAwayWin * 100;

      const over25 = probOver25 * 100;
      const under25 = 100 - over25;

      const bttsYes = probBTTS * 100;
      const bttsNo = 100 - bttsYes;

      let mainPick = "HOME";
      let mainProb = p1;
      if (px > mainProb) {
        mainPick = "DRAW";
        mainProb = px;
      }
      if (p2 > mainProb) {
        mainPick = "AWAY";
        mainProb = p2;
      }

      const matchOut = {
        id: fixture.id,
        utcDate: fixture.date,
        competition: league?.name || comp.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome: Math.round(p1),
          probDraw: Math.round(px),
          probAway: Math.round(p2),
          mainPick,
          confidence: Math.round(mainProb),
          goals: {
            over25: Math.round(over25),
            under25: Math.round(under25)
          },
          btts: {
            yes: Math.round(bttsYes),
            no: Math.round(bttsNo)
          },
          lambdas: {
            home: Number(lambdaHome.toFixed(2)),
            away: Number(lambdaAway.toFixed(2))
          }
        }
      };

      matchesOut.push(matchOut);
    }

    cache.matches[competitionId] = {
      data: matchesOut,
      ts: Date.now()
    };

    res.json({ matches: matchesOut });
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    res.status(500).json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
// Pornire server
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe portul ${PORT}`);
});
