import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());

// ----------------------
// Config API-FOOTBALL
// ----------------------
const API_KEY = "b9e3120fb4c251d6d8f9d1dd9bc4e6e0";
const API_BASE = "https://v3.football.api-sports.io";

// ----------------------
// Competiții urmărite (SEZON 2025 CORECT!)
// ----------------------
const COMPETITIONS = [
  { id: 39, code: "PL", name: "Premier League", country: "England", apiLeagueId: 39, season: 2025 },
  { id: 135, code: "SA", name: "Serie A", country: "Italy", apiLeagueId: 135, season: 2025 },
  { id: 140, code: "PD", name: "La Liga", country: "Spain", apiLeagueId: 140, season: 2025 },
  { id: 61, code: "L1", name: "Ligue 1", country: "France", apiLeagueId: 61, season: 2025 },
  { id: 78, code: "BL1", name: "Bundesliga", country: "Germany", apiLeagueId: 78, season: 2025 },
  { id: 88, code: "DED", name: "Eredivisie", country: "Netherlands", apiLeagueId: 88, season: 2025 },
  { id: 283, code: "RO1", name: "Superliga", country: "Romania", apiLeagueId: 283, season: 2025 },
  { id: 284, code: "RO2", name: "Liga 2", country: "Romania", apiLeagueId: 284, season: 2025 }
];

// ----------------------
// Funcție helper: call API-FOOTBALL
// ----------------------
async function apiFetch(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { "x-apisports-key": API_KEY }
  });
  const data = await res.json();
  return data;
}

// ----------------------
// Test cheie
// ----------------------
app.get("/api/test-key", async (req, res) => {
  try {
    res.json({ ok: true, message: "Cheie OK" });
  } catch (e) {
    res.json({ ok: false, message: "Eroare" });
  }
});

// ----------------------
// Lista competiții
// ----------------------
app.get("/api/competitions", (req, res) => {
  res.json(COMPETITIONS);
});

// ----------------------
// Meciuri viitoare pentru o competiție
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const compId = parseInt(req.query.competitionId);
    const comp = COMPETITIONS.find(c => c.id === compId);
    if (!comp) return res.json({ matches: [] });

    const now = new Date();
    const nextDays = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);

    const from = now.toISOString().split("T")[0];
    const to = nextDays.toISOString().split("T")[0];

    const data = await apiFetch(
      `/fixtures?league=${comp.apiLeagueId}&season=${comp.season}&from=${from}&to=${to}`
    );

    if (!data.response) return res.json({ matches: [] });

    const matches = data.response.map(m => ({
      id: m.fixture.id,
      date: m.fixture.date,
      homeTeam: m.teams.home.name,
      awayTeam: m.teams.away.name
    }));

    res.json({ matches });
  } catch (e) {
    console.error("Eroare /api/matches:", e);
    res.json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
// Pornire server
// ----------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Backend pornit pe portul", PORT);
});
