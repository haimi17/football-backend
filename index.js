import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// Echipe considerate puternice
const BIG_TEAMS = [
  "Real Madrid",
  "FC Barcelona",
  "Atletico Madrid",
  "Manchester City FC",
  "Liverpool FC",
  "Arsenal FC",
  "Manchester United FC",
  "Chelsea FC",
  "FC Bayern München",
  "Borussia Dortmund",
  "Paris Saint-Germain FC",
  "Juventus FC",
  "FC Internazionale Milano",
  "AC Milan",
  "SSC Napoli",
];

// Cache simplu în memorie
const standingsCache = new Map(); // key: competitionId -> { timestamp, strengths }
const matchesCache = new Map();   // key: competitionId -> { timestamp, matches }
const formCache = new Map();      // key: competitionId -> { timestamp, formStats }

app.get("/", (req, res) => {
  res.send("Football backend OK");
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pseudoRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0) / 4294967295;
}

function prngForMatch(match, key) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";
  const id = match?.id || 0;
  const seed = `${id}-${homeName}-${awayName}-${key}`;
  return pseudoRandom(seed);
}

// standings -> strength per team
async function getTeamStrengths(competitionId) {
  const cached = standingsCache.get(competitionId);
  const now = Date.now();
  const TTL = 12 * 60 * 60 * 1000;

  if (cached && now - cached.timestamp < TTL) {
    return cached.strengths;
  }

  if (!API_KEY) {
    return {};
  }

  try {
    const url = `${API_BASE}/competitions/${competitionId}/standings`;
    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /standings:", response.status, text);
      return {};
    }

    const data = await response.json();
    const table = data.standings?.[0]?.table || [];

    const strengths = {};
    const n = table.length || 1;

    table.forEach((row, index) => {
      const teamName = row.team?.name;
      if (!teamName) return;

      const position = row.position ?? index + 1;

      const factor =
        1.15 - ((position - 1) / Math.max(n - 1, 1)) * 0.3; // 1.15 -> 0.85
      strengths[teamName] = factor;
    });

    standingsCache.set(competitionId, {
      timestamp: now,
      strengths,
    });

    return strengths;
  } catch (err) {
    console.error("Eroare server getTeamStrengths:", err);
    return {};
  }
}

// formă recentă: ultimele ~60 zile, acasă / deplasare
async function getTeamForm(competitionId) {
  const cached = formCache.get(competitionId);
  const now = Date.now();
  const TTL = 6 * 60 * 60 * 1000;

  if (cached && now - cached.timestamp < TTL) {
    return cached.formStats;
  }

  if (!API_KEY) {
    return {};
  }

  try {
    const today = new Date();
    const to = new Date(today);
    to.setDate(today.getDate() - 1);
    const from = new Date(today);
    from.setDate(today.getDate() - 60);

    const dateFrom = from.toISOString().slice(0, 10);
    const dateTo = to.toISOString().slice(0, 10);

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /matches (form):", response.status, text);
      return {};
    }

    const data = await response.json();
    const matches = data.matches || [];

    const stats = {};

    function ensureTeam(name) {
      if (!stats[name]) {
        stats[name] = {
          home: { played: 0, points: 0, gf: 0, ga: 0 },
          away: { played: 0, points: 0, gf: 0, ga: 0 },
        };
      }
      return stats[name];
    }

    for (const m of matches) {
      if (m.status !== "FINISHED") continue;

      const homeName = m.homeTeam?.name;
      const awayName = m.awayTeam?.name;
      if (!homeName || !awayName) continue;

      const ft = m.score?.fullTime || {};
      const gh = typeof ft.home === "number" ? ft.home : null;
      const ga = typeof ft.away === "number" ? ft.away : null;
      if (gh === null || ga === null) continue;

      const homeStats = ensureTeam(homeName).home;
      const awayStats = ensureTeam(awayName).away;

      homeStats.played += 1;
      homeStats.gf += gh;
      homeStats.ga += ga;

      awayStats.played += 1;
      awayStats.gf += ga;
      awayStats.ga += gh;

      if (gh > ga) {
        homeStats.points += 3;
      } else if (gh < ga) {
        awayStats.points += 3;
      } else {
        homeStats.points += 1;
        awayStats.points += 1;
      }
    }

    const formStats = {};

    Object.entries(stats).forEach(([team, v]) => {
      const home = v.home;
      const away = v.away;

      const homePpm = home.played ? home.points / home.played : 0;
      const awayPpm = away.played ? away.points / away.played : 0;
      const homeGf = home.played ? home.gf / home.played : 0;
      const awayGf = away.played ? away.gf / away.played : 0;
      const homeGa = home.played ? home.ga / home.played : 0;
      const awayGa = away.played ? away.ga / away.played : 0;

      const totalPlayed = home.played + away.played;
      const totalPoints = home.points + away.points;
      const totalGf = home.gf + away.gf;
      const totalGa = home.ga + away.ga;

      const overallPpm = totalPlayed ? totalPoints / totalPlayed : 0;
      const overallGf = totalPlayed ? totalGf / totalPlayed : 0;
      const overallGa = totalPlayed ? totalGa / totalPlayed : 0;

      formStats[team] = {
        homePpm,
        awayPpm,
        overallPpm,
        homeGf,
        awayGf,
        overallGf,
        homeGa,
        awayGa,
        overallGa,
      };
    });

    formCache.set(competitionId, { timestamp: now, formStats });

    return formStats;
  } catch (err) {
    console.error("Eroare server getTeamForm:", err);
    return {};
  }
}

