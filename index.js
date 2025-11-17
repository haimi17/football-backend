import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// *** FOLOSEȘTE VARIABILA CORESPUNZĂTOARE DIN RENDER ***
const API_KEY = process.env.API_FOOTBALL_KEY; 
const API_BASE = "https://v3.football.api-sports.io";

// Middleware
app.use(cors());
app.use(express.json());

// TEST CHEIE API
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: "API_FOOTBALL_KEY lipsă în backend" });
  }
  res.json({ message: "Cheie OK", keyExists: true });
});
const CACHE = {
  standings: {
    // [leagueId]: { timestamp, season, data }
  },
  fixtures: {
    // [leagueId]: { timestamp, season, data }
  },
};

const FIXTURES_TTL_MS = 2 * 60 * 1000;
const STANDINGS_TTL_MS = 10 * 60 * 1000;

/**
 * Helper pentru sezonul curent:
 * dacă suntem după iulie → sezon = anul curent
 * altfel → sezon = anul curent - 1
 */
function getCurrentSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  return month >= 7 ? year : year - 1;
}

/**
 * Helper: fetch JSON de la API-FOOTBALL
 */
async function apiGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error("API_SPORTS_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + path);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url.toString(), {
    headers: {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Eroare API-FOOTBALL:", response.status, text);
    const err = new Error("Eroare API");
    err.status = response.status;
    throw err;
  }

  const data = await response.json();
  return data;
}

/**
 * Root simplu
 */
app.get("/", (req, res) => {
  res.send("Football backend OK (API-FOOTBALL)");
});

/**
 * /api/competitions
 * Listă statică de ligi populare, cu ID-urile API-FOOTBALL
 */
app.get("/api/competitions", (req, res) => {
  const competitions = [
    { id: 39, code: "ENG1", name: "Premier League (ENG)" },
    { id: 140, code: "ESP1", name: "La Liga (ESP)" },
    { id: 135, code: "ITA1", name: "Serie A (ITA)" },
    { id: 78, code: "GER1", name: "Bundesliga (GER)" },
    { id: 61, code: "FRA1", name: "Ligue 1 (FRA)" },
    { id: 88, code: "NED1", name: "Eredivisie (NED)" },
    { id: 94, code: "POR1", name: "Primeira Liga (POR)" },
    { id: 2, code: "UCL", name: "UEFA Champions League" },
  ];

  res.json(competitions);
});

/**
 * Calculează un "rating" ofensiv/defensiv simplu
 * din statisticile din clasament (GF/GA + poziție).
 */
function buildTeamRating(entry, maxRank) {
  const goalsFor = entry.all.goals.for || 0;
  const goalsAgainst = entry.all.goals.against || 0;
  const played = entry.all.played || 1;
  const rank = entry.rank || maxRank;

  const avgGF = goalsFor / played;
  const avgGA = goalsAgainst / played;

  // Offensiv + defensiv
  const attackScore = avgGF;
  const defenseScore = 3 - Math.min(avgGA, 3); // cu cât mai mic GA, cu atât mai mare scor

  // Bonus pentru poziție bună în clasament
  const positionFactor = (maxRank - rank + 1) / maxRank; // 0..1

  const rawStrength = attackScore + defenseScore + 2 * positionFactor;

  return {
    avgGF,
    avgGA,
    rawStrength,
  };
}

/**
 * Generează predicții din ratingurile echipelor
 */
function generatePredictionFromRatings(homeRating, awayRating) {
  const diff = homeRating.rawStrength - awayRating.rawStrength;

  // transformăm diferența într-un interval -1..1
  const normDiff = Math.max(-1, Math.min(1, diff / 4));

  // bază neutră: 40-30-30
  let probHome = 0.4 + normDiff * 0.2; // ±20%
  let probAway = 0.3 - normDiff * 0.2;
  let probDraw = 1 - probHome - probAway;

  // protecție
  const clamp = (v) => Math.max(0.05, Math.min(0.8, v));
  probHome = clamp(probHome);
  probAway = clamp(probAway);
  probDraw = clamp(probDraw);

  // normalizare la 100%
  const total = probHome + probDraw + probAway;
  probHome /= total;
  probDraw /= total;
  probAway /= total;

  const probHomePct = Math.round(probHome * 100);
  const probDrawPct = Math.round(probDraw * 100);
  const probAwayPct = Math.round(probAway * 100);

  const maxProb = Math.max(probHomePct, probDrawPct, probAwayPct);
  let mainPick = "HOME";
  if (maxProb === probDrawPct) mainPick = "DRAW";
  if (maxProb === probAwayPct) mainPick = "AWAY";

  // "încredere" = cât de mare e diferența față de locul 2
  const sorted = [probHomePct, probDrawPct, probAwayPct].sort((a, b) => b - a);
  const confidence = Math.max(40, Math.min(90, sorted[0] - sorted[1] + 50));

  // estimări pentru goluri / BTTS
  const avgGFHome = homeRating.avgGF;
  const avgGFAway = awayRating.avgGF;
  const avgGoals = avgGFHome + avgGFAway;

  let over25 = 35 + avgGoals * 10; // 2.5 goluri
  over25 = Math.max(20, Math.min(85, over25));
  const under25 = 100 - Math.round(over25);

  let bttsYes = 30 + avgGoals * 12;
  bttsYes = Math.max(20, Math.min(85, bttsYes));
  const bttsNo = 100 - Math.round(bttsYes);

  // Cornere / cartonașe estimate simplu din intensitate (avgGoals)
  const intensity = Math.max(1, Math.min(3.5, avgGoals));
  let cornersOver95 = Math.round(35 + intensity * 8); // 35-63
  cornersOver95 = Math.max(20, Math.min(80, cornersOver95));
  const cornersUnder95 = 100 - cornersOver95;

  let cardsOver45 = Math.round(30 + intensity * 5); // 35-47
  cardsOver45 = Math.max(20, Math.min(75, cardsOver45));
  const cardsUnder45 = 100 - cardsOver45;

  return {
    probHome: probHomePct,
    probDraw: probDrawPct,
    probAway: probAwayPct,
    mainPick,
    confidence,
    goals: {
      over25: Math.round(over25),
      under25,
    },
    btts: {
      yes: Math.round(bttsYes),
      no: bttsNo,
    },
    corners: {
      over9_5: cornersOver95,
      under9_5: cornersUnder95,
    },
    cards: {
      over4_5: cardsOver45,
      under4_5: cardsUnder45,
    },
    explain: {
      home: {
        avgGF: +avgGFHome.toFixed(2),
        avgGA: +homeRating.avgGA.toFixed(2),
      },
      away: {
        avgGF: +avgGFAway.toFixed(2),
        avgGA: +awayRating.avgGA.toFixed(2),
      },
    },
  };
}

