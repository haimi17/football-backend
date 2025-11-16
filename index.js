import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// Echipe puternice
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

// Profil per ligă (medii aproximative)
const LEAGUE_PROFILE = {
  CL:  { goalsAvg: 2.9, pace: 1.10, cornersAvg: 10.0, cardsAvg: 4.1, foulsAvg: 23, shotsAvg: 25 },
  PL:  { goalsAvg: 2.9, pace: 1.12, cornersAvg: 10.3, cardsAvg: 3.8, foulsAvg: 21, shotsAvg: 26 },
  PD:  { goalsAvg: 2.5, pace: 0.98, cornersAvg: 9.2,  cardsAvg: 5.0, foulsAvg: 26, shotsAvg: 22 },
  SA:  { goalsAvg: 2.4, pace: 0.92, cornersAvg: 9.0,  cardsAvg: 5.3, foulsAvg: 27, shotsAvg: 21 },
  BL1: { goalsAvg: 3.1, pace: 1.18, cornersAvg: 10.0, cardsAvg: 4.0, foulsAvg: 22, shotsAvg: 25 },
  FL1: { goalsAvg: 2.6, pace: 0.96, cornersAvg: 9.5,  cardsAvg: 4.0, foulsAvg: 24, shotsAvg: 23 },
  DED: { goalsAvg: 3.0, pace: 1.08, cornersAvg: 10.0, cardsAvg: 3.2, foulsAvg: 21, shotsAvg: 24 },
  PPL: { goalsAvg: 2.4, pace: 0.90, cornersAvg: 8.9,  cardsAvg: 5.5, foulsAvg: 27, shotsAvg: 20 },
  DEFAULT: { goalsAvg: 2.6, pace: 1.00, cornersAvg: 9.5, cardsAvg: 4.2, foulsAvg: 24, shotsAvg: 23 },
};

// Cache simplu în memorie
const standingsCache = new Map(); // compId -> { timestamp, strengths }
const matchesCache = new Map();   // compId -> { timestamp, matches }
const formCache = new Map();      // compId -> { timestamp, formStats }

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
  const compCode = match?.competition?.code || "";
  const seed = `${id}-${homeName}-${awayName}-${compCode}-${key}`;
  return pseudoRandom(seed);
}

// Poisson simplu
function poissonProb(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  const lnP = -lambda + k * Math.log(lambda) - logFactorial(k);
  return Math.exp(lnP);
}

const factCache = {};
function logFactorial(n) {
  if (n <= 1) return 0;
  if (factCache[n]) return factCache[n];
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  factCache[n] = s;
  return s;
}

// standings -> strength per team
async function getTeamStrengths(competitionId) {
  const cached = standingsCache.get(competitionId);
  const now = Date.now();
  const TTL = 12 * 60 * 60 * 1000;

  if (cached && now - cached.timestamp < TTL) {
    return cached.strengths;
  }

  if (!API_KEY) return {};

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

// formă recentă + Elo, pe ultimele 45 zile
async function getTeamFormAndElo(competitionId) {
  const cached = formCache.get(competitionId);
  const now = Date.now();
  const TTL = 6 * 60 * 60 * 1000;

  if (cached && now - cached.timestamp < TTL) {
    return cached.formStats;
  }

  if (!API_KEY) return {};

  try {
    const today = new Date();
    const to = new Date(today);
    to.setDate(today.getDate() - 1);
    const from = new Date(today);
    from.setDate(today.getDate() - 45);

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
    const allMatches = (data.matches || []).filter(
      (m) => m.status === "FINISHED"
    );

    // sortăm cronologic pentru Elo
    allMatches.sort((a, b) => {
      const da = a.utcDate || "";
      const db = b.utcDate || "";
      return da.localeCompare(db);
    });

    const stats = {};
    const elo = {};

    function ensureTeamStats(name) {
      if (!stats[name]) {
        stats[name] = {
          home: { played: 0, points: 0, gf: 0, ga: 0 },
          away: { played: 0, points: 0, gf: 0, ga: 0 },
        };
      }
      return stats[name];
    }

    function ensureElo(name) {
      if (!elo[name]) elo[name] = 1500;
      return elo[name];
    }

    // parcurgem meciurile o singură dată: formă + Elo
    for (const m of allMatches) {
      const homeName = m.homeTeam?.name;
      const awayName = m.awayTeam?.name;
      if (!homeName || !awayName) continue;

      const ft = m.score?.fullTime || {};
      const gh = typeof ft.home === "number" ? ft.home : null;
      const ga = typeof ft.away === "number" ? ft.away : null;
      if (gh === null || ga === null) continue;

      // formă
      const homeStats = ensureTeamStats(homeName).home;
      const awayStats = ensureTeamStats(awayName).away;

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

      // Elo
      let eloHome = ensureElo(homeName);
      let eloAway = ensureElo(awayName);

      const expHome = 1 / (1 + Math.pow(10, (eloAway - eloHome) / 400));
      const expAway = 1 - expHome;

      let resHome = 0.5;
      let resAway = 0.5;
      if (gh > ga) {
        resHome = 1;
        resAway = 0;
      } else if (gh < ga) {
        resHome = 0;
        resAway = 1;
      }

      const K = 18;
      eloHome = eloHome + K * (resHome - expHome);
      eloAway = eloAway + K * (resAway - expAway);

      elo[homeName] = eloHome;
      elo[awayName] = eloAway;
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
        elo: elo[team] || 1500,
      };
    });

    formCache.set(competitionId, { timestamp: now, formStats });

    return formStats;
  } catch (err) {
    console.error("Eroare server getTeamFormAndElo:", err);
    return {};
  }
}

