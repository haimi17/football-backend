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

// Helper: generează o pereche (A,B) care să dea 100%
function generatePair(minHigh = 55, maxHigh = 80) {
  const high = Math.round(minHigh + Math.random() * (maxHigh - minHigh));
  const low = 100 - high;
  return [high, low];
}

// Helper: generează o predicție mai bogată pentru un meci
function generatePrediction() {
  // 1) 1X2 – victorie gazde / egal / victorie oaspeți
  const rawHome = 0.4 + Math.random() * 0.4; // 0.40 - 0.80
  const rawDraw = 0.1 + Math.random() * 0.25; // 0.10 - 0.35
  const rawAway = 0.2 + Math.random() * 0.4; // 0.20 - 0.60

  const totalMain = rawHome + rawDraw + rawAway;

  let probHome = Math.round((rawHome / totalMain) * 100);
  let probDraw = Math.round((rawDraw / totalMain) * 100);
  let probAway = Math.round((rawAway / totalMain) * 100);

  // ajustare mică să fie exact 100%
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

  const mainArr = [probHome, probDraw, probAway];
  const maxProb = Math.max(...mainArr);

  let mainPick = "HOME";
  if (maxProb === probDraw) mainPick = "DRAW";
  if (maxProb === probAway) mainPick = "AWAY";

  // „încredere” – legată de cea mai mare probabilitate, dar puțin împinsă în sus
  let confidence = maxProb + 15; // de ex. 65% -> 80%
  if (confidence > 95) confidence = 95;

  // 2) Goluri (over/under 2.5) și BTTS
  const [over25, under25] = generatePair(52, 80);
  const [bttsYes, bttsNo] = generatePair(50, 78);

  // 3) Cornere (over/under 9.5)
  const [cornersOver, cornersUnder] = generatePair(50, 78);

  // 4) Cartonașe (over/under 4.5)
  const [cardsOver, cardsUnder] = generatePair(50, 78);

  // 5) Faulturi – care echipă e mai „tare” la faulturi (procente)
  const [foulsHome, foulsAway] = generatePair(50, 75);

  return {
    // 1X2
    probHome,
    probDraw,
    probAway,
    mainPick, // "HOME" | "DRAW" | "AWAY"
    confidence, // 0-100, o folosim la filtru ≥80%

    // Goluri
    goals: {
      over25,
      under25,
      bttsYes,
      bttsNo,
    },

    // Cornere
    corners: {
      over9_5: cornersOver,
      under9_5: cornersUnder,
    },

    // Cartonașe
    cards: {
      over4_5: cardsOver,
      under4_5: cardsUnder,
    },

    // Faulturi
    fouls: {
      homeMore: foulsHome,
      awayMore: foulsAway,
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

// 2. Meciuri pentru competiția aleasă, în următoarele 7 zile
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
        .json({
          error: "Eroare de la football-data.org",
          status: response.status,
        });
    }

    const data = await response.json();

    const matches = (data.matches || []).map((m) => {
      const prediction = generatePrediction();

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
