import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// Root simplu, pentru verificare
app.get("/", (req, res) => {
  res.send("Football backend OK (model Poisson + ligi)");
});

// helper clamp
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// factorial mic pentru Poisson
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040];

function poisson(lambda, k) {
  if (k < 0) return 0;
  if (k < FACT.length) {
    return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
  }
  // fallback simplu
  let fact = FACT[FACT.length - 1];
  for (let i = FACT.length; i <= k; i++) {
    fact *= i;
  }
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

// profil de ligă (medii aproximative)
const LEAGUE_PROFILES = {
  PL: { baseGoals: 2.9, shotsPerGoal: 9.0, cornersPerGoal: 3.0, baseFouls: 23, baseCards: 4.1 },
  PD: { baseGoals: 2.5, shotsPerGoal: 8.5, cornersPerGoal: 2.8, baseFouls: 25, baseCards: 5.0 },
  SA: { baseGoals: 2.6, shotsPerGoal: 8.7, cornersPerGoal: 2.9, baseFouls: 26, baseCards: 4.8 },
  BL1: { baseGoals: 3.0, shotsPerGoal: 9.5, cornersPerGoal: 3.1, baseFouls: 22, baseCards: 4.0 },
  FL1: { baseGoals: 2.6, shotsPerGoal: 8.8, cornersPerGoal: 3.0, baseFouls: 24, baseCards: 4.2 },
  DED: { baseGoals: 3.0, shotsPerGoal: 9.3, cornersPerGoal: 3.0, baseFouls: 22, baseCards: 3.8 },
  PPL: { baseGoals: 2.5, shotsPerGoal: 8.5, cornersPerGoal: 2.7, baseFouls: 27, baseCards: 5.2 },
  CL: { baseGoals: 3.0, shotsPerGoal: 9.8, cornersPerGoal: 3.2, baseFouls: 23, baseCards: 4.4 },
};

// construim profil ligă din standings dacă avem date
function buildLeagueProfileFromStandings(competitionCode, standings) {
  const base = LEAGUE_PROFILES[competitionCode] || {
    baseGoals: 2.7,
    shotsPerGoal: 9.0,
    cornersPerGoal: 3.0,
    baseFouls: 24,
    baseCards: 4.5,
  };

  if (!standings || !standings.length) return base;

  const table = standings[0]?.table || [];
  if (!table.length) return base;

  let sumGF = 0;
  let sumGA = 0;
  let sumMatches = 0;

  for (const row of table) {
    sumGF += row.goalsFor || 0;
    sumGA += row.goalsAgainst || 0;
    sumMatches += row.playedGames || 0;
  }

  if (sumMatches > 0) {
    const avgGoalsPerMatch = (sumGF + sumGA) / (2 * sumMatches) * 2; // aproximare
    return {
      ...base,
      baseGoals: clamp(avgGoalsPerMatch, 2.0, 3.5),
    };
  }

  return base;
}

// ratinguri echipă din clasament
function buildTeamRatingsFromStandings(standings) {
  const table = standings?.[0]?.table || [];
  if (!table.length) return {};

  let sumGFpg = 0;
  let sumGApg = 0;
  let count = 0;

  for (const row of table) {
    if (row.playedGames > 0) {
      const gfpg = row.goalsFor / row.playedGames;
      const gapg = row.goalsAgainst / row.playedGames;
      sumGFpg += gfpg;
      sumGApg += gapg;
      count++;
    }
  }

  const avgGFpg = count ? sumGFpg / count : 1.3;
  const avgGApg = count ? sumGApg / count : 1.3;

  const ratings = {};

  for (const row of table) {
    if (!row.team || !row.team.id || row.playedGames === 0) continue;

    const gfpg = row.goalsFor / row.playedGames;
    const gapg = row.goalsAgainst / row.playedGames;

    const attackRating = clamp(gfpg / (avgGFpg || 1.0), 0.7, 1.4);
    const defenseRating = clamp((avgGApg || 1.0) / (gapg || avgGApg || 1.0), 0.7, 1.4);

    ratings[row.team.id] = {
      attack: attackRating,
      defense: defenseRating,
    };
  }

  return ratings;
}

// calculează 1X2 + over/BTTS din λ_home / λ_away
function computeFromLambdas(lambdaHome, lambdaAway) {
  const maxGoals = 6;
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let pOver25 = 0;
  let pBTTS = 0;

  const scoreMap = new Map();

  for (let h = 0; h <= maxGoals; h++) {
    const ph = poisson(lambdaHome, h);
    for (let a = 0; a <= maxGoals; a++) {
      const pa = poisson(lambdaAway, a);
      const p = ph * pa;

      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      if (h + a >= 3) pOver25 += p;
      if (h >= 1 && a >= 1) pBTTS += p;

      const key = `${h}-${a}`;
      scoreMap.set(key, (scoreMap.get(key) || 0) + p);
    }
  }

  let total1x2 = pHome + pDraw + pAway;
  if (total1x2 <= 0) total1x2 = 1;

  const probHome = (pHome / total1x2) * 100;
  const probDraw = (pDraw / total1x2) * 100;
  const probAway = (pAway / total1x2) * 100;

  const arr = [
    { key: "HOME", val: probHome },
    { key: "DRAW", val: probDraw },
    { key: "AWAY", val: probAway },
  ];
  arr.sort((a, b) => b.val - a.val);
  const mainPick = arr[0].key;
  const confidence = clamp(Math.round(arr[0].val), 40, 90);

  const scoreArr = [];
  for (const [key, val] of scoreMap.entries()) {
    const [gh, ga] = key.split("-").map(Number);
    const prob = val * 100;
    scoreArr.push({
      score: `${gh}-${ga}`,
      prob,
    });
  }
  scoreArr.sort((a, b) => b.prob - a.prob);
  const top3 = scoreArr.slice(0, 3).map((s) => ({
    score: s.score,
    prob: Math.round(s.prob),
  }));

  return {
    probHome: Math.round(probHome),
    probDraw: Math.round(probDraw),
    probAway: Math.round(probAway),
    mainPick,
    confidence,
    goals: {
      over25: Math.round(pOver25 * 100),
      under25: Math.round((1 - pOver25) * 100),
      bttsYes: Math.round(pBTTS * 100),
      bttsNo: Math.round((1 - pBTTS) * 100),
    },
    correctScoreTop3: top3,
  };
}

// generație prediction pentru un meci
function generatePrediction(match, leagueProfile, ratings) {
  const code = match.competition?.code;
  const leagueCfg = LEAGUE_PROFILES[code] || leagueProfile || {
    baseGoals: 2.7,
    shotsPerGoal: 9.0,
    cornersPerGoal: 3.0,
    baseFouls: 24,
    baseCards: 4.5,
  };

  const homeTeam = match.homeTeam;
  const awayTeam = match.awayTeam;

  const homeRating = ratings[homeTeam?.id] || { attack: 1.0, defense: 1.0 };
  const awayRating = ratings[awayTeam?.id] || { attack: 1.0, defense: 1.0 };

  const homeAdv = 1.15;

  const lambdaHome =
    leagueCfg.baseGoals * homeRating.attack * awayRating.defense * homeAdv;
  const lambdaAway =
    leagueCfg.baseGoals * awayRating.attack * homeRating.defense;

  const base = computeFromLambdas(lambdaHome, lambdaAway);

  const totalLambda = lambdaHome + lambdaAway;

  // intensitate
  let intensity =
    (totalLambda / leagueCfg.baseGoals) * 60 +
    base.goals.bttsYes * 0.2 / 100 +
    leagueCfg.shotsPerGoal * 2;
  intensity = clamp(Math.round(intensity), 20, 95);

  // risc: invers de încredere, ajustat după cât de apropiat e restul
  const secondBest = [base.probHome, base.probDraw, base.probAway]
    .sort((a, b) => b - a)[1];
  let risk =
    100 - base.confidence +
    Math.max(0, 15 - (base.confidence - secondBest));
  risk = clamp(Math.round(risk), 15, 90);

  let riskLabel = "mediu";
  if (risk <= 33) riskLabel = "scăzut";
  else if (risk >= 67) riskLabel = "ridicat";

  // cornere
  const predictedCorners = totalLambda * leagueCfg.cornersPerGoal;
  let pOverCorners =
    40 + (predictedCorners - 9.5) * 8 + (intensity - 50) * 0.3;
  pOverCorners = clamp(Math.round(pOverCorners), 15, 90);

  // cartonașe
  const predictedCards =
    leagueCfg.baseCards * (1 + (risk - 50) / 200);
  let pOverCards =
    45 + (predictedCards - 4.5) * 12 + (risk - 50) * 0.3;
  pOverCards = clamp(Math.round(pOverCards), 15, 90);

  // faulturi: număr minim
  let foulsMin =
    leagueCfg.baseFouls * (0.9 + (risk / 100) * 0.5 + (intensity - 50) / 300);
  foulsMin = clamp(Math.round(foulsMin), 18, 40);

  // șuturi: număr minim
  let shotsTotal =
    totalLambda * leagueCfg.shotsPerGoal * (0.9 + intensity / 200);
  shotsTotal = clamp(Math.round(shotsTotal), 15, 40);

  return {
    probHome: base.probHome,
    probDraw: base.probDraw,
    probAway: base.probAway,
    mainPick: base.mainPick,
    confidence: base.confidence,

    goals: base.goals,

    corners: {
      over9_5: pOverCorners,
      under9_5: 100 - pOverCorners,
    },

    cards: {
      over4_5: pOverCards,
      under4_5: 100 - pOverCards,
    },

    // aici nu mai dăm procente, ci număr minim recomandat
    fouls: {
      minTotal: foulsMin,
    },

    shots: {
      minTotal: shotsTotal,
    },

    xg: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2)),
      total: Number((lambdaHome + lambdaAway).toFixed(2)),
    },

    correctScore: {
      top3: base.correctScoreTop3,
    },

    meta: {
      intensity,
      riskLevel: risk,
      riskLabel,
      leagueCode: code || "",
    },
  };
}

