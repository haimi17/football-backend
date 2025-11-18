// index.js – backend API-FOOTBALL pentru Football Pro Analyzer

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

if (!API_KEY) {
  console.error("ATENȚIE: variabila de mediu API_FOOTBALL_KEY nu este setată!");
}

const API_BASE = "https://v3.football.api-sports.io";

// sezonul actual
function getCurrentSeason() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m >= 7 ? y : y - 1;
}
const CURRENT_SEASON = getCurrentSeason();

// competiții
const COMPETITIONS = [
  { id: 39, code: "PL", name: "Premier League", apiLeagueId: 39, season: CURRENT_SEASON },
  { id: 135, code: "SA", name: "Serie A", apiLeagueId: 135, season: CURRENT_SEASON },
  { id: 140, code: "PD", name: "La Liga", apiLeagueId: 140, season: CURRENT_SEASON },
  { id: 61, code: "L1", name: "Ligue 1", apiLeagueId: 61, season: CURRENT_SEASON },
  { id: 78, code: "BL1", name: "Bundesliga", apiLeagueId: 78, season: CURRENT_SEASON },
  { id: 88, code: "DED", name: "Eredivisie", apiLeagueId: 88, season: CURRENT_SEASON },
  { id: 283, code: "RO1", name: "Superliga", apiLeagueId: 283, season: CURRENT_SEASON },
  { id: 284, code: "RO2", name: "Liga 2", apiLeagueId: 284, season: CURRENT_SEASON }
];

// cache
const teamStatsCache = new Map();
const teamFormCache = new Map();

// utils
function formatDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

const factCache = {};
function factorial(n) {
  if (n <= 1) return 1;
  if (factCache[n]) return factCache[n];
  let r = 1;
  for (let i=2;i<=n;i++) r*=i;
  factCache[n]=r;
  return r;
}

function poissonPMF(lambda, k) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function clamp(v,min,max){return Math.max(min,Math.min(max,v));}

