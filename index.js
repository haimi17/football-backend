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
// Helper fetch API-FOOTBALL
// ----------------------
async function apiFetch(endpoint, params) {
  const qs =
    "?" +
    Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");

  const res = await fetch(API_BASE + endpoint + qs, {
    headers: {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io"
    }
  });

  const data = await res.json();
  return data.response || [];
}

// ----------------------
// Sezon curent (tipic Europa: aug–mai)
// ----------------------
function getCurrentSeasonYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0 = ianuarie
  return month >= 6 ? year : year - 1; // dacă e iulie sau mai târziu -> sezon anul acesta
}

const CURRENT_SEASON = getCurrentSeasonYear();

// ----------------------
// Competitions (leagueId + season dinamic)
// ----------------------
const COMPETITIONS = [
  { id: 2021, code: "PL", name: "Premier League", country: "England", apiLeagueId: 39 },
  { id: 2014, code: "PD", name: "La Liga", country: "Spain", apiLeagueId: 140 },
  { id: 2002, code: "BL1", name: "Bundesliga", country: "Germany", apiLeagueId: 78 },
  { id: 2019, code: "SA", name: "Serie A", country: "Italy", apiLeagueId: 135 },
  { id: 2015, code: "FL1", name: "Ligue 1", country: "France", apiLeagueId: 61 },
  { id: 2003, code: "DED", name: "Eredivisie", country: "Netherlands", apiLeagueId: 88 },
  { id: 2017, code: "PPL", name: "Primeira Liga", country: "Portugal", apiLeagueId: 94 },

  // România
  { id: 3001, code: "RO1", name: "Superliga", country: "Romania", apiLeagueId: 283 },
  { id: 3002, code: "RO2", name: "Liga 2", country: "Romania", apiLeagueId: 284 }
];

// ----------------------
// Helpers statistice
// ----------------------
function factorial(n) {
  if (n < 0) return 1;
  let r = 1;
  for (let i = 1; i <= n; i++) r *= i;
  return r;
}

function poisson(lambda, k) {
  const e = Math.exp(-lambda);
  return (Math.pow(lambda, k) * e) / factorial(k);
}

function poissonProbabilities(lambdaHome, lambdaAway) {
  let over15 = 0,
    over25 = 0,
    over35 = 0;

  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      const p = poisson(lambdaHome, h) * poisson(lambdaAway, a);
      const total = h + a;

      if (total >= 2) over15 += p;
      if (total >= 3) over25 += p;
      if (total >= 4) over35 += p;
    }
  }

  return {
    over15: Math.round(over15 * 100),
    over25: Math.round(over25 * 100),
    over35: Math.round(over35 * 100)
  };
}

// ----------------------
// /api/competitions
// ----------------------
app.get("/api/competitions", (req, res) => {
  // trimitem și sezonul curent ca info
  const season = CURRENT_SEASON;
  res.json(
    COMPETITIONS.map((c) => ({
      ...c,
      season
    }))
  );
});

// ----------------------
// /api/matches
// ----------------------
app.get("/api/matches", async (req, res) => {
  try {
    const cid = Number(req.query.competitionId);
    const comp = COMPETITIONS.find((x) => x.id === cid);
    if (!comp) return res.json({ matches: [] });

    const season = CURRENT_SEASON;

    // următoarele 20 meciuri programate
    const fixtures = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season,
      next: 20
    });

    const upcoming = fixtures.filter((fx) => {
      const s = fx.fixture?.status?.short;
      return s === "NS" || s === "TBD" || s === "PST";
    });

    const out = [];

    for (const fx of upcoming) {
      const homeId = fx.teams.home.id;
      const awayId = fx.teams.away.id;

      const homeForm = await apiFetch("/fixtures", {
        team: homeId,
        season,
        last: 5
      });

      const awayForm = await apiFetch("/fixtures", {
        team: awayId,
        season,
        last: 5
      });

      const lambdaHome =
        homeForm.length > 0
          ? homeForm.reduce((s, g) => s + (g.goals?.home ?? 0), 0) /
            homeForm.length
          : 1.1;

      const lambdaAway =
        awayForm.length > 0
          ? awayForm.reduce((s, g) => s + (g.goals?.away ?? 0), 0) /
            awayForm.length
          : 1.1;

      const total = lambdaHome + lambdaAway || 1;
      const probHome = Math.round((lambdaHome / total) * 100);
      const probAway = Math.round((lambdaAway / total) * 100);
      const probDraw = Math.max(0, 100 - probHome - probAway);

      let pick = "DRAW";
      if (probHome > probAway && probHome > probDraw) pick = "HOME";
      if (probAway > probHome && probAway > probDraw) pick = "AWAY";

      const confidence = Math.max(probHome, probAway, probDraw);

      const dist = poissonProbabilities(lambdaHome, lambdaAway);

      const roughBtts = 50 + lambdaHome * 15 + lambdaAway * 15;
      const bttsYes = Math.max(0, Math.min(100, Math.round(roughBtts)));
      const bttsNo = 100 - bttsYes;

      out.push({
        id: fx.fixture.id,
        utcDate: fx.fixture.date,
        competition: comp.name,
        homeTeam: fx.teams.home.name,
        awayTeam: fx.teams.away.name,
        prediction: {
          probHome,
          probDraw,
          probAway,
          mainPick: pick,
          confidence,
          goals: {
            over25: dist.over25,
            under25: 100 - dist.over25
          },
          btts: {
            yes: bttsYes,
            no: bttsNo
          },
          lambdas: {
            home: lambdaHome,
            away: lambdaAway
          }
        }
      });
    }

    res.json({ matches: out });
  } catch (e) {
    console.error("Eroare /matches:", e);
    res.json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
// /api/test-key
// ----------------------
app.get("/api/test-key", (req, res) => {
  res.json({
    ok: API_KEY ? true : false,
    message: API_KEY ? "Cheie OK" : "Cheie lipsă"
  });
});

// ----------------------
app.listen(PORT, () => {
  console.log("Backend ready on port " + PORT);
});
