import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

const CACHE_TTL_MS = 60 * 1000;

const cache = {
  competitions: {
    data: null,
    timestamp: 0,
  },
  matches: {
    // [leagueId]: { data, timestamp }
  },
};

function formatDate(d) {
  return d.toISOString().split("T")[0];
}

function getCurrentSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month >= 7 ? year : year - 1;
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
// Competitions
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (
      cache.competitions.data &&
      Date.now() - cache.competitions.timestamp < CACHE_TTL_MS
    ) {
      return res.json(cache.competitions.data);
    }

    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    const season = getCurrentSeason();
    const url = `${API_BASE}/leagues?season=${season}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
      },
    });

    const data = await response.json();

    // dacă API trimite erori, le vezi direct
    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("Erori API /leagues:", data.errors);
      return res.status(502).json({
        error: "Eroare de la API-Football",
        where: "/leagues",
        apiErrors: data.errors,
      });
    }

    if (!data.response || !Array.isArray(data.response)) {
      console.error("Format neașteptat /leagues:", data);
      return res
        .status(500)
        .json({ error: "Format neașteptat de la API-Football /leagues", raw: data });
    }

    const leagues = data.response.map((item) => ({
      id: item.league.id,
      name: item.league.name,
      country: item.country?.name || "",
    }));

    cache.competitions = {
      data: leagues,
      timestamp: Date.now(),
    };

    return res.json(leagues);
  } catch (err) {
    console.error("Eroare server /api/competitions:", err);
    return res.status(500).json({ error: "Eroare internă la competiții" });
  }
});

// ----------------------
// Matches
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

    const now = new Date();
    const dateFrom = formatDate(now);
    const to = new Date(now);
    to.setDate(now.getDate() + 7);
    const dateTo = formatDate(to);
    const season = getCurrentSeason();

    const cached = cache.matches[competitionId];
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const url =
      `${API_BASE}/fixtures?league=${competitionId}` +
      `&season=${season}&from=${dateFrom}&to=${dateTo}&timezone=Europe/Bucharest`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
      },
    });

    const data = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error("Erori API /fixtures:", data.errors);
      return res.status(502).json({
        error: "Eroare de la API-Football",
        where: "/fixtures",
        apiErrors: data.errors,
      });
    }

    if (!data.response || !Array.isArray(data.response)) {
      console.error("Format neașteptat /fixtures:", data);
      return res.status(500).json({
        error: "Format neașteptat de la API-Football /fixtures",
        raw: data,
      });
    }

    const matches = data.response.map((item) => ({
      id: item.fixture.id,
      utcDate: item.fixture.date,
      leagueId: item.league.id,
      leagueName: item.league.name,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
    }));

    const payload = { matches };

    cache.matches[competitionId] = {
      data: payload,
      timestamp: Date.now(),
    };

    return res.json(payload);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    return res.status(500).json({ error: "Eroare internă la meciuri" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
