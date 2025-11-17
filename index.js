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
  res.send("Football backend OK");
});

// -----------------------------
// Helperi ELO
// -----------------------------

function buildEloRatings(standingsJson) {
  const ratings = {};

  const standingsArray = standingsJson?.standings || [];
  const table = standingsArray[0]?.table || [];

  table.forEach((row) => {
    const teamId = row.team?.id;
    const teamName = row.team?.name || "Unknown";

    const played = row.playedGames || 1;
    const points = row.points || 0;
    const gd = row.goalDifference || 0;
    const wins = row.won || 0;
    const losses = row.lost || 0;

    const pointsPerGame = points / played; // de ex. 2.1
    const gdPerGame = gd / played; // de ex. +0.6
    const formFactor = (wins - losses) / played; // -1 .. +1

    // rating de bază + ajustări din clasament
    let rating =
      1500 +
      60 * (pointsPerGame - 1.5) + // echipe cu multe puncte urcă
      25 * gdPerGame + // golaveraj bun
      40 * formFactor; // formă bună

    rating = Math.round(rating);

    if (teamId) {
      ratings[teamId] = {
        rating,
        teamName,
      };
    }
  });

  return ratings;
}

// Probabilități 1X2 din ELO
function eloWinProbs(homeRating, awayRating) {
  const HOME_ADV = 60; // avantaj teren propriu (~60 elo)
  const diff = homeRating + HOME_ADV - awayRating; // >0 favorizează gazdele

  // probabilitate victorie gazde (fără egal)
  const pow = Math.pow(10, diff / 400);
  const pHomeRaw = pow / (1 + pow);
  const pAwayRaw = 1 - pHomeRaw;

  // egal – mai mare când echipele sunt apropiate ca rating
  const balance = 1 - Math.min(Math.abs(diff) / 600, 1); // 0..1
  let pDraw = 0.18 + 0.10 * balance; // 0.18 - 0.28

  // rescalăm ca să avem pHome + pDraw + pAway = 1
  const scale = 1 - pDraw;
  const pHome = pHomeRaw * scale;
  const pAway = pAwayRaw * scale;

  return {
    probHome: pHome,
    probDraw: pDraw,
    probAway: pAway,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Generează predicția pentru un meci folosind ELO
function generatePredictionWithElo({ homeRating, awayRating, eloProbs }) {
  // transformăm în procente întregi
  let probHome = Math.round(eloProbs.probHome * 100);
  let probDraw = Math.round(eloProbs.probDraw * 100);
  let probAway = Math.round(eloProbs.probAway * 100);

  // mică corecție pentru a avea exact 100%
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

  const probs = [probHome, probDraw, probAway];
  const maxProb = Math.max(...probs);
  const sorted = [...probs].sort((a, b) => b - a);
  const margin = maxProb - sorted[1]; // diferență între prima și a doua

  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  // încredere: depinde de probabilitatea maximă și de distanța față de locul 2
  let confidence = maxProb + margin * 0.5;
  confidence = clamp(Math.round(confidence), 40, 90);

  // folosim diferența de rating pentru a estima intensitatea
  const ratingDiff = homeRating - awayRating;
  const diffFactor = clamp(ratingDiff / 400, -0.8, 0.8);

  const baseTotalXg = 2.7;
  const homeShare = 0.5 + diffFactor * 0.15; // 0.38 - 0.62
  const xgHome = baseTotalXg * homeShare;
  const xgAway = baseTotalXg * (1 - homeShare);
  const totalXg = xgHome + xgAway;

  // Goluri
  const over25Prob = sigmoid((totalXg - 2.5) * 1.2);
  const bttsProb = sigmoid((totalXg - 2.2) * 1.0);

  const goalsOver25 = clamp(
    Math.round(40 + over25Prob * 50),
    30,
    90
  );
  const goalsUnder25 = 100 - goalsOver25;

  const bttsYes = clamp(
    Math.round(35 + bttsProb * 45),
    30,
    90
  );
  const bttsNo = 100 - bttsYes;

  // Cornere (mai multe când meciul e dezechilibrat sau cu multe goluri așteptate)
  const cornerIndex =
    0.5 +
    0.4 * Math.abs(diffFactor) +
    0.2 * clamp(totalXg - 2.2, -0.5, 0.8);
  const cornersOver = clamp(Math.round(35 + cornerIndex * 35), 30, 85);
  const cornersUnder = 100 - cornersOver;

  // Cartonașe – mai multe când diferența de forță e mare
  const physicality = 0.5 + 0.5 * (1 - (1 - Math.abs(diffFactor)));
  const cardsOver = clamp(Math.round(35 + physicality * 35), 30, 85);
  const cardsUnder = 100 - cardsOver;

  // Faulturi – echipa mai slabă tinde să facă mai multe
  let foulsHomeMore = 50;
  let foulsAwayMore = 50;
  if (ratingDiff > 40) {
    // gazdele mai bune
    foulsHomeMore = 45;
    foulsAwayMore = 55;
  } else if (ratingDiff < -40) {
    // oaspeții mai buni
    foulsHomeMore = 55;
    foulsAwayMore = 45;
  }

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
      over9_5: cornersOver,
      under9_5: cornersUnder,
    },
    cards: {
      over4_5: cardsOver,
      under4_5: cardsUnder,
    },
    fouls: {
      homeMore: foulsHomeMore,
      awayMore: foulsAwayMore,
    },
    elo: {
      homeRating: Math.round(homeRating),
      awayRating: Math.round(awayRating),
      diff: Math.round(homeRating - awayRating),
      probHome,
      probDraw,
      probAway,
    },
  };
}

// -----------------------------
// 1. Lista de competiții
// -----------------------------
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

// -----------------------------
// 2. Meciuri + ELO pentru competiția aleasă
// -----------------------------
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

    const headers = { "X-Auth-Token": API_KEY };

    // luăm și clasamentul (pentru ELO), și meciurile viitoare
    const [standingsResp, matchesResp] = await Promise.all([
      fetch(`${API_BASE}/competitions/${competitionId}/standings`, {
        headers,
      }),
      fetch(
        `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`,
        { headers }
      ),
    ]);

    if (!standingsResp.ok) {
      const text = await standingsResp.text();
      console.error(
        "Eroare la /standings:",
        standingsResp.status,
        text
      );
    }

    if (!matchesResp.ok) {
      const text = await matchesResp.text();
      console.error("Eroare la /matches:", matchesResp.status, text);
      return res
        .status(matchesResp.status)
        .json({ error: "Eroare de la football-data.org", status: matchesResp.status });
    }

    const standingsJson = await standingsResp.json();
    const matchesJson = await matchesResp.json();

    const eloRatings = buildEloRatings(standingsJson);

    const matches = (matchesJson.matches || []).map((m) => {
      const homeId = m.homeTeam?.id;
      const awayId = m.awayTeam?.id;

      const homeRating = eloRatings[homeId]?.rating || 1500;
      const awayRating = eloRatings[awayId]?.rating || 1500;

      const eloProbs = eloWinProbs(homeRating, awayRating);
      const prediction = generatePredictionWithElo({
        homeRating,
        awayRating,
        eloProbs,
      });

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
