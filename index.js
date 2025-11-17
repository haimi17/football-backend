import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// ---------------- CACHE SIMPLU ÎN MEMORIE ----------------

const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const cache = {
  competitions: {
    timestamp: 0,
    data: null,
  },
  matches: {
    // competitionId: { timestamp, data }
  },
};

function isCacheValid(entry) {
  if (!entry) return false;
  const age = Date.now() - entry.timestamp;
  return age < CACHE_TTL_MS;
}

// ---------------- HELPERI PENTRU PREDICȚII ----------------

// rating simplu din numele echipei (determinist)
function teamRating(name) {
  if (!name) return 1500;
  let sum = 0;
  for (let i = 0; i < name.length; i++) {
    sum += name.charCodeAt(i);
  }
  return 1400 + (sum % 400); // între ~1400 și 1800
}

// calculează probabilități 1X2 din rating
function baseProbabilities(homeName, awayName) {
  const homeR = teamRating(homeName);
  const awayR = teamRating(awayName);
  const diff = homeR - awayR;

  // logistic simplu pentru șanse de victorie acasă
  const homeWinBase = 1 / (1 + Math.exp(-diff / 400));
  const awayWinBase = 1 - homeWinBase;

  let pHome = 0.45 * homeWinBase + 0.20; // între ~0.20–0.65
  let pAway = 0.45 * awayWinBase + 0.15; // între ~0.15–0.60
  let pDraw = 1 - pHome - pAway;

  if (pDraw < 0.15) pDraw = 0.15;
  if (pDraw > 0.35) pDraw = 0.35;

  const sum = pHome + pDraw + pAway;
  pHome /= sum;
  pDraw /= sum;
  pAway /= sum;

  return { pHome, pDraw, pAway };
}

// mică variație random, ca să nu fie identic la toate meciurile
function addNoise(prob, noise = 0.03) {
  const delta = (Math.random() * 2 - 1) * noise;
  let v = prob + delta;
  if (v < 0.05) v = 0.05;
  if (v > 0.9) v = 0.9;
  return v;
}

// ELO „vizibil” în front-end
function eloSummary(homeName, awayName) {
  const homeR = teamRating(homeName);
  const awayR = teamRating(awayName);
  const diff = homeR - awayR;

  let fav = "Echipe echilibrate";
  if (diff > 60) fav = "Gazdele au avantaj ELO";
  if (diff < -60) fav = "Oaspeții au avantaj ELO";

  return {
    homeRating: homeR,
    awayRating: awayR,
    diff,
    summary: fav,
  };
}

