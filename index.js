import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = "https://v3.football.api-sports.io";

app.use(cors());
app.use(express.json());

// --------------------------------------
// Cache simplu în memorie
// --------------------------------------
const CACHE_TTL = 60 * 1000; // 60 secunde

const cache = {
  competitions: { data: null, timestamp: 0 },
  matches: {} // key: competitionId -> { data, timestamp }
};

// --------------------------------------
// Helper: apel la API-FOOTBALL
// --------------------------------------
async function apiFetch(path, params = {}) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) {
      url.searchParams.append(k, String(v));
    }
  });

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "x-apisports-key": API_KEY
    }
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("API-FOOTBALL HTTP error:", res.status, text);
    return null;
  }

  const json = await res.json();
  return json.response || null;
}

// --------------------------------------
// Test cheie
// --------------------------------------
app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "Cheie lipsă în backend" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// --------------------------------------
// Competitions (inclus SuperLiga + Liga 2 RO)
// --------------------------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (!API_KEY) {
      return res
        .status(500)
        .json({ error: "API_FOOTBALL_KEY lipsă în backend" });
    }

    if (
      cache.competitions.data &&
      Date.now() - cache.competitions.timestamp < CACHE_TTL
    ) {
      return res.json(cache.competitions.data);
    }

    const leagues = await apiFetch("/leagues", { current: true });
    if (!leagues) {
      return res
        .status(500)
        .json({ error: "Eroare de la API-FOOTBALL la /leagues" });
    }

    // Ligi principale + România
    const wantedIds = [
      39, // Premier League
      61, // Ligue 1
      78, // Bundesliga
      135, // Serie A
      140, // LaLiga
      2, // Champions League
      283, // România - SuperLiga
      284 // România - Liga 2
    ];

    const data = leagues
      .filter((l) => wantedIds.includes(l.league.id))
      .map((l) => {
        const currentSeason =
          l.seasons.find((s) => s.current)?.year ||
          l.seasons[l.seasons.length - 1]?.year ||
          2024;

        return {
          id: l.league.id,
          code: l.league.code,
          name: l.league.name,
          country: l.country.name,
          season: currentSeason,
          apiLeagueId: l.league.id
        };
      });

    cache.competitions = {
      data,
      timestamp: Date.now()
    };

    return res.json(data);
  } catch (err) {
    console.error("Eroare /api/competitions:", err);
    return res.status(500).json({ error: "Eroare internă la competiții" });
  }
});

// --------------------------------------
// Formă echipă (ultimele 10 meciuri)
// --------------------------------------
async function getTeamForm(teamId, season) {
  const fixtures = await apiFetch("/fixtures", {
    team: teamId,
    season,
    last: 10
  });

  if (!fixtures || fixtures.length === 0) {
    return {
      avgGF: 1.2,
      avgGA: 1.2
    };
  }

  let gf = 0;
  let ga = 0;

  for (const fx of fixtures) {
    const isHome = fx.teams.home.id === teamId;
    const goalsFor = isHome ? fx.goals.home : fx.goals.away;
    const goalsAgainst = isHome ? fx.goals.away : fx.goals.home;
    gf += goalsFor;
    ga += goalsAgainst;
  }

  const n = fixtures.length;

  return {
    avgGF: gf / n,
    avgGA: ga / n
  };
}

// --------------------------------------
// Meciuri + predicții simple Poisson
// --------------------------------------
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

    const competitionsCached = cache.competitions.data;
    let season = 2024;

    if (competitionsCached) {
      const comp = competitionsCached.find(
        (c) => String(c.id) === String(competitionId)
      );
      if (comp) {
        season = comp.season;
      }
    }

    const now = new Date();
    const to = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);

    const fromStr = now.toISOString().split("T")[0];
    const toStr = to.toISOString().split("T")[0];

    const cacheKey = `${competitionId}_${season}`;
    if (
      cache.matches[cacheKey] &&
      Date.now() - cache.matches[cacheKey].timestamp < CACHE_TTL
    ) {
      return res.json(cache.matches[cacheKey].data);
    }

    const fixtures = await apiFetch("/fixtures", {
      league: competitionId,
      season,
      from: fromStr,
      to: toStr
    });

    if (!fixtures) {
      return res.status(500).json({ error: "Eroare la fixtures" });
    }

    const upcoming = fixtures.filter((fx) => {
      const st = fx.fixture.status.short;
      return st === "NS" || st === "TBD";
    });

    const matches = [];

    for (const fx of upcoming) {
      const fixture = fx.fixture;
      const league = fx.league;
      const teams = fx.teams;

      if (!fixture || !teams?.home || !teams?.away) continue;

      const homeId = teams.home.id;
      const awayId = teams.away.id;

      const homeForm = await getTeamForm(homeId, season);
      const awayForm = await getTeamForm(awayId, season);

      const lambdaHome = Math.max(
        0.2,
        (homeForm.avgGF + awayForm.avgGA) / 2
      );
      const lambdaAway = Math.max(
        0.2,
        (awayForm.avgGF + homeForm.avgGA) / 2
      );

      const total = lambdaHome + lambdaAway;

      const probHome = Math.round((lambdaHome / total) * 100);
      const probAway = Math.round((lambdaAway / total) * 100);
      const probDraw = Math.max(0, 100 - probHome - probAway);

      let pick = "DRAW";
      let conf = probDraw;
      if (probHome >= probAway && probHome >= probDraw) {
        pick = "HOME";
        conf = probHome;
      } else if (probAway >= probHome && probAway >= probDraw) {
        pick = "AWAY";
        conf = probAway;
      }

      matches.push({
        id: fixture.id,
        utcDate: fixture.date,
        competition: league.name,
        homeTeam: teams.home.name,
        awayTeam: teams.away.name,
        prediction: {
          probHome,
          probDraw,
          probAway,
          mainPick: pick,
          confidence: conf
        },
        explain: {
          home: {
            avgGF: Number(homeForm.avgGF.toFixed(2)),
            avgGA: Number(homeForm.avgGA.toFixed(2))
          },
          away: {
            avgGF: Number(awayForm.avgGF.toFixed(2)),
            avgGA: Number(awayForm.avgGA.toFixed(2))
          },
          lambdas: {
            home: Number(lambdaHome.toFixed(2)),
            away: Number(lambdaAway.toFixed(2))
          }
        }
      });
    }

    const payload = { matches };
    cache.matches[cacheKey] = {
      data: payload,
      timestamp: Date.now()
    };

    return res.json(payload);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    return res.status(500).json({ error: "Eroare la meciuri" });
  }
});

// --------------------------------------
app.listen(PORT, () => {
  console.log(`Backend ready pe portul ${PORT}`);
});