// API fetch
async function apiFetch(endpoint, params) {
  const url = new URL(`${API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([k,v])=>{
      if (v!==undefined && v!==null) url.searchParams.set(k,String(v));
    });
  }

  const res = await fetch(url.toString(),{
    headers:{
      "x-apisports-key":API_KEY,
      accept:"application/json"
    }
  });

  const text = await res.text();
  let json;
  try{ json = text ? JSON.parse(text) : {}; } catch{ json = {}; }

  if (!res.ok){
    const msg =
      json?.errors?.token ||
      json?.errors?.server ||
      json?.errors?.requests ||
      text ||
      `Status ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function apiFetchWithRetry(endpoint, params, retries=2){
  let last;
  for (let i=0;i<=retries;i++){
    try{
      if(i>0) console.warn(`Retry ${i} la ${endpoint}...`);
      return await apiFetch(endpoint, params);
    }catch(e){
      last=e;
      if(e.status<500) break;
    }
  }
  throw last;
}

// Stats
async function getTeamStats(league,season,team){
  const key=`${league}-${season}-${team}`;
  if(teamStatsCache.has(key)) return teamStatsCache.get(key);

  try{
    const d=await apiFetchWithRetry("/teams/statistics",{league,season,team});
    const stats=d?.response;
    teamStatsCache.set(key,stats||null);
    return stats||null;
  }catch(e){
    console.error("stats error:",e.message);
    teamStatsCache.set(key,null);
    return null;
  }
}

// formă recentă
async function getTeamRecentForm(league,season,team){
  const key=`${league}-${season}-${team}-recent`;
  if(teamFormCache.has(key)) return teamFormCache.get(key);

  try{
    const d=await apiFetchWithRetry("/fixtures",{league,season,team,last:5});
    const resp=d?.response||[];
    if(!resp.length){teamFormCache.set(key,null);return null;}

    const list=resp.map(f=>{
      const isHome=f.teams?.home?.id===team;
      const gf=isHome?f.goals?.home:f.goals?.away;
      const ga=isHome?f.goals?.away:f.goals?.home;
      return {home:isHome,goalsFor:gf||0,goalsAgainst:ga||0};
    });

    teamFormCache.set(key,list);
    return list;
  }catch(e){
    console.error("recent error:",e.message);
    teamFormCache.set(key,null);
    return null;
  }
}

// fixtures stabile
async function getFixturesForCompetition(comp){
  try{
    const d=await apiFetchWithRetry("/fixtures",{league:comp.apiLeagueId,season:comp.season,next:30});
    if(d?.response?.length) return d.response;
  }catch{}

  try{
    const t=new Date();
    const from=formatDate(t);
    const toD=new Date(t);toD.setDate(toD.getDate()+30);
    const to=formatDate(toD);

    const d=await apiFetchWithRetry("/fixtures",{league:comp.apiLeagueId,season:comp.season,from,to});
    if(d?.response?.length) return d.response;
  }catch{}

  return [];
}

// form factor
function computeFormFactor(list){
  if(!list||!list.length) return {attack:1,defense:1,matches:0};
  let gf=0,ga=0;
  list.forEach(m=>{gf+=m.goalsFor;ga+=m.goalsAgainst;});
  const n=list.length;
  const avgGF=gf/n, avgGA=ga/n;
  const base=1.3;
  let atk=0.7+0.3*(avgGF/base);
  let def=0.7+0.3*(base/Math.max(avgGA,0.3));
  return {
    attack:clamp(atk,0.6,1.4),
    defense:clamp(def,0.6,1.4),
    matches:n
  };
}

// claritate distribuție
function computeDistributionClarity(h,d,a){
  const s=[h,d,a].sort((x,y)=>y-x);
  const diff=(s[0]-s[1])/100;
  return Number(Math.min(1,diff/0.4).toFixed(2));
}

// încredere realistă
function buildRealConfidence({probHome,probDraw,probAway,context}){
  let dataQ=0.3,sample=0.3;

  if(context){
    const h=context.homeMatchesTotal||0,a=context.awayMatchesTotal||0;
    if(h>=5&&a>=5) dataQ=1;
    else if(h>=3&&a>=3) dataQ=0.7;
    else dataQ=0.4;
    sample=Math.min(1,(h+a)/40);
  }

  let recent=0.3;
  if(context){
    const m=Math.min(context.homeRecentMatches||0,context.awayRecentMatches||0);
    if(m>=5) recent=1;
    else if(m>=3) recent=0.7;
    else if(m>=1) recent=0.5;
  }

  const clarity=computeDistributionClarity(probHome,probDraw,probAway);

  const score=dataQ*0.35 + sample*0.25 + clarity*0.25 + recent*0.15;
  const pct=Math.round(Math.max(0,Math.min(1,score))*100);

  let label="scăzută";
  if(pct>=60) label="ridicată";
  else if(pct>=40) label="medie";

  return {percent:pct,components:{dataQ,sample,clarity,recent},label};
}

// matchProfile
function getMatchProfile(p){
  const {over25, under25} = p.goals;
  const h=p.probHome, d=p.probDraw, a=p.probAway;
  const b=p.btts.yes;

  if(over25>=60 && b>=55) return "GOALS_GAME";
  if(h>=50 && under25>=55) return "HOME_AND_UNDER";
  if(Math.abs(h-a)<=10 && b>=60) return "BALANCED_BTTS";
  if(h<40 && a<40 && d>25) return "HIGH_VARIANCE";
  if(h>=55) return "STRONG_HOME";
  if(a>=55) return "STRONG_AWAY";

  return "NEUTRAL";
}

// dataFlag
function getDataFlag(ctx){
  const dq=ctx.dataQuality;
  const sm=ctx.sampleSize;
  const rc=ctx.recentFactor;

  if(dq>=0.8 && sm>=0.6 && rc>=0.7) return "GOOD_DATA";
  if(dq>=0.5 && sm>=0.4) return "OK_DATA";
  return "LOW_DATA";
}

// predicție
function buildPrediction(lambdaHome,lambdaAway,ctx){
  const max=7;
  const pH=[],pA=[];
  for(let k=0;k<=max;k++){
    pH[k]=poissonPMF(lambdaHome,k);
    pA[k]=poissonPMF(lambdaAway,k);
  }

  let wH=0,wD=0,wA=0,ov=0,b=0;
  for(let h=0;h<=max;h++){
    for(let a=0;a<=max;a++){
      const p=pH[h]*pA[a];
      if(h>a) wH+=p;
      else if(h===a) wD+=p;
      else wA+=p;
      if(h+a>=3) ov+=p;
      if(h>0&&a>0) b+=p;
    }
  }

  const probHome=wH*100, probDraw=wD*100, probAway=wA*100;
  const over25=ov*100;
  const bttsYes=b*100;

  const real=buildRealConfidence({probHome,probDraw,probAway,context:ctx});
  const confidence=clamp(real.percent,25,75);

  const out={
    probHome,
    probDraw,
    probAway,
    mainPick:[{key:"HOME",val:probHome},{key:"DRAW",val:probDraw},{key:"AWAY",val:probAway}].sort((a,b)=>b.val-a.val)[0].key,
    confidence,
    confidenceDetails:{
      ...real,
      dataQuality:ctx.dataQuality,
      sampleSize:ctx.sampleSize,
      recentFactor:ctx.recentFactor
    },
    goals:{over25,under25:100-over25},
    btts:{yes:bttsYes,no:100-bttsYes},
    lambdas:{
      home: Number(lambdaHome.toFixed(2)),
      away: Number(lambdaAway.toFixed(2))
    }
  };

  out.matchProfile = getMatchProfile(out);
  out.dataFlag = getDataFlag({
    dataQuality: ctx.dataQuality,
    sampleSize: ctx.sampleSize,
    recentFactor: ctx.recentFactor
  });

  return out;
}

// predicție completă
async function buildPredictionForFixture(comp, f){
  const home=f.teams?.home?.id;
  const away=f.teams?.away?.id;

  let lH=1.35,lA=1.25;

  let ctx={
    homeMatchesTotal:0,
    awayMatchesTotal:0,
    homeRecentMatches:0,
    awayRecentMatches:0,
    dataQuality:0.3,
    sampleSize:0.3,
    recentFactor:0.3
  };

  if(home&&away){
    try{
      const [stH,stA,rH,rA]=await Promise.all([
        getTeamStats(comp.apiLeagueId,comp.season,home),
        getTeamStats(comp.apiLeagueId,comp.season,away),
        getTeamRecentForm(comp.apiLeagueId,comp.season,home),
        getTeamRecentForm(comp.apiLeagueId,comp.season,away)
      ]);

      if(stH&&stA){
        const hP=stH.fixtures?.played?.home||0;
        const hGF=stH.goals?.for?.total?.home||0;
        const hGA=stH.goals?.against?.total?.home||0;

        const aP=stA.fixtures?.played?.away||0;
        const aGF=stA.goals?.for?.total?.away||0;
        const aGA=stA.goals?.against?.total?.away||0;

        const hAvgF=hP?hGF/hP:1.4;
        const hAvgA=hP?hGA/hP:1.2;
        const aAvgF=aP?aGF/aP:1.3;
        const aAvgA=aP?aGA/aP:1.2;

        lH=(hAvgF+aAvgA)/2;
        lA=(aAvgF+hAvgA)/2;

        lH*=1.1;
        lA*=0.95;

        lH=clamp(lH,0.4,3.2);
        lA=clamp(lA,0.4,3.2);

        let fH=computeFormFactor(rH);
        let fA=computeFormFactor(rA);

        lH*=fH.attack*fA.defense;
        lA*=fA.attack*fH.defense;

        lH=clamp(lH,0.4,3.2);
        lA=clamp(lA,0.4,3.2);

        ctx.homeMatchesTotal=stH.fixtures?.played?.total||0;
        ctx.awayMatchesTotal=stA.fixtures?.played?.total||0;
        ctx.homeRecentMatches=fH.matches;
        ctx.awayRecentMatches=fA.matches;

        ctx.dataQuality = ctx.homeMatchesTotal>=5 && ctx.awayMatchesTotal>=5 ? 1 :
                          ctx.homeMatchesTotal>=3 && ctx.awayMatchesTotal>=3 ? 0.7 : 0.4;
        ctx.sampleSize = Math.min(1,(ctx.homeMatchesTotal+ctx.awayMatchesTotal)/40);
        ctx.recentFactor = fH.matches>=5 && fA.matches>=5 ? 1 :
                           fH.matches>=3 && fA.matches>=3 ? 0.7 :
                           fH.matches>=1 && fA.matches>=1 ? 0.5 : 0.3;
      }
    }catch(e){}
  }

  return buildPrediction(lH,lA,ctx);
}

// rute
app.get("/api/test-key",(req,res)=>res.json({ok:!!API_KEY,message:API_KEY?"Cheie OK":"Missing"}));

app.get("/api/provider-status", async(req,res)=>{
  if(!API_KEY) return res.json({ok:false,status:"NO_KEY"});
  try{
    const d=await apiFetchWithRetry("/status",null,1);
    res.json({ok:true,status:"OK",raw:d});
  }catch(e){
    res.json({ok:false,status:e.status||"ERR",message:e.message});
  }
});

app.get("/api/competitions",(req,res)=>{
  res.json(COMPETITIONS.map(c=>({
    id:c.id,code:c.code,name:c.name,apiLeagueId:c.apiLeagueId,season:c.season
  })));
});

app.get("/api/matches", async(req,res)=>{
  const comp=COMPETITIONS.find(c=>c.id==req.query.competitionId);
  if(!comp) return res.json({matches:[],apiErrors:["Competiție necunoscută"]});

  const errors=[];
  try{
    const fixtures=await getFixturesForCompetition(comp);
    if(!fixtures.length) return res.json({matches:[],apiErrors:["Nu există meciuri"]});

    const matches=[];
    for(const f of fixtures){
      const pred=await buildPredictionForFixture(comp,f);
      matches.push({
        id:f.fixture?.id,
        utcDate:f.fixture?.date,
        competition:comp.name,
        homeTeam:f.teams?.home?.name,
        awayTeam:f.teams?.away?.name,
        prediction:pred
      });
    }
    res.json({matches,apiErrors:errors});
  }catch(e){
    errors.push(e.message);
    res.json({matches:[],apiErrors:errors});
  }
});

app.listen(PORT,()=>console.log(`Backend pornit | sezon ${CURRENT_SEASON}`));