function generatePrediction(match, strengths = {}, formStats = {}) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";

  const tableStrengthHome = strengths[homeName] ?? 1;
  const tableStrengthAway = strengths[awayName] ?? 1;

  const formHome = formStats[homeName] || {};
  const formAway = formStats[awayName] || {};

  const homePpm =
    formHome.homePpm ?? formHome.overallPpm ?? 1.5;
  const awayPpm =
    formAway.awayPpm ?? formAway.overallPpm ?? 1.5;

  const ppmMid = 1.5;

  let strengthHome = tableStrengthHome;
  let strengthAway = tableStrengthAway;

  const homeFormFactor = clamp(1 + (homePpm - ppmMid) * 0.12, 0.75, 1.25);
  const awayFormFactor = clamp(1 + (awayPpm - ppmMid) * 0.12, 0.75, 1.25);

  strengthHome *= homeFormFactor;
  strengthAway *= awayFormFactor;

  const homeAdvantage = 0.15;
  strengthHome += homeAdvantage;

  if (BIG_TEAMS.includes(homeName)) strengthHome += 0.25;
  if (BIG_TEAMS.includes(awayName)) strengthAway += 0.25;

  const strengthDiff = Math.abs(strengthHome - strengthAway);
  const closeness = clamp(1 - strengthDiff, 0, 1);

  const baseDrawProb = 0.18 + 0.18 * closeness;
  const nonDrawProb = 1 - baseDrawProb;
  const sumStrength = strengthHome + strengthAway;

  let rawHome = (strengthHome / sumStrength) * nonDrawProb;
  let rawAway = (strengthAway / sumStrength) * nonDrawProb;
  let rawDraw = baseDrawProb;

  const noiseHome = (prngForMatch(match, "home") - 0.5) * 0.06;
  const noiseAway = (prngForMatch(match, "away") - 0.5) * 0.06;
  const noiseDraw = (prngForMatch(match, "draw") - 0.5) * 0.04;

  rawHome += noiseHome;
  rawAway += noiseAway;
  rawDraw += noiseDraw;

  rawHome = clamp(rawHome, 0.05, 0.9);
  rawAway = clamp(rawAway, 0.05, 0.9);
  rawDraw = clamp(rawDraw, 0.05, 0.9);

  const totalRaw = rawHome + rawDraw + rawAway;
  let probHome = Math.round((rawHome / totalRaw) * 100);
  let probDraw = Math.round((rawDraw / totalRaw) * 100);
  let probAway = Math.round((rawAway / totalRaw) * 100);

  let sum = probHome + probDraw + probAway;
  if (sum !== 100) {
    const diff = 100 - sum;
    if (probHome >= probDraw && probHome >= probAway) {
      probHome += diff;
    } else if (probAway >= probHome && probAway >= probDraw) {
      probAway += diff;
    } else {
      probDraw += diff;
    }
  }

  const arr = [
    { label: "HOME", value: probHome },
    { label: "DRAW", value: probDraw },
    { label: "AWAY", value: probAway },
  ];
  arr.sort((a, b) => b.value - a.value);
  const mainPick = arr[0].label;

  const margin = (arr[0].value - arr[1].value) / 100;
  let confidence = 55 + margin * 120;
  if (
    mainPick === "HOME" &&
    BIG_TEAMS.includes(homeName) &&
    probHome >= 60
  ) {
    confidence += 5;
  }
  confidence = clamp(Math.round(confidence), 50, 95);

  const overallGfHome =
    formHome.overallGf ?? formHome.homeGf ?? 1.2;
  const overallGfAway =
    formAway.overallGf ?? formAway.awayGf ?? 1.2;

  const attackIndexBase = (probHome + probAway) / 200;
  const attackGoalsFactor = clamp(
    (overallGfHome + overallGfAway) / 4,
    0.6,
    1.4
  );
  const attackIndex = clamp(
    attackIndexBase * attackGoalsFactor,
    0,
    1
  );

  const goalsBase = 0.45 + attackIndex * 0.35;
  const goalsNoise = (prngForMatch(match, "goals") - 0.5) * 0.15;
  let goalsOver25 = clamp(goalsBase + goalsNoise, 0.25, 0.88);
  let goalsUnder25 = 1 - goalsOver25;

  let bttsBase = 0.40 + attackIndex * 0.30;
  const bttsNoise = (prngForMatch(match, "btts") - 0.5) * 0.15;
  let bttsYes = clamp(bttsBase + bttsNoise, 0.20, 0.85);
  let bttsNo = 1 - bttsYes;

  let cornersBase = 0.45 + attackIndex * 0.30;
  const cornersNoise = (prngForMatch(match, "corners") - 0.5) * 0.12;
  let cornersOver = clamp(cornersBase + cornersNoise, 0.25, 0.90);
  let cornersUnder = 1 - cornersOver;

  const overallGaHome =
    formHome.overallGa ?? formHome.homeGa ?? 1.2;
  const overallGaAway =
    formAway.overallGa ?? formAway.awayGa ?? 1.2;
  const defenseRoughness = clamp(
    (overallGaHome + overallGaAway) / 4,
    0.6,
    1.4
  );

  let cardsBase = 0.45 + (1 - closeness) * 0.12;
  cardsBase *= defenseRoughness;
  const cardsNoise = (prngForMatch(match, "cards") - 0.5) * 0.18;
  let cardsOver = clamp(cardsBase + cardsNoise, 0.20, 0.90);
  let cardsUnder = 1 - cardsOver;

  let foulsHomeMore =
    0.50 +
    (prngForMatch(match, "fouls-home") - 0.5) * 0.20 +
    (strengthHome - strengthAway) * 0.05;
  foulsHomeMore = clamp(foulsHomeMore, 0.30, 0.70);
  let foulsAwayMore = 1 - foulsHomeMore;

  let shotsBase = 0.48 + attackIndex * 0.35;
  shotsBase *= attackGoalsFactor;
  const shotsNoise = (prngForMatch(match, "shots") - 0.5) * 0.15;
  let shotsOver = clamp(shotsBase + shotsNoise, 0.30, 0.92);
  let shotsUnder = 1 - shotsOver;

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence,

    goals: {
      over25: Math.round(goalsOver25 * 100),
      under25: Math.round(goalsUnder25 * 100),
      bttsYes: Math.round(bttsYes * 100),
      bttsNo: Math.round(bttsNo * 100),
    },

    corners: {
      over9_5: Math.round(cornersOver * 100),
      under9_5: Math.round(cornersUnder * 100),
    },

    cards: {
      over4_5: Math.round(cardsOver * 100),
      under4_5: Math.round(cardsUnder * 100),
    },

    fouls: {
      homeMore: Math.round(foulsHomeMore * 100),
      awayMore: Math.round(foulsAwayMore * 100),
    },

    shots: {
      totalOver: Math.round(shotsOver * 100),
      totalUnder: Math.round(shotsUnder * 100),
    },
  };
}

