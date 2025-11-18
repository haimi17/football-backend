import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

const API_KEY = process.env.API_FOOTBALL_KEY; 
const API_URL = "https://v3.football.api-sports.io";

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function apiFetch(endpoint) {
  const fullUrl = `${API_URL}${endpoint}`;
  await delay(350);

  const res = await fetch(fullUrl, {
    headers: { "x-apisports-key": API_KEY }
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  return res.json();
}

// =======================
// ROOT - teste backend
// =======================
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Backend activ" });
});

// =======================
// 1. /api/key-check
// =======================
app.get("/api/key-check", async (req, res) => {
  try {
    await apiFetch("/status");
    res.json({ ok: true, message: "Cheie OK" });
  } catch (err) {
    res.status(400).json({ ok: false, error: "Cheie INVALIDĂ" });
  }
});

// =======================
// 2. /api/leagues
// =======================
app.get("/api/leagues", async (req, res) => {
  try {
    const leaguesToUse = [
      { id: 39,  code: "PL",  country: "England",  season: 2024 },
      { id: 135, code: "SA",  country: "Italy",    season: 2024 },
      { id: 140, code: "PD",  country: "Spain",    season: 2024 },
      { id: 61,  code: "L1",  country: "France",   season: 2024 },
      { id: 78,  code: "BL1", country: "Germany",  season: 2024 },
      { id: 88,  code: "DED", country: "Netherlands", season: 2024 },
      { id: 283, code: "RO1", country: "Romania",  season: 2024 },
      { id: 284, code: "RO2", country: "Romania",  season: 2024 }
    ];

    res.json(leaguesToUse);
  } catch (err) {
    res.status(500).json({ error: "Eroare la leagues" });
  }
});

// =======================
// 3. /api/matches
// =======================
app.get("/api/matches", async (req, res) => {
  try {
    const leagueId = req.query.league;
    if (!leagueId) return res.json({ matches: [], apiErrors: ["Missing league"] });

    const today = new Date();
    const ahead = new Date();
    ahead.setDate(today.getDate() + 21);

    const from = today.toISOString().split("T")[0];
    const to = ahead.toISOString().split("T")[0];

    const url = `/fixtures?league=${leagueId}&season=2024&from=${from}&to=${to}`;

    const raw = await apiFetch(url);

    if (!raw.response || raw.response.length === 0) {
      return res.json({ matches: [], apiErrors: [] });
    }

    const games = raw.response.map((g) => ({
      fixtureId: g.fixture.id,
      date: g.fixture.date,
      status: g.fixture.status.long,
      home: g.teams.home.name,
      away: g.teams.away.name
    }));

    res.json({
      matches: games,
      apiErrors: []
    });

  } catch (err) {
    res.json({
      matches: [],
      apiErrors: [String(err)]
    });
  }
});

app.listen(3000, () => {
  console.log("Server running on port 3000");
});
