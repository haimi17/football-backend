import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// Echipe considerate puternice (primele care îți vin în minte, putem extinde lista)
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

// Root simplu, pentru verificare
app.get("/", (req, res) => {
  res.send("Football backend OK");
});

// Helper: limitează o valoare între min și max
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Random determinist bazat pe text (seed)
function pseudoRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0) / 4294967295; // 0-1
}

// Obținem un random stabil pentru un anumit meci + „cheie”
function prngForMatch(match, key) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";
  const id = match?.id || 0;
  const seed = `${id}-${homeName}-${awayName}-${key}`;
  return pseudoRandom(seed);
}

// Helper: generează o predicție coerentă pentru un meci
function generatePrediction(match) {
  const homeName = match?.homeTeam?.name || "";
  const awayName = match?.awayTeam?.name || "";

  // Avantaj gazde
  let homeAdvantage = 0.15; // 15%

  // Forță de bază pentru echipe
  let strengthHome = 1 + homeAdvantage;
  let strengthAway = 1;

  // Boost pentru echipe mari
  if (BIG_TEAMS.includes(homeName)) strengthHome += 0.35;
  if (BIG_TEAMS.includes(awayName)) strengthAway += 0.35;

  // Cât de apropiate ca nivel par echipele
  const strengthDiff = Math.abs(strengthHome - strengthAway); // 0 = egale
  const closeness = clamp(1 - strengthDiff, 0, 1);

  // Probabilitate de egal mai mare când echipele sunt apropiate
  const baseDrawProb = 0.18 + 0.18 * closeness; // între ~18% și ~36%
  const nonDrawProb = 1 - baseDrawProb;
  const sumStrength = strengthHome + strengthAway;

  let rawHome = (strengthHome / sumStrength) * nonDrawProb;
  let rawAway = (strengthAway / sumStrength) * nonDrawProb;
  let rawDraw = baseDrawProb;

  // Mic zgomot determinist
  const noiseHome = (prngForMatch(match, "home") - 0.5) * 0.08;
  const noiseAway = (prngForMatch(match, "away") - 0.5) * 0.08;
  const noiseDraw = (prngForMatch(match, "draw") - 0.5) * 0.05;

  rawHome += noiseHome;
  rawAway += noiseAway;
  rawDraw += noiseDraw;

  // Să nu fie sub 5% niciuna
  rawHome = clamp(rawHome, 0.05, 0.9);
  rawAway = clamp(rawAway, 0.05, 0.9);
  rawDraw = clamp(rawDraw, 0.05, 0.9);

  // Normalizare la 100%
  const totalRaw = rawHome + rawDraw + rawAway;
  let probHome = Math.round((rawHome / totalRaw) * 100);
  let probDraw = Math.round((rawDraw / totalRaw) * 100);
  let probAway = Math.round((rawAway / totalRaw) * 100);

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

  const arr = [
    { label: "HOME", value: probHome },
    { label: "DRAW", value: probDraw },
    { label: "AWAY", value: probAway },
  ];

  arr.sort((a, b) => b.value - a.value);
  const mainPick = arr[0].label;

  // Confidence din diferența între prima și a doua probabilitate
  const margin = (arr[0].value - arr[1].value) / 100; // 0-1
  let confidence = 55 + margin * 120; // între ~55 și ~75-80 tipic
  // boost mic pentru echipe mari foarte favorite
  if (
    mainPick === "HOME" &&
    BIG_TEAMS.includes(homeName) &&
    probHome >= 60
  ) {
    confidence += 5;
  }
  confidence = clamp(Math.round(confidence), 50, 95);

  // Index atac după șansele de victorie ale echipelor
  const attackIndex = (probHome + probAway) / 200; // 0-1

  // Goluri: peste/sub 2.5 + BTTS
  const goalsBase =
    0.45 + attackIndex * 0.35; // 45% la meci echilibrat, mai mult la meci ofensiv
  const goalsNoise = (prngForMatch(match, "goals") - 0.5) * 0.15;
  let goalsOver25 = clamp(goalsBase + goalsNoise, 0.25, 0.88);
  let goalsUnder25 = 1 - goalsOver25;

  let bttsBase = 0.40 + attackIndex * 0.30;
  const bttsNoise = (prngForMatch(match, "btts") - 0.5) * 0.15;
  let bttsYes = clamp(bttsBase + bttsNoise, 0.20, 0.85);
  let bttsNo = 1 - bttsYes;

  // Cornere: mai mari când atacul e mare
  let cornersBase = 0.45 + attackIndex * 0.30;
  const cornersNoise = (prngForMatch(match, "corners") - 0.5) * 0.12;
  let cornersOver = clamp(cornersBase + cornersNoise, 0.25, 0.90);
  let cornersUnder = 1 - cornersOver;

  // Cartonașe: destul de echilibrate, ușor influențate de „closeness”
  let cardsBase = 0.45 + (1 - closeness) * 0.15; // meciuri dezechilibrate tind să fie mai dure
  const cardsNoise = (prngForMatch(match, "cards") - 0.5) * 0.18;
  let cardsOver = clamp(cardsBase + cardsNoise, 0.20, 0.90);
  let cardsUnder = 1 - cardsOver;

  // Faulturi: mic avantaj random, dar stabil
  let foulsHomeMore =
    0.50 +
    (prngForMatch(match, "fouls-home") - 0.5) * 0.20 +
    (strengthHome - strengthAway) * 0.05;
  foulsHomeMore = clamp(foulsHomeMore, 0.30, 0.70);
  let foulsAwayMore = 1 - foulsHomeMore;

  return {
    probHome,
    probDraw,
    probAway,
    mainPick, // "HOME" | "DRAW" | "AWAY"
    confidence, // 0-100

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
