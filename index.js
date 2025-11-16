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

// Helper: generează o predicție simplă pentru un meci
function generatePrediction() {
  // valori brute, apoi normalizăm la 100%
  const rawHome = 0.4 + Math.random() * 0.3; // 0.40 - 0.70
  const rawDraw = 0.1 + Math.random() * 0.2; // 0.10 - 0.30
  const rawAway = 0.2 + Math.random() * 0.3; // 0.20 - 0.50

  const total = rawHome + rawDraw + rawAway;

  let probHome = Math.round((rawHome / total) * 100);
  let probDraw = Math.round((rawDraw / total) * 100);
  let probAway = Math.round((rawAway / total) * 100);

  // ajustare mică să fie exact 100%
  const sum = probHome + probDraw + probAway;
  if (sum !== 100) {
    const diff = 100 - sum;
    // corectăm cea mai mare probabilitate
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

  const confidence = maxProb; // folosim valoarea maximă ca "încredere"

  return {
    probHome,    // procent 0-100
    probDraw,    // procent 0-100
    probAway,    // procent 0-100
    mainPick,    // "HOME" | "DRAW" | "AWAY"
    confidence,  // 0-100, ne va ajuta la filtrul de 80%
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
      const prediction = generatePrediction();

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: m.homeTeam?.name,
        awayTeam: m.awayTeam?.name,
        prediction, // NOU: probabilități simple
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
