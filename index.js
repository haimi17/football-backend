import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Football backend OK - model bazat pe forma recentă (1X2, Over 2.5, BTTS)");
});

// Helper clamp
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

// construim statistici de formă pe baza meciurilor jucate
function buildTeamFormStats(matches) {
  const teamStats = {};
  let leagueGoals = 0;
  let leagueMatches = 0;

  for (const m of matches) {
    if (m.status !== "FINISHED") continue;

    const homeId = m.homeTeam?.id;
    const awayId = m.awayTeam?.id;
    const homeGoals = m.score?.fullTime?.home ?? 0;
    const awayGoals = m.score?.fullTime?.away ?? 0;

    if (homeId == null || awayId == null) continue;

    leagueGoals += homeGoals + awayGoals;
    leagueMatches += 1;

    if (!teamStats[homeId]) {
      teamStats[homeId] = {
        matches: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        over25: 0,
        btts: 0,
      };
    }
    if (!teamStats[awayId]) {
      teamStats[awayId] = {
        matches: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        over25: 0,
        btts: 0,
      };
    }

    const hs = teamStats[homeId];
    const as = teamStats[awayId];

    hs.matches += 1;
    hs.goalsFor += homeGoals;
    hs.goalsAgainst += awayGoals;

    as.matches += 1;
    as.goalsFor += awayGoals;
    as.goalsAgainst += homeGoals;

    if (homeGoals > awayGoals) {
      hs.wins += 1;
      as.losses += 1;
    } else if (homeGoals < awayGoals) {
      as.wins += 1;
      hs.losses += 1;
    } else {
      hs.draws += 1;
      as.draws += 1;
    }

    if (homeGoals + awayGoals >= 3) {
      hs.over25 += 1;
      as.over25 += 1;
    }

    if (homeGoals >= 1 && awayGoals >= 1) {
      hs.btts += 1;
      as.btts += 1;
    }
  }

  const leagueGoalsPerMatch =
    leagueMatches > 0 ? leagueGoals / leagueMatches : 2.7;

  return { teamStats, leagueGoalsPerMatch };
}

// Poisson 1X2 + Over 2.5 + BTTS + scoruri probabile
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
  const confidenceBase = arr[0].val;
  const second = arr[1].val;

  // dacă diferența față de a doua opțiune e mică, scădem încrederea
  const diff = confidenceBase - second;
  let confidence = confidenceBase - Math.max(0, 15 - diff);
  confidence = clamp(Math.round(confidence), 40, 80);

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

