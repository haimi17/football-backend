import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// cheia din Render -> Environment -> API_FOOTBALL_KEY
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// Cache simplu în memorie
const CACHE_TTL_MS = 60 * 1000; // 60 secunde

const cache = {
  competitions: {
    data: null,
    timestamp: 0,
  },
  matches: {
    // [leagueId]: { data, timestamp }
  },
};

// Mic helper pentru data în format YYYY-MM-DD
function formatDate(d) {
  return d.toISOString().split("T")[0];
}

// Sezonul actual (stil Europa: sezon începe vara)
function getCurrentSeason() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  // dacă suntem din iulie încolo, sezonul = anul curent
  // altfel, sezonul = anul precedent (ex: martie 2026 -> sezon 2025)
  return month >= 7 ? year : year - 1;
}

// ----------------------
// 1. Test cheie
// ----------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ message: "Cheie lipsă", keyExists: false });
  }
  return res.json({ message: "Cheie OK", keyExists: true });
});

// ----------------------
// 2. Listează competițiile (ligele)
//     întoarcem un ARRAY simplu:
//     [{ id, name, country }, ...]
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    // cache valid
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

    // ligile care sunt în sezon curent
    const url = `${API_BASE}/leagues?current=true`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "x-apisports-key": API_KEY,
      },
    });

    if (!response.ok) {
      const txt = await response.text();
      console.error("Eroare /leagues:", response.status, txt);
      return res
        .status(response.status)
        .json({ error: "Eroare la API-Football /leagues" });
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.response)) {
      console.error("Format neașteptat /leagues:", data);
      return res
        .status(500)
        .json({ error: "Format neașteptat de la API-Football" });
    }

    // Simplificăm structura pentru frontend
    const leagues = data.response.map((item) => ({
      id: item.league.id,
      name: item.league.name,
      country: item.country?.name || "",
    }));

    // salvăm în cache ca ARRAY
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
// 3. Meciuri (fixtures) pentru o ligă
//     GET /api/matches?competitionId=39
//     răspuns:
//     { matches: [ { id, utcDate, leagueName, homeTeam, awayTeam }, ... ] }
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
    to.setDate(now.getDate() + 7); // următoarele 7 zile
    const dateTo = formatDate(to);

    const season = getCurrentSeason();

    // cache per ligă
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

    if (!response.ok) {
      const txt = await response.text();
      console.error("Eroare /fixtures:", response.status, txt);
      return res
        .status(response.status)
        .json({ error: "Eroare la API-Football /fixtures" });
    }

    const data = await response.json();

    if (!data || !Array.isArray(data.response)) {
      console.error("Format neașteptat /fixtures:", data);
      return res
        .status(500)
        .json({ error: "Format neașteptat de la API-Football" });
    }

    // Mapăm doar informațiile de bază de care ai nevoie în frontend
    const matches = data.response.map((item) => ({
      id: item.fixture.id,
      utcDate: item.fixture.date,
      leagueId: item.league.id,
      leagueName: item.league.name,
      homeTeam: item.teams.home.name,
      awayTeam: item.teams.away.name,
    }));

    const payload = { matches };

    // punem în cache
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

// ----------------------
// Pornim serverul
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
