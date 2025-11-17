import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// cheia din Render -> Environment -> FOOTBALL_DATA_KEY
const API_KEY = process.env.FOOTBALL_DATA_KEY;
const API_BASE = "https://api.football-data.org/v4";

app.use(cors());
app.use(express.json());

// cache simplu în memorie (ms)
const CACHE_TTL_MS = 2 * 60 * 1000;

const cache = {
  competitions: { data: null, timestamp: 0 },
  standings: {}, // [competitionId]: { data, timestamp }
  matches: {}    // [competitionId]: { data, timestamp }
};

// helper: verifică dacă un cache e valid
function isValidCache(entry) {
  return entry && entry.data && Date.now() - entry.timestamp < CACHE_TTL_MS;
}

// helper: data ISO scurtă
function formatDate(d) {
  return d.toISOString().split("T")[0];
}

// ----------------------
// ROOT + test cheie
// ----------------------
app.get("/", (req, res) => {
  res.send("Football backend OK (football-data.org)");
});

app.get("/api/test-key", (req, res) => {
  if (!API_KEY) {
    return res.json({ ok: false, message: "FOOTBALL_DATA_KEY lipsă în backend" });
  }
  return res.json({ ok: true, message: "Cheie OK" });
});

// ----------------------
// helper: fetch generic
// ----------------------
async function fdGet(path, params = {}) {
  if (!API_KEY) {
    throw new Error("FOOTBALL_DATA_KEY lipsă în backend");
  }

  const url = new URL(API_BASE + path);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") {
      url.searchParams.set(k, String(v));
    }
  });

  const resp = await fetch(url.toString(), {
    headers: {
      "X-Auth-Token": API_KEY
    }
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Eroare ${resp.status} la ${url.toString()}:`, text);
    const err = new Error("Eroare la football-data.org");
    err.status = resp.status;
    throw err;
  }

  return resp.json();
}

// ----------------------
// 1. COMPETIȚII (ligile mari)
// ----------------------
app.get("/api/competitions", async (req, res) => {
  try {
    if (isValidCache(cache.competitions)) {
      return res.json(cache.competitions.data);
    }

    const data = await fdGet("/competitions");

    const allowedCodes = ["PL", "PD", "SA", "BL1", "FL1", "DED", "PPL", "CL"];

    const comps = (data.competitions || [])
      .filter(c => allowedCodes.includes(c.code))
      .map(c => ({
        id: c.id,
        code: c.code,
        name: c.name,
        country: c.area?.name || ""
      }));

    cache.competitions = {
      data: comps,
      timestamp: Date.now()
    };

    return res.json(comps);
  } catch (err) {
    console.error("Eroare /api/competitions:", err);
    const status = err.status || 500;
    return res.status(status).json({ error: "Eroare la competiții" });
  }
});

// ----------------------
// helper: ia standings pentru o competiție
// ----------------------
async function getStandings(competitionId) {
  const cached = cache.standings[competitionId];
  if (isValidCache(cached)) return cached.data;

  const data = await fdGet(`/competitions/${competitionId}/standings`);

  const totalTable = (data.standings || []).find(s => s.type === "TOTAL");
  const table = totalTable?.table || [];

  cache.standings[competitionId] = {
    data: table,
    timestamp: Date.now()
  };

  return table;
}

// ----------------------
// helper: rating de echipă din standings
// ----------------------
function buildTeamRating(entry, maxPos) {
  const played = entry.playedGames || 1;
  const gf = entry.goalsFor || 0;
  const ga = entry.goalsAgainst || 0;
  const pos = entry.position || maxPos;

  const avgGF = gf / played;
  const avgGA = ga / played;

  const attackScore = avgGF;
  const defenseScore = 3 - Math.min(avgGA, 3); // cu cât primește mai puțin, cu atât mai mare

  const positionFactor = (maxPos - pos + 1) / maxPos; // 0..1

  const rawStrength = attackScore + defenseScore + 2 * positionFactor;

  return { avgGF, avgGA, rawStrength };
}

// ----------------------
// helper: predicție din 2 ratinguri
// ----------------------
function buildPrediction(homeRating, awayRating) {
  const diff = homeRating.rawStrength - awayRating.rawStrength;
  const normDiff = Math.max(-1, Math.min(1, diff / 4));

  // scoruri brute
  let sHome = 0.4 + normDiff * 0.25;
  let sAway = 0.3 - normDiff * 0.25;
  let sDraw = 0.3;

  const clamp = (v) => Math.max(0.05, Math.min(0.85, v));
  sHome = clamp(sHome);
  sAway = clamp(sAway);
  sDraw = clamp(sDraw);

  let sum = sHome + sDraw + sAway;
  sHome /= sum;
  sDraw /= sum;
  sAway /= sum;

  let pHome = Math.round(sHome * 100);
  let pDraw = Math.round(sDraw * 100);
  let pAway = Math.round(sAway * 100);

  let total = pHome + pDraw + pAway;
  if (total !== 100) {
    const diffSum = 100 - total;
    if (pHome >= pDraw && pHome >= pAway) pHome += diffSum;
    else if (pAway >= pHome && pAway >= pDraw) pAway += diffSum;
    else pDraw += diffSum;
  }

  const maxP = Math.max(pHome, pDraw, pAway);
  let mainPick = "HOME";
  if (maxP === pDraw) mainPick = "DRAW";
  if (maxP === pAway) mainPick = "AWAY";

  const sorted = [pHome, pDraw, pAway].sort((a, b) => b - a);
  const confidence = Math.max(40, Math.min(90, sorted[0] - sorted[1] + 50));

  const avgGFHome = homeRating.avgGF;
  const avgGFAway = awayRating.avgGF;
  const xGTotal = avgGFHome + avgGFAway;

  let over25 = 35 + (xGTotal - 2.5) * 25;
  over25 = Math.max(15, Math.min(85, over25));
  const under25 = 100 - Math.round(over25);

  let bttsYes = (avgGFHome > 1 && avgGFAway > 1) ? 60 : 40;
  bttsYes = Math.max(20, Math.min(80, bttsYes));
  const bttsNo = 100 - bttsYes;

  return {
    probHome: pHome,
    probDraw: pDraw,
    probAway: pAway,
    mainPick,
    confidence,
    goals: {
      over25: Math.round(over25),
      under25
    },
    btts: {
      yes: Math.round(bttsYes),
      no: bttsNo
    },
    explain: {
      home: {
        avgGF: +avgGFHome.toFixed(2),
        avgGA: +homeRating.avgGA.toFixed(2)
      },
      away: {
        avgGF: +avgGFAway.toFixed(2),
        avgGA: +awayRating.avgGA.toFixed(2)
      }
    }
  };
}

// ----------------------
// 2. MECIURI + PREDICȚII
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
        .json({ error: "FOOTBALL_DATA_KEY lipsă în backend" });
    }

    const cached = cache.matches[competitionId];
    if (isValidCache(cached)) {
      return res.json(cached.data);
    }

    // perioada: azi + 7 zile
    const today = new Date();
    const dateFrom = formatDate(today);

    const to = new Date(today);
    to.setDate(today.getDate() + 7);
    const dateTo = formatDate(to);

    // standings pentru ligă
    const table = await getStandings(competitionId);
    const maxPos = table.length || 20;

    const ratingsByTeamId = {};
    for (const row of table) {
      const teamId = row.team?.id;
      if (!teamId) continue;
      ratingsByTeamId[teamId] = buildTeamRating(row, maxPos);
    }

    // meciuri programate
    const data = await fdGet(`/competitions/${competitionId}/matches`, {
      status: "SCHEDULED",
      dateFrom,
      dateTo
    });

    const matchesRaw = data.matches || [];

    const matches = matchesRaw.map(m => {
      const homeTeam = m.homeTeam || {};
      const awayTeam = m.awayTeam || {};

      const defaultEntry = {
        playedGames: 1,
        goalsFor: 1,
        goalsAgainst: 1,
        position: Math.ceil(maxPos / 2)
      };

      const homeRating = ratingsByTeamId[homeTeam.id] ||
        buildTeamRating(defaultEntry, maxPos);
      const awayRating = ratingsByTeamId[awayTeam.id] ||
        buildTeamRating(defaultEntry, maxPos);

      const prediction = buildPrediction(homeRating, awayRating);

      return {
        id: m.id,
        utcDate: m.utcDate,
        competition: m.competition?.name,
        homeTeam: homeTeam.name,
        awayTeam: awayTeam.name,
        prediction
      };
    });

    const payload = { matches };

    cache.matches[competitionId] = {
      data: payload,
      timestamp: Date.now()
    };

    return res.json(payload);
  } catch (err) {
    console.error("Eroare /api/matches:", err);
    const status = err.status || 500;
    return res.status(status).json({ error: "Eroare la meciuri" });
  }
});

// ----------------------
// PORNIRE SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`Backend pornit pe port ${PORT}`);
});
