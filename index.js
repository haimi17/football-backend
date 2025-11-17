import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

// Planul free are acces la sezoanele 2021–2023.
// Aleg sezonul 2023.
const SEASON = 2023;

// Interval fix din 2023 ca să existe meciuri în răspuns.
// Poți schimba luna/intervalul mai târziu.
const FIXTURES_FROM = "2023-05-01";
const FIXTURES_TO = "2023-05-31";

// Cache simplu, 60 secunde
const CACHE_TTL = 60 * 1000;
const cache = {
  competitions: { data: null, timestamp: 0 },
  matches: {} // cheia va fi competitionId
};

app.use(cors());
app.use(express.json());

// Root simplu
app.get("/", (req, res) => {
  res.send("Football backend OK (API-FOOTBALL, sezon 2023)");
});

// Test cheie
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ message: "Cheie lipsă", keyExists: false });
  }
  return res.json({ message: "Cheie OK", keyExists: true });
});

// ----------------------
// 1. COMPETIȚII (LIGI)
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    // Cache
    if (
      cache.competitions.data &&
      Date.now() - cache.competitions.timestamp < CACHE_TTL
    ) {
      return res.json(cache.competitions.data);
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const url = `${API_BASE}/leagues?season=${SEASON}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      }
    });

    const data = await response.json();

    // API-Football trimite erori în câmpul errors
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("Eroare API /leagues:", data.errors);
      return res.status(500).json({
        error: "Eroare de la API-Football",
        where: "/leagues",
        apiErrors: data.errors
      });
    }

    const raw = data.response || [];

    // Filtrez câteva ligi cunoscute (ID-uri API-Football)
    const allowedIds = [39, 140, 135, 78, 61, 88, 94]; // ENG, ESP, ITA, GER, FRA, NED, POR

    const competitions = raw
      .filter((item) => {
        const league = item.league;
        if (!league) return false;
        if (league.type !== "League") return false;
        return allowedIds.includes(league.id);
      })
      .map((item) => {
        const league = item.league;
        const country = item.country;
        return {
          id: league.id, // folosit ca competitionId în frontend
          name: `${league.name} (${country?.name || ""})`,
          code: league.code || String(league.id)
        };
      });

    cache.competitions = {
      data: competitions,
      timestamp: Date.now()
    };

    return res.json(competitions);
  } catch (err) {
    console.error("Eroare server /api/competitions:", err);
    return res.status(500).json({ error: "Eroare internă la competiții" });
  }
});

// ----------------------
// 2. MECIURI (FIXTURES)
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;

    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    // Cache per competiție
    const cacheEntry = cache.matches[competitionId];
    if (cacheEntry && Date.now() - cacheEntry.timestamp < CACHE_TTL) {
      return res.json(cacheEntry.data);
    }

    // Interval fix în 2023, compatibil cu planul free
    const url =
      `${API_BASE}/fixtures?league=${competitionId}` +
      `&season=${SEASON}&from=${FIXTURES_FROM}&to=${FIXTURES_TO}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
        "x-rapidapi-host": "v3.football.api-sports.io"
      }
    });

    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("Eroare API /fixtures:", data.errors);
      return res.status(500).json({
        error: "Eroare de la API-Football",
        where: "/fixtures",
        apiErrors: data.errors
      });
    }

    const rawMatches = data.response || [];

    const matches = rawMatches.map((m) => ({
      id: m.fixture?.id,
      utcDate: m.fixture?.date,
      competition: m.league?.name,
      homeTeam: m.teams?.home?.name,
      awayTeam: m.teams?.away?.name
      // aici vom adăuga ulterior predicții bazate pe statistici reale
    }));

    const payload = { matches };

    cache.matches[competitionId] = {
      data: payload,
      timestamp: Date.now()
    };

    return res.json(payload);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    return res.status(500).json({ error: "Eroare internă la meciuri" });
  }
});

// ----------------------
// PORNIRE SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