// 1. Lista de competiții
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
        .json({ error: "Eroare de la football-data.org", status: response.status });
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

// 2. Meciuri cu model nou
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res.status(400).json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const matchesUrl = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const [matchesResp, standingsResp] = await Promise.all([
      fetch(matchesUrl, { headers: { "X-Auth-Token": API_KEY } }),
      fetch(`${API_BASE}/competitions/${competitionId}/standings`, {
        headers: { "X-Auth-Token": API_KEY },
      }),
    ]);

    if (!matchesResp.ok) {
      const text = await matchesResp.text();
      console.error("Eroare la /matches:", matchesResp.status, text);
      return res
        .status(matchesResp.status)
        .json({ error: "Eroare de la football-data.org", status: matchesResp.status });
    }

    let standingsData = null;
    if (standingsResp.ok) {
      standingsData = await standingsResp.json();
    }

    const matchesData = await matchesResp.json();
    const matchesRaw = matchesData.matches || [];
    const competitionCode = matchesData.competition?.code;

    const leagueProfile = buildLeagueProfileFromStandings(
      competitionCode,
      standingsData?.standings
    );
    const ratings = buildTeamRatingsFromStandings(standingsData?.standings);

    const matches = matchesRaw.map((m) => {
      const prediction = generatePrediction(m, leagueProfile, ratings);

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction,
      };
    });

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    res.status(500).json({ error: "Eroare internă server" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