// calcul scor corect și xG cu Poisson
function computeXgAndScoreProb(
  xgHome,
  xgAway,
  maxGoals = 4
) {
  const scores = [];
  let pTotal = 0;

  for (let gh = 0; gh <= maxGoals; gh++) {
    for (let ga = 0; ga <= maxGoals; ga++) {
      const pH = poissonProb(xgHome, gh);
      const pA = poissonProb(xgAway, ga);
      const p = pH * pA;
      scores.push({ gh, ga, p });
      pTotal += p;
    }
  }

  // normalizăm dacă e nevoie
  if (pTotal > 0) {
    scores.forEach((s) => {
      s.p = s.p / pTotal;
    });
  }

  scores.sort((a, b) => b.p - a.p);
  const top3 = scores.slice(0, 3).map((s) => ({
    score: `${s.gh}-${s.ga}`,
    prob: Math.round(s.p * 100),
  }));

  // probabilități agregate pentru goluri și BTTS
  let pOver25 = 0;
  let pBTTS = 0;
  for (const s of scores) {
    const totalGoals = s.gh + s.ga;
    if (totalGoals >= 3) pOver25 += s.p;
    if (s.gh > 0 && s.ga > 0) pBTTS += s.p;
  }

  return {
    xgHome,
    xgAway,
    over25Prob: clamp(Math.round(pOver25 * 100), 0, 100),
    bttsProb: clamp(Math.round(pBTTS * 100), 0, 100),
    correctScoreTop3: top3,
  };
}

