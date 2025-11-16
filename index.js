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

// Helper mic ca să nu ieșim din 0-100
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Helper: generează o predicție coerentă pentru un meci
function generatePrediction(match) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";

  // Avantaj de bază pentru gazde
  let homeAdvantage = 0.10; // 10%

  // Mică biasare după lungimea numelui (doar ca exemplu, ca să nu fie 100% random)
  if (homeName.length > awayName.length + 3) {
    homeAdvantage += 0.03;
  } else if (awayName.length > homeName.length + 3) {
    homeAdvantage -= 0.03;
  }

  // Probabilități brute 1X2 înainte de normalizare
  let rawHome = 0.45 + homeAdvantage + (Math.random() - 0.5) * 0.10;
  let rawAway = 0.30 - homeAdvantage + (Math.random() - 0.5) * 0.10;
  let rawDraw = 0.25 + (Math.random() - 0.5) * 0.05;

  // Să nu fie sub 5% niciuna
  rawHome = Math.max(rawHome, 0.05);
  rawAway = Math.max(rawAway, 0.05);
  rawDraw = Math.max(rawDraw, 0.05);

  // Normalizare la 100%
  const total = rawHome + rawDraw + rawAway;

  let probHome = Math.round((rawHome / total) * 100);
  let probDraw = Math.round((rawDraw / total) * 100);
  let probAway = Math.round((rawAway / total) * 100);

  // Ajustare mică să fie exact 100%
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

  const arr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...arr);

  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  const confidence = maxProb; // 0-100, îl folosim și la alte piețe

  // Index de atac, între 0 și 1, în funcție de cât de mari sunt șansele de 1 sau 2
  const attackIndex = (probHome + probAway) / 200; // 0-1

  // Goluri: peste/sub 2.5 + BTTS
  let goalsOver25 =
    35 + attackIndex * 40 + (confidence - 50) * 0.3 + (Math.random() - 0.5) * 10;
  goalsOver25 = clamp(Math.round(goalsOver25), 20, 90);

  let goalsUnder25 = 100 - goalsOver25;

  let bttsYes =
    30 + attackIndex * 40 + (confidence - 50) * 0.2 + (Math.random() - 0.5) * 10;
  bttsYes = clamp(Math.round(bttsYes), 15, 85);

  let bttsNo = 100 - bttsYes;

  // Cornere: mai mari când atacul e mare
  let cornersOver =
    40 + attackIndex * 35 + (confidence - 50) * 0.2 + (Math.random() - 0.5) * 8;
  cornersOver = clamp(Math.round(cornersOver), 25, 90);
  let cornersUnder = 100 - cornersOver;

  // Cartonașe: destul de echilibrate, ușor random
  let cardsOver =
    45 + (Math.random() - 0.5) * 20 + (attackIndex - 0.5) * 15;
  cardsOver = clamp(Math.round(cardsOver), 20, 90);
  let cardsUnder = 100 - cardsOver;

  // Faulturi: decidem cine are "mai multe faulturi"
  let foulsHomeMore = 50 + (Math.random() - 0.5) * 20;
  foulsHomeMore = clamp(Math.round(foulsHomeMore), 30, 70);
  let foulsAwayMore = 100 - foulsHomeMore;

  return {
    probHome,
    probDraw,
    probAway,
    mainPick,   // "HOME" | "DRAW" | "AWAY"
    confidence, // 0-100

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
  };
}

// 1. Lista de competiții (ligile importante)
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

    // păstrăm doar câteva competiții cunoscute
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

// 2. Meciuri pentru competiția aleasă, în următoarele 7 zile
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

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;

    const response = await fetch(url, {
      headers: { "X-Auth-Token": API_KEY },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /matches:", response.status, text);
      return res
        .status(response.status)
        .json({ error: "Eroare de la football-data.org", status: response.status });
    }

    const data = await response.json();

    const matches = (data.matches || []).map((m) => {
      const prediction = generatePrediction(m);

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
