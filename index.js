import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// Test root
app.get("/", (req, res) => {
  res.send("Football backend OK");
});

// Competitions
app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.status(500).json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
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

// Matches
app.get("/api/matches", async (req, res) => {
  try {
    const competitionId = req.query.competitionId;
    if (!competitionId) {
      return res.status(400).json({ error: "Lipsește parametrul competitionId" });
    }

    if (!API_KEY) {
      return res.status(500).json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today);
    to.setDate(today.getDate() + 7);
    const toDate = to.toISOString().slice(0, 10);

    const url = `${API_BASE}/competitions/${competitionId}/matches?dateFrom=${from}&dateTo=${toDate}`;

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

    const matches = (data.matches || []).map((m) => ({
      id: m.id,
      utcDate: m.utcDate,
      competition: m.competition?.name,
      homeTeam: m.homeTeam?.name,
      awayTeam: m.awayTeam?.name,
    }));

    res.json(matches);
  } catch (err) {
    console.error("Eroare server /api/matches:", err);
    res.status(500).json({ error: "Eroare internă server" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
