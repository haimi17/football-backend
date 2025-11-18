import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// cheia din Render: API_FOOTBALL_KEY
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// -------------------------------------
// Helper: cerere generică la API-FOOTBALL
// -------------------------------------
async function apiFetch(path, params = {}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") {
      usp.append(k, String(v));
    }
  }

  const url = `${API_BASE}${path}?${usp.toString()}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY,
      "x-rapidapi-host": "v3.football.api-sports.io"
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error("Eroare API-FOOTBALL", res.status, txt);
    throw new Error(`API status ${res.status}`);
  }

  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    console.error("Erori API-FOOTBALL:", data.errors);
    throw new Error("Erori la API-FOOTBALL");
  }

  return data.response || [];
}

// -------------------------------------
// Helper: sezon european (start vara)
// -------------------------------------
function getSeasonYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  // sezon 2025–26 => 2025, etc.
  return month >= 7 ? year : year - 1;
}

// -------------------------------------
// Lista competițiilor expuse în frontend
// + mapare pe leagueId din API-FOOTBALL
// -------------------------------------
const COMPETITIONS = [
  // Top 5
  {
    id: 2021,
    code: "PL",
    name: "Premier League",
    country: "England",
    apiLeagueId: 39
  },
  {
    id: 2019,
    code: "SA",
    name: "Serie A",
    country: "Italy",
    apiLeagueId: 135
  },
  {
    id: 2014,
    code: "PD",
    name: "Primera Division",
    country: "Spain",
    apiLeagueId: 140
  },
  {
    id: 2002,
    code: "BL1",
    name: "Bundesliga",
    country: "Germany",
    apiLeagueId: 78
  },
  {
    id: 2015,
    code: "FL1",
    name: "Ligue 1",
    country: "France",
    apiLeagueId: 61
  },

  // Alte ligi
  {
    id: 2003,
    code: "DED",
    name: "Eredivisie",
    country: "Netherlands",
    apiLeagueId: 88
  },
  {
    id: 2017,
    code: "PPL",
    name: "Primeira Liga",
    country: "Portugal",
    apiLeagueId: 94
  },
  {
    id: 2001,
    code: "CL",
    name: "UEFA Champions League",
    country: "Europe",
    apiLeagueId: 2
  },

  // România
  {
    id: 3001,
    code: "RO1",
    name: "Superliga",
    country: "Romania",
    apiLeagueId: 283
  },
  {
    id: 3002,
    code: "RO2",
    name: "Liga 2",
    country: "Romania",
    apiLeagueId: 284
  }
];

// -------------------------------------
// Test cheie
// -------------------------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "Cheia API_FOOTBALL_KEY lipsește" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// -------------------------------------
// Competitions -> pentru dropdown în frontend
// -------------------------------------
app.get("/api/competitions", (req, res) => {
  const list = COMPETITIONS.map((c) => ({
    id: c.id,
    code: c.code,
    name: c.name,
    country: c.country
  }));
  res.json(list);
});

// -------------------------------------
// Matches + predicții simple
// -------------------------------------
app.get("/api/matches", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsește în backend" });
    }

    const competitionId = Number(req.query.competitionId);
    if (!competitionId) {
      return res.status(400).json({ error: "competitionId lipsă" });
    }

    const comp = COMPETITIONS.find((c) => c.id === competitionId);
    if (!comp) {
      return res.status(400).json({ error: "competitionId necunoscut" });
    }

    const season = getSeasonYear();

    // Fereastră de 7 zile: azi -> azi + 7
    // după – interval mai larg, fără „oracol” :)
const now = new Date();

// începem de AZI
const fromDate = now;

// mergem 21 de zile în viitor
const toDate = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);

const fromStr = fromDate.toISOString().split("T")[0];
const toStr = toDate.toISOString().split("T")[0];

    const fixtures = await apiFetch("/fixtures", {
      league: comp.apiLeagueId,
      season,
      from: fromStr,
      to: toStr
    });

    // Luăm doar meciuri viitoare (NS = Not Started, TBA etc.)
    const upcoming = fixtures.filter((fx) => {
      const status = fx.fixture?.status?.short;
      return status === "NS" || status === "TBD" || status === "PST";
    });

    const matches = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !league || !teams?.home || !teams?.away) continue;

      const homeName = teams.home.name;
      const awayName = teams.away.name;

      // Fișe rapide de formă (ultimele 6 meciuri acasă / deplasare)
      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const formHome = await apiFetch("/fixtures", {
        team: homeId,
        league: comp.apiLeagueId,
        season,
        last: 6
      });

      const formAway = await apiFetch("/fixtures", {
        team: awayId,
        league: comp.apiLeagueId,
        season,
        last: 6
      });

      const calcForm = (list) => {
        if (!list || list.length === 0) {
          return { avgGF: 1.2, avgGA: 1.2 }; // default
        }

        let gf = 0;
        let ga = 0;
        for (const m of list) {
          const gHome = m.goals?.home ?? 0;
          const gAway = m.goals?.away ?? 0;
          if (m.teams?.home?.id === m.team?.id || m.teams?.home?.id === homeId) {
            gf += gHome;
            ga += gAway;
          } else {
            gf += gAway;
            ga += gHome;
          }
        }

        const n = list.length;
        return {
          avgGF: gf / n,
          avgGA: ga / n
        };
      };

      const homeStats = calcForm(formHome);
      const awayStats = calcForm(formAway);

      // λ pentru Poisson
      const lambdaHome = Math.max(0.2, homeStats.avgGF * 0.55 + awayStats.avgGA * 0.45);
      const lambdaAway = Math.max(0.2, awayStats.avgGF * 0.55 + homeStats.avgGA * 0.45);

      // scoruri probabile brute
      const maxGoals = 6;
      const probMatrix = [];
      let probHome = 0;
      let probDraw = 0;
      let probAway = 0;
      let probOver25 = 0;
      let probBttsYes = 0;

      const poisson = (lambda, k) =>
        (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);

      for (let gh = 0; gh <= maxGoals; gh++) {
        for (let ga = 0; ga <= maxGoals; ga++) {
          const p =
            poisson(lambdaHome, gh) *
            poisson(lambdaAway, ga);

          probMatrix.push({ gh, ga, p });

          if (gh > ga) probHome += p;
          else if (gh === ga) probDraw += p;
          else probAway += p;

          if (gh + ga >= 3) probOver25 += p;
          if (gh > 0 && ga > 0) probBttsYes += p;
        }
      }

      const probOver25Pct = probOver25 * 100;
      const probBttsYesPct = probBttsYes * 100;
      const probHomePct = probHome * 100;
      const probDrawPct = probDraw * 100;
      const probAwayPct = probAway * 100;

      let mainPick = "HOME";
      let mainProb = probHomePct;
      if (probDrawPct > mainProb) {
        mainPick = "DRAW";
        mainProb = probDrawPct;
      }
      if (probAwayPct > mainProb) {
        mainPick = "AWAY";
        mainProb = probAwayPct;
      }

      const confidence = Math.round(
        mainProb -
          Math.abs(probHomePct - probAwayPct) * 0.2 -
          Math.abs(probHomePct - probDrawPct) * 0.1
      );

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: homeName,
        awayTeam: awayName,
        prediction: {
          probHome: probHomePct,
          probDraw: probDrawPct,
          probAway: probAwayPct,
          mainPick,
          confidence,
          goals: {
            over25: probOver25Pct,
            under25: 100 - probOver25Pct
          },
          btts: {
            yes: probBttsYesPct,
            no: 100 - probBttsYesPct
          },
          lambdas: {
            home: lambdaHome,
            away: lambdaAway
          }
        }
      });
    }

    res.json({ matches });
  } catch (e) {
    console.error("Eroare /api/matches:", e);
    res.json({ matches: [] });
  }
});

// factorial simplu pentru Poisson
function factorial(n) {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

// -------------------------------------
app.listen(PORT, () => {
  console.log(`Backend ready on port ${PORT}`);
});
