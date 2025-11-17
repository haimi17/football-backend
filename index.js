import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// ----------------------
// Cache simplu (60 sec)
// ----------------------
const CACHE_TTL = 60 * 1000;

const cache = {
  competitions: { data: null, timestamp: 0 },
  matches: {} // cheie: competitionId
};

function isCacheValid(entry) {
  return (
    entry &&
    entry.data &&
    Date.now() - entry.timestamp < CACHE_TTL
  );
}

// ----------------------
// Test cheie
// ----------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ message: "Cheie lipsă", keyExists: false });
  }
  return res.json({ message: "Cheie OK", keyExists: true });
});

// ----------------------
// 1. Lista de competiții
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    if (isCacheValid(cache.competitions)) {
      return res.json(cache.competitions.data);
    }

    const url = `${API_BASE}/leagues?current=true`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /leagues:", response.status, text);
      return res
        .status(500)
        .json({ error: "Eroare de la API-Football la /leagues" });
    }

    const data = await response.json();

    // Ligile principale (id-uri API-Football)
    const wantedIds = [39, 140, 135, 78, 61, 88, 94];

    const leagues = (data.response || [])
      .filter((item) => wantedIds.includes(item.league?.id))
      .map((item) => ({
        id: item.league.id,
        name: item.league.name,
        code: item.country?.code || item.country?.name || ""
      }));

    cache.competitions = {
      data: leagues,
      timestamp: Date.now()
    };

    return res.json(leagues);
  } catch (err) {
    console.error("Eroare /api/competitions:", err);
    return res
      .status(500)
      .json({ error: "Eroare internă la competiții" });
  }
});

// ----------------------
// 2. Meciuri (fixtures)
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;

    if (!competitionId) {
      return res
        .status(400)
        .json({ error: "competitionId lipsă" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const cached = cache.matches[competitionId];
    if (isCacheValid(cached)) {
      return res.json(cached.data);
    }

    const today = new Date();
    const from = today.toISOString().slice(0, 10);

    const toDate = new Date(today);
    toDate.setDate(today.getDate() + 7);
    const to = toDate.toISOString().slice(0, 10);

    // sezon 2024 – ajustează dacă e nevoie
    const url =
      `${API_BASE}/fixtures?league=${competitionId}` +
      `&season=2024&from=${from}&to=${to}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY
      }
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("Eroare la /fixtures:", response.status, text);
      return res
        .status(500)
        .json({ error: "Eroare de la API-Football la /fixtures" });
    }

    const data = await response.json();

    const matches = (data.response || []).map((item) => ({
      id: item.fixture?.id,
      utcDate: item.fixture?.date,
      competition: item.league?.name,
      homeTeam: item.teams?.home?.name,
      awayTeam: item.teams?.away?.name
      // aici, în pașii următori, vom adăuga statistici și predicții reale
    }));

    const result = { matches };

    cache.matches[competitionId] = {
      data: result,
      timestamp: Date.now()
    };

    return res.json(result);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    return res
      .status(500)
      .json({ error: "Eroare internă la meciuri" });
  }
});

// ----------------------
// Pornire server
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