/**
 * /api/matches
 * Parametru: competitionId = ID ligă API-FOOTBALL (ex: 39 pentru Premier League)
 * Returnează următoarele 10 meciuri + predicții bazate pe clasament.
 */
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;

    if (!competitionId) {
      return res.status(400).json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_SPORTS_KEY lipsă în backend" });
    }

    const leagueId = Number(competitionId);
    if (!Number.isFinite(leagueId)) {
      return res.status(400).json({ error: "competitionId invalid" });
    }

    const season = getCurrentSeason();
    const now = Date.now();

    // 1) STANDINGS (cu cache)
    let standingsData;
    const standingsCache = CACHE.standings[leagueId];

    if (
      standingsCache &&
      standingsCache.season === season &&
      now - standingsCache.timestamp < STANDINGS_TTL_MS
    ) {
      standingsData = standingsCache.data;
    } else {
      const standingsResp = await apiGet("/standings", {
        league: leagueId,
        season,
      });

      const standingsArray =
        standingsResp?.response?.[0]?.league?.standings?.[0] || [];

      CACHE.standings[leagueId] = {
        timestamp: now,
        season,
        data: standingsArray,
      };
      standingsData = standingsArray;
    }

    // mapă teamId → rating
    const maxRank =
      standingsData.length > 0
        ? Math.max(...standingsData.map((e) => e.rank || 1))
        : 20;

    const ratingsByTeamId = {};
    for (const entry of standingsData) {
      const teamId = entry?.team?.id;
      if (!teamId) continue;
      ratingsByTeamId[teamId] = buildTeamRating(entry, maxRank);
    }

    // 2) FIXTURES (cu cache)
    let fixturesData;
    const fixturesCache = CACHE.fixtures[leagueId];

    if (
      fixturesCache &&
      fixturesCache.season === season &&
      now - fixturesCache.timestamp < FIXTURES_TTL_MS
    ) {
      fixturesData = fixturesCache.data;
    } else {
      const fixturesResp = await apiGet("/fixtures", {
        league: leagueId,
        season,
        next: 10, // următoarele 10 meciuri
        timezone: "Europe/London",
      });

      const fixturesArray = fixturesResp?.response || [];

      CACHE.fixtures[leagueId] = {
        timestamp: now,
        season,
        data: fixturesArray,
      };
      fixturesData = fixturesArray;
    }

    if (!fixturesData || fixturesData.length === 0) {
      return res.json([]); // nu e eroare, doar nu sunt meciuri programate
    }

    // 3) Construim lista de meciuri + predicții
    const matches = fixturesData.map((fx) => {
      const fixture = fx.fixture || {};
      const league = fx.league || {};
      const teams = fx.teams || {};

      const homeTeam = teams.home || {};
      const awayTeam = teams.away || {};

      const homeRating =
        ratingsByTeamId[homeTeam.id] ||
        buildTeamRating(
          {
            all: { goals: { for: 1, against: 1 }, played: 1 },
            rank: maxRank / 2,
          },
          maxRank
        );

      const awayRating =
        ratingsByTeamId[awayTeam.id] ||
        buildTeamRating(
          {
            all: { goals: { for: 1, against: 1 }, played: 1 },
            rank: maxRank / 2,
          },
          maxRank
        );

      const prediction = generatePredictionFromRatings(homeRating, awayRating);

      return {
        id: fixture.id,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: homeTeam.name,
        awayTeam: awayTeam.name,
        prediction,
      };
    });

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err.message || err);
    const status = err.status || 500;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: "Prea multe cereri la API-FOOTBALL (429)" });
    }
    res.status(status).json({ error: "Eroare internă la meciuri" });
  }
});

// PORNIRE SERVER
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
