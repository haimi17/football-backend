import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

const CACHE_TTL = 60 * 1000;
const cache = {
  competitions: { data: null, timestamp: 0 },
  matches: {}
};

// ----------------------
// Test API Key
// ----------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ message: "Cheie lipsă", keyExists: false });
  }
  return res.json({ message: "Cheie OK", keyExists: true });
});

// ----------------------
// Competitions
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (cache.competitions.data && Date.now() - cache.competitions.timestamp < CACHE_TTL) {
      return res.json(cache.competitions.data);
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const url = `${API_BASE}/leagues`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      }
    });

    const data = await response.json();

    cache.competitions = {
      data,
      timestamp: Date.now()
    };

    return res.json(data);

  } catch (err) {
    console.error("Eroare /competitions:", err);
    return res.status(500).json({ error: "Eroare internă la competiții" });
  }
});

// ----------------------
// Matches (fixtures)
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const today = new Date().toISOString().split("T")[0];

    if (
      cache.matches[competitionId] &&
      Date.now() - cache.matches[competitionId].timestamp < CACHE_TTL
    ) {
      return res.json(cache.matches[competitionId].data);
    }

    const url =
      `${API_BASE}/fixtures?league=${competitionId}` +
      `&season=2024&from=${today}&to=${today}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      }
    });

    const data = await response.json();

    if (!data || !data.response) {
      return res.status(500).json({ error: "Răspuns invalid de la API-Football" });
    }

    cache.matches[competitionId] = {
      data,
      timestamp: Date.now()
    };

    return res.json(data);

  } catch (err) {
    console.error("Eroare /matches:", err);
    return res.status(500).json({ error: "Eroare internă la meciuri" });
  }
});

// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