app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const response = await fetch(`${API_BASE}/competitions`, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /competitions:", response.status, text);
      return res
        .status(response.status)
        .json({
          error: "Eroare de la football-data.org",
          status: response.status,
        });
    }

    const data = await response.json();

    const allowedCodes = ["CL", "PL", "PD", "SA", "BL1", "FL1", "DED", "PPL"];
    const filtered = (data.competitions || []).filter((c) =>
      allowedCodes.includes(c.code)
    );

    res.json(filtered);
  } catch (err) {
    console.error("Eroare server /api/competitions:", err);
    res.status(500).json({ error: "Eroare internă server" });
  }
});

app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res
        .status(400)
        .json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const cached = matchesCache.get(competitionId);
    const now = Date.now();
    const TTL = 10 * 60 * 1000;

    if (cached && now - cached.timestamp < TTL) {
      return res.json(cached.matches);
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date(today);
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /matches:", response.status, text);
      return res
        .status(response.status)
        .json({
          error: "Eroare de la football-data.org",
          status: response.status,
        });
    }

    const data = await response.json();

    const strengths = await getTeamStrengths(competitionId);
    const formStats = await getTeamForm(competitionId);

    const matches = (data.matches || []).map((m) => {
      const prediction = generatePrediction(m, strengths, formStats);

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction,
      };
    });

    matchesCache.set(competitionId, { timestamp: now, matches });

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    res.status(500).json({ error: "Eroare internă server" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