// generează predicția completă pentru un meci
function generatePrediction(match) {
  const homeName = match?.homeTeam?.name || "Home";
  const awayName = match?.awayTeam?.name || "Away";

  const base = baseProbabilities(homeName, awayName);

  // aplicăm zgomot mic, apoi renormalizăm
  let pHome = addNoise(base.pHome);
  let pDraw = addNoise(base.pDraw);
  let pAway = addNoise(base.pAway);

  const sum = pHome + pDraw + pAway;
  pHome /= sum;
  pDraw /= sum;
  pAway /= sum;

  let probHome = Math.round(pHome * 100);
  let probDraw = Math.round(pDraw * 100);
  let probAway = Math.round(pAway * 100);

  // ajustare să fie exact 100
  let total = probHome + probDraw + probAway;
  if (total !== 100) {
    const diff = 100 - total;
    if (probHome >= probDraw && probHome >= probAway) {
      probHome += diff;
    } else if (probAway >= probHome && probAway >= probDraw) {
      probAway += diff;
    } else {
      probDraw += diff;
    }
  }

  const arr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...arr);

  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  // „încredere” între 40 și 90 în funcție de cât de clară e diferența
  let confidence = 40 + Math.round((maxProb - 33) * 1.0);
  if (confidence < 40) confidence = 40;
  if (confidence > 90) confidence = 90;

  // markets goluri
  const expectedGoals = 2.4 + (maxProb - 33) * 0.02; // 2.0–3.0
  const over25 = Math.round(40 + (expectedGoals - 2.4) * 25 + Math.random() * 10);
  const under25 = 100 - over25;
  const bttsYes = Math.round(50 + (expectedGoals - 2.4) * 20 + (pDraw - 0.3) * 50);
  const bttsNo = 100 - bttsYes;

  // cornere și cartonase, variație mică pe meci
  const baseCorners = 9 + (expectedGoals - 2.4) * 2;
  const over95Corners = Math.round(45 + (baseCorners - 9) * 10 + Math.random() * 10);
  const under95Corners = 100 - over95Corners;

  const baseCards = 4 + Math.abs(teamRating(homeName) - teamRating(awayName)) / 600;
  const over45Cards = Math.round(50 + (baseCards - 4) * 15 + Math.random() * 10);
  const under45Cards = 100 - over45Cards;

  // xG simplu
  const xgHome = +(expectedGoals * (probHome / (probHome + probAway))).toFixed(2);
  const xgAway = +(expectedGoals * (probAway / (probHome + probAway))).toFixed(2);

  // scor corect – 3 scenarii de bază
  const correctScore = {
    top3: [
      { score: "1-1", prob: 10 + Math.round(pDraw / 5) },
      { score: "2-1", prob: 8 + Math.round(pHome / 7) },
      { score: "1-2", prob: 8 + Math.round(pAway / 7) },
    ],
  };

  const elo = eloSummary(homeName, awayName);

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,
    confidence,
    goals: {
      over25,
      under25,
      bttsYes,
      bttsNo,
    },
    corners: {
      over9_5: over95Corners,
      under9_5: under95Corners,
    },
    cards: {
      over4_5: over45Cards,
      under4_5: under45Cards,
    },
    xg: {
      home: xgHome,
      away: xgAway,
      total: +(xgHome + xgAway).toFixed(2),
    },
    correctScore,
    elo,
    explain: {
      leagueGoalsPerMatch: expectedGoals.toFixed(2),
      comment:
        "Model bazat pe rating ELO derivat din numele echipelor + ajustări statistice simple.",
    },
  };
}

// ---------------- ROUTE ROOT ----------------

app.get("/", (req, res) => {
  res.send("Football backend OK");
});

// ---------------- /api/competitions ----------------

app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    // cache
    if (isCacheValid(cache.competitions)) {
      return res.json(cache.competitions.data);
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

    cache.competitions = {
      timestamp: Date.now(),
      data: filtered,
    };

    res.json(filtered);
  } catch (err) {
    console.error("Eroare server /api/competitions:", err);
    res.status(500).json({ error: "Eroare internă server competiții" });
  }
});

// ---------------- /api/matches ----------------

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

    const cached = cache.matches[competitionId];
    if (isCacheValid(cached)) {
      return res.json(cached.data);
    }

    const today = new Date();
    const dateFrom = today.toISOString().slice(0, 10);

    const to = new Date();
    to.setDate(today.getDate() + 7);
    const dateTo = to.toISOString().slice(0, 10);

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /matches:", response.status, text);

      if (response.status === 429) {
        return res
          .status(429)
          .json({ error: "Prea multe cereri la football-data.org (429)" });
      }

      return res
        .status(response.status)
        .json({ error: "Eroare de la football-data.org", status: response.status });
    }

    const data = await response.json();

    const matches = (data.matches || []).map((m) => ({
      id: m.id,
      utcDate: m.utcDate,
      competition: m.competition?.name,
      homeTeam: m.homeTeam?.name,
      awayTeam: m.awayTeam?.name,
      prediction: generatePrediction(m),
    }));

    cache.matches[competitionId] = {
      timestamp: Date.now(),
      data: matches,
    };

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    const status = err.status || 500;
    if (status === 429) {
      return res
        .status(429)
        .json({ error: "Prea multe cereri la football-data.org (429)" });
    }
    res.status(status).json({ error: "Eroare internă la meciuri" });
  }
});

// ---------------- PORNIRE SERVER ----------------

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