// Predicție pentru un meci folosind forma echipelor
function generatePrediction(match, teamStats, leagueGoalsPerMatch) {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;

  const hs = (homeId && teamStats[homeId]) || null;
  const as = (awayId && teamStats[awayId]) || null;

  const lg = leagueGoalsPerMatch || 2.7;

  function safeAvg(stat, matches) {
    if (!matches || matches === 0) return null;
    return stat / matches;
  }

  const homeGF = hs ? safeAvg(hs.goalsFor, hs.matches) : null;
  const homeGA = hs ? safeAvg(hs.goalsAgainst, hs.matches) : null;
  const awayGF = as ? safeAvg(as.goalsFor, as.matches) : null;
  const awayGA = as ? safeAvg(as.goalsAgainst, as.matches) : null;

  const baseHome =
    (homeGF ?? lg * 0.55) * 0.6 +
    (awayGA ?? lg * 0.45) * 0.4;
  const baseAway =
    (awayGF ?? lg * 0.45) * 0.6 +
    (homeGA ?? lg * 0.55) * 0.4;

  let lambdaHome = baseHome;
  let lambdaAway = baseAway;

  // scalare la media ligii + avantaj teren propriu
  let rawTotal = lambdaHome + lambdaAway;
  if (rawTotal <= 0) {
    lambdaHome = lg * 0.55;
    lambdaAway = lg * 0.45;
    rawTotal = lambdaHome + lambdaAway;
  }

  const scale = lg / rawTotal;
  lambdaHome = lambdaHome * scale * 1.1; // avantaj gazdă
  lambdaAway = lambdaAway * scale * 0.9;

  lambdaHome = clamp(lambdaHome, 0.3, 2.8);
  lambdaAway = clamp(lambdaAway, 0.2, 2.5);

  const base = computeFromLambdas(lambdaHome, lambdaAway);

  const explainHome = {
    matches: hs?.matches ?? 0,
    avgGF: hs && hs.matches ? Number((hs.goalsFor / hs.matches).toFixed(2)) : null,
    avgGA: hs && hs.matches ? Number((hs.goalsAgainst / hs.matches).toFixed(2)) : null,
    over25Rate:
      hs && hs.matches ? Math.round((hs.over25 / hs.matches) * 100) : null,
    bttsRate:
      hs && hs.matches ? Math.round((hs.btts / hs.matches) * 100) : null,
    winRate:
      hs && hs.matches ? Math.round((hs.wins / hs.matches) * 100) : null,
  };

  const explainAway = {
    matches: as?.matches ?? 0,
    avgGF: as && as.matches ? Number((as.goalsFor / as.matches).toFixed(2)) : null,
    avgGA: as && as.matches ? Number((as.goalsAgainst / as.matches).toFixed(2)) : null,
    over25Rate:
      as && as.matches ? Math.round((as.over25 / as.matches) * 100) : null,
    bttsRate:
      as && as.matches ? Math.round((as.btts / as.matches) * 100) : null,
    winRate:
      as && as.matches ? Math.round((as.wins / as.matches) * 100) : null,
  };

  return {
    probHome: base.probHome,
    probDraw: base.probDraw,
    probAway: base.probAway,
    mainPick: base.mainPick,
    confidence: base.confidence,
    goals: base.goals,
    xg: {
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2)),
      total: Number((lambdaHome + lambdaAway).toFixed(2)),
    },
    correctScore: {
      top3: base.correctScoreTop3,
    },
    explain: {
      leagueGoalsPerMatch: Number(lg.toFixed(2)),
      home: explainHome,
      away: explainAway,
    },
  };
}

/*───────────────────────────────────────────────
  ROUTE: COMPETITIONS
────────────────────────────────────────────────*/

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

/*───────────────────────────────────────────────
  ROUTE: MATCHES CU PREDICȚII
────────────────────────────────────────────────*/

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

    // interval viitor: următoarele 7 zile
    const futureFrom = today.toISOString().slice(0, 10);
    const futureToDate = new Date(today);
    futureToDate.setDate(today.getDate() + 7);
    const futureTo = futureToDate.toISOString().slice(0, 10);

    // interval trecut: ultimele 60 de zile pentru formă
    const pastToDate = new Date(today);
    pastToDate.setDate(today.getDate() - 1);
    const pastTo = pastToDate.toISOString().slice(0, 10);

    const pastFromDate = new Date(today);
    pastFromDate.setDate(today.getDate() - 60);
    const pastFrom = pastFromDate.toISOString().slice(0, 10);

    const futureUrl = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${futureFrom}&dateTo=${futureTo}`;
    const pastUrl = `${API_BASE}/competitions/${competitionId}/matches?status=FINISHED&dateFrom=${pastFrom}&dateTo=${pastTo}`;

    const [futureResp, pastResp] = await Promise.all([
      fetch(futureUrl, { headers: { "X-Auth-Token": API_KEY } }),
      fetch(pastUrl, { headers: { "X-Auth-Token": API_KEY } }),
    ]);

    if (!futureResp.ok) {
      const text = await futureResp.text();
      console.error("Eroare la /matches viitoare:", futureResp.status, text);
      return res
        .status(futureResp.status)
        .json({ error: "Eroare de la football-data.org (viitor)", status: futureResp.status });
    }

    const futureData = await futureResp.json();
    const futureMatches = futureData.matches || [];

    let teamStats = {};
    let leagueGoalsPerMatch = 2.7;

    if (pastResp.ok) {
      const pastData = await pastResp.json();
      const pastMatches = pastData.matches || [];
      const built = buildTeamFormStats(pastMatches);
      teamStats = built.teamStats;
      leagueGoalsPerMatch = built.leagueGoalsPerMatch;
    }

    const result = futureMatches.map((m) => {
      const prediction = generatePrediction(m, teamStats, leagueGoalsPerMatch);

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction,
      };
    });

    res.json(result);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    res.status(500).json({ error: "Eroare internă server" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