function generatePrediction(match, strengths = {}, formStats = {}) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";
  const leagueCode = match?.competition?.code || "DEFAULT";
  const leagueProfile = LEAGUE_PROFILE[leagueCode] || LEAGUE_PROFILE.DEFAULT;

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

  // Elo
  const eloHome = formHome.elo ?? 1500;
  const eloAway = formAway.elo ?? 1500;
  const eloDiff = (eloHome - eloAway) / 400;

  const eloFactorHome = clamp(1 + eloDiff * 0.25, 0.75, 1.3);
  const eloFactorAway = clamp(1 - eloDiff * 0.25, 0.75, 1.3);

  strengthHome *= eloFactorHome;
  strengthAway *= eloFactorAway;

  // avantaj teren
  const homeAdvantage = 0.15 * leagueProfile.pace;
  strengthHome += homeAdvantage;

  if (BIG_TEAMS.includes(homeName)) strengthHome += 0.22;
  if (BIG_TEAMS.includes(awayName)) strengthAway += 0.22;

  const strengthDiff = Math.abs(strengthHome - strengthAway);
  const closeness = clamp(1 - strengthDiff, 0, 1);

  const baseDrawProb = 0.18 + 0.18 * closeness;
  const nonDrawProb = 1 - baseDrawProb;
  const sumStrength = strengthHome + strengthAway || 1;

  let rawHome = (strengthHome / sumStrength) * nonDrawProb;
  let rawAway = (strengthAway / sumStrength) * nonDrawProb;
  let rawDraw = baseDrawProb;

  const noiseHome = (prngForMatch(match, "home") - 0.5) * 0.05;
  const noiseAway = (prngForMatch(match, "away") - 0.5) * 0.05;
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
    formHome.overallGf ?? formHome.homeGf ?? leagueProfile.goalsAvg / 2;
  const overallGfAway =
    formAway.overallGf ?? formAway.awayGf ?? leagueProfile.goalsAvg / 2;
  const overallGaHome =
    formHome.overallGa ?? formHome.homeGa ?? leagueProfile.goalsAvg / 2;
  const overallGaAway =
    formAway.overallGa ?? formAway.awayGa ?? leagueProfile.goalsAvg / 2;

  const baseLeagueGoals = leagueProfile.goalsAvg;

  let xgHome =
    baseLeagueGoals *
    0.55 *
    (overallGfHome + 0.5) /
    (overallGfHome + overallGfAway + 1);
  let xgAway =
    baseLeagueGoals *
    0.45 *
    (overallGfAway + 0.5) /
    (overallGfHome + overallGfAway + 1);

  const eloScale = clamp(1 + eloDiff * 0.20, 0.7, 1.3);
  if (eloScale > 1) {
    xgHome *= eloScale;
  } else {
    xgAway /= eloScale;
  }

  xgHome = clamp(xgHome, 0.3, 3.0);
  xgAway = clamp(xgAway, 0.2, 2.8);

  const paceFactor = leagueProfile.pace;
  xgHome *= paceFactor;
  xgAway *= paceFactor;

  const xgResult = computeXgAndScoreProb(xgHome, xgAway, 4);

  const attackIndexBase = (probHome + probAway) / 200;
  const attackGoalsFactor = clamp(
    (overallGfHome + overallGfAway) / (2 * (baseLeagueGoals / 2)),
    0.6,
    1.4
  );
  const attackIndex = clamp(
    attackIndexBase * attackGoalsFactor * paceFactor,
    0,
    1
  );

  const goalsOver25 = xgResult.over25Prob;
  const goalsUnder25 = 100 - goalsOver25;
  const bttsYes = xgResult.bttsProb;
  const bttsNo = 100 - bttsYes;

  const leagueCorners = leagueProfile.cornersAvg;
  let cornersBase = leagueCorners / 11;
  cornersBase *= 0.9 + attackIndex * 0.4;
  const cornersNoise = (prngForMatch(match, "corners") - 0.5) * 0.12;
  let cornersOver = clamp(
    (cornersBase + cornersNoise) * 10,
    0.25,
    0.9
  );
  let cornersUnder = 1 - cornersOver;

  const leagueCards = leagueProfile.cardsAvg;
  const leagueFouls = leagueProfile.foulsAvg;
  const defenseRoughness = clamp(
    (overallGaHome + overallGaAway) / (2 * (baseLeagueGoals / 2)),
    0.6,
    1.5
  );

  let cardsBase =
    (leagueCards / 10) * (0.9 + (1 - closeness) * 0.3) * defenseRoughness;
  const cardsNoise = (prngForMatch(match, "cards") - 0.5) * 0.18;
  let cardsOver = clamp(cardsBase + cardsNoise, 0.20, 0.90);
  let cardsUnder = 1 - cardsOver;

  let foulsHomeMore =
    0.5 +
    (prngForMatch(match, "fouls-home") - 0.5) * 0.2 +
    (strengthHome - strengthAway) * 0.05;
  foulsHomeMore = clamp(foulsHomeMore, 0.3, 0.7);
  let foulsAwayMore = 1 - foulsHomeMore;

  let shotsBase =
    (leagueProfile.shotsAvg / 25) *
    (0.85 + attackIndex * 0.6) *
    attackGoalsFactor;
  const shotsNoise = (prngForMatch(match, "shots") - 0.5) * 0.15;
  let shotsOver = clamp(shotsBase + shotsNoise, 0.3, 0.92);
  let shotsUnder = 1 - shotsOver;

  const xgTotal = xgResult.xgHome + xgResult.xgAway;
  let intensity =
    0.4 * attackIndex +
    0.25 * (leagueProfile.pace - 0.8) / 0.5 +
    0.2 * (xgTotal / 3.0) +
    0.15 * ((leagueCorners - 8) / 4);
  intensity = clamp(Math.round(intensity * 100), 10, 95);

  let riskScore = 0;
  riskScore += (1 - margin) * 0.5;
  riskScore += closeness * 0.3;
  const formVolatility =
    Math.abs(homePpm - ppmMid) + Math.abs(awayPpm - ppmMid);
  riskScore += clamp(formVolatility / 3, 0, 0.2);
  riskScore = clamp(riskScore, 0, 1);
  const riskLevelNum = Math.round(riskScore * 100);
  let riskLabel = "scăzut";
  if (riskLevelNum >= 66) riskLabel = "ridicat";
  else if (riskLevelNum >= 33) riskLabel = "mediu";

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence,

    goals: {
      over25: goalsOver25,
      under25: goalsUnder25,
      bttsYes,
      bttsNo,
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

    xg: {
      home: Number(xgResult.xgHome.toFixed(2)),
      away: Number(xgResult.xgAway.toFixed(2)),
      total: Number((xgResult.xgHome + xgResult.xgAway).toFixed(2)),
    },

    correctScore: {
      top3: xgResult.correctScoreTop3,
    },

    meta: {
      intensity,
      riskLevel: riskLevelNum,
      riskLabel,
      leagueCode,
    },
  };
}

// competiții
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

// meciuri + predicții
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
    const formStats = await getTeamFormAndElo(competitionId);

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
