import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// ping simplu
app.get("/", (req, res) => {
  res.send("Football backend OK - model realist");
});

// helper clamp
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// factorial mic pentru Poisson
const FACT = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];

function poisson(lambda, k) {
  if (k < 0) return 0;
  if (k < FACT.length) {
    return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k];
  }
  let fact = FACT[FACT.length - 1];
  for (let i = FACT.length; i <= k; i++) {
    fact *= i;
  }
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

/**
 * Profiluri aproximative pe ligă
 * valorile sunt medii realiste, nu exacte,
 * dar țin predicțiile în intervale normale.
 */
const LEAGUE_PROFILES = {
  PL:  { goals: 2.9, shots: 26, corners: 10, fouls: 21, cards: 3.8 },
  PD:  { goals: 2.5, shots: 24, corners: 9,  fouls: 26, cards: 5.1 },
  SA:  { goals: 2.7, shots: 25, corners: 9,  fouls: 27, cards: 4.8 },
  BL1: { goals: 3.1, shots: 27, corners: 10, fouls: 21, cards: 3.6 },
  FL1: { goals: 2.6, shots: 24, corners: 9,  fouls: 24, cards: 4.0 },
  DED: { goals: 3.0, shots: 26, corners: 10, fouls: 22, cards: 3.5 },
  PPL: { goals: 2.5, shots: 23, corners: 9,  fouls: 28, cards: 5.2 },
  CL:  { goals: 3.0, shots: 27, corners: 10, fouls: 23, cards: 4.3 },
};

const DEFAULT_LEAGUE = { goals: 2.7, shots: 24, corners: 9, fouls: 24, cards: 4.3 };

/**
 * Ratinguri echipă din clasament:
 * - attack: cât de mult marchează vs media ligii
 * - defense: cât de puțin primește vs media ligii
 */
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

  const avgGFpg = count ? sumGFpg / count : 1.35;
  const avgGApg = count ? sumGApg / count : 1.35;

  const ratings = {};

  for (const row of table) {
    if (!row.team || !row.team.id || row.playedGames === 0) continue;

    const gfpg = row.goalsFor / row.playedGames;
    const gapg = row.goalsAgainst / row.playedGames || avgGApg;

    const attackRating = clamp(gfpg / (avgGFpg || 1), 0.85, 1.15);
    const defenseRating = clamp((avgGApg || 1) / gapg, 0.85, 1.15);

    ratings[row.team.id] = {
      attack: attackRating,
      defense: defenseRating,
    };
  }

  return ratings;
}

/**
 * Din λ_home și λ_away calculăm:
 * - 1X2
 * - over/under 2.5
 * - BTTS
 * - top 3 scoruri corecte
 */
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
  const confidence = clamp(Math.round(arr[0].val), 45, 85);

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

/**
 * Predicție realistă pentru un meci:
 * - bazat pe profil ligă + ratinguri echipă
 * - totul fără random
 */
function generatePrediction(match, leagueCfg, ratings) {
  const code = match.competition?.code;
  const league = leagueCfg || DEFAULT_LEAGUE;

  const homeTeam = match.homeTeam;
  const awayTeam = match.awayTeam;

  const homeRating = ratings[homeTeam?.id] || { attack: 1.0, defense: 1.0 };
  const awayRating = ratings[awayTeam?.id] || { attack: 1.0, defense: 1.0 };

  const homeBias = 0.56; // goluri pe meci pentru gazde
  const awayBias = 0.44;

  let lambdaHome =
    league.goals * homeBias * homeRating.attack * awayRating.defense;
  let lambdaAway =
    league.goals * awayBias * awayRating.attack * homeRating.defense;

  lambdaHome = clamp(lambdaHome, 0.4, 2.5);
  lambdaAway = clamp(lambdaAway, 0.3, 2.2);

  const totalLambda = lambdaHome + lambdaAway;

  const base = computeFromLambdas(lambdaHome, lambdaAway);

  // echilibru: meciuri echilibrate => risc mai mare
  const strengthDiff =
    Math.abs(homeRating.attack - awayRating.attack) +
    Math.abs(homeRating.defense - awayRating.defense); // 0..~0.6

  const balance = clamp(1 - strengthDiff * 1.2, 0, 1); // 1 = echilibrat
  let risk =
    40 + balance * 30 + (totalLambda - league.goals) * 8; // 40–70+ajustare
  risk = clamp(Math.round(risk), 25, 80);

  let intensity =
    45 +
    (totalLambda / league.goals - 1) * 25 +
    (league.shots / 24 - 1) * 10;
  intensity = clamp(Math.round(intensity), 30, 85);

  let riskLabel = "mediu";
  if (risk <= 33) riskLabel = "scăzut";
  else if (risk >= 67) riskLabel = "ridicat";

  // ȘUTURI TOTALE (număr minim)
  let expectedShots = league.shots * (totalLambda / league.goals);
  expectedShots = clamp(expectedShots, 18, 32);
  const shotsMin = clamp(Math.round(expectedShots * 0.75), 15, 28);

  // CORNERE
  let expectedCorners = league.corners * (totalLambda / league.goals);
  expectedCorners = clamp(expectedCorners, 7, 12);

  let pOverCorners =
    35 + (expectedCorners - 9.5) * 10 + (intensity - 55) * 0.3;
  pOverCorners = clamp(Math.round(pOverCorners), 10, 80);

  // FAULTURI (număr minim)
  let expectedFouls =
    league.fouls * (1 + (risk - 50) / 200); // 0.75–1.25
  expectedFouls = clamp(expectedFouls, 20, 34);
  const foulsMin = clamp(Math.round(expectedFouls * 0.8), 18, 30);

  // CARTONAȘE
  let expectedCards =
    league.cards * (expectedFouls / league.fouls);
  expectedCards = clamp(expectedCards, 3, 6.5);

  let pOverCards =
    40 + (expectedCards - 4.5) * 18 + (risk - 50) * 0.3;
  pOverCards = clamp(Math.round(pOverCards), 10, 85);

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

    fouls: {
      minTotal: foulsMin,
    },

    shots: {
      minTotal: shotsMin,
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

/*───────────────────────────────────────────────
  API ROUTES
────────────────────────────────────────────────*/

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

// 2. Meciuri pentru ligă + predicții
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

    const matchesData = await matchesResp.json();
    const matchesRaw = matchesData.matches || [];
    const competitionCode = matchesData.competition?.code;

    let standingsData = null;
    if (standingsResp.ok) {
      standingsData = await standingsResp.json();
    }

    const ratings = buildTeamRatingsFromStandings(standingsData?.standings);
    const leagueCfg =
      (competitionCode && LEAGUE_PROFILES[competitionCode]) || DEFAULT_LEAGUE;

    const matches = matchesRaw.map((m) => {
      const prediction = generatePrediction(m, leagueCfg, ratings);

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
