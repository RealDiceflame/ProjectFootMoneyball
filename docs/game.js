import {TEAM_NAMES, scoreDisplay} from "./scores-data.mjs?v=20260915-games1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
import {ID_FIELDS, TEAM_SUMMARY, validGameId, unpackStats, statGroups, statLabel, statValue, activeStatRows} from "./game-data.mjs?v=20260915-games1";
const $ = id=>document.getElementById(id);
const el = (tag,text,className) => {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const gameId = new URLSearchParams(location.search).get("game");
let busy=false,lastAttempt=0,lastBundle=null,lastGame=null,signature=null;

function table(headers, rows, caption) {
  const wrapper=el("div",undefined,"game-table-wrap");wrapper.tabIndex=0;wrapper.setAttribute("role","region");wrapper.setAttribute("aria-label",caption);
  const grid=el("table"),head=el("thead"),headRow=el("tr"),body=el("tbody");
  for(const label of headers){const cell=el("th",label);cell.scope="col";headRow.append(cell);}head.append(headRow);
  for(const values of rows){const row=el("tr");values.forEach((value,i)=>{const cell=el(i===0?"th":"td",value);if(i===0)cell.scope="row";row.append(cell);});body.append(row);}
  grid.append(head,body);wrapper.append(grid);return wrapper;
}

function teamTable(teams, game, keys, caption) {
  const byTeam=Object.fromEntries(teams.map(row=>[row.team,row]));
  return table(["Statistic",TEAM_NAMES[game.away],TEAM_NAMES[game.home]],
    keys.map(key=>[statLabel(key),statValue(byTeam[game.away]?.[key]),statValue(byTeam[game.home]?.[key])]),caption);
}

function render(game, bundle) {
  const title=`${TEAM_NAMES[game.away]} at ${TEAM_NAMES[game.home]}`;
  $("game-heading").textContent=title;document.title=`${title} · OutlierBaseline`;
  const display=scoreDisplay(game), summary=$("game-summary");
  summary.replaceChildren(...["away","home"].map(side=>{
    const row=el("div",undefined,"game-team"),mark=teamMark(game[side]);mark.width=48;mark.height=48;
    row.append(mark,el("span",TEAM_NAMES[game[side]]),el("strong",display[side]));return row;
  }));
  const time=game.kickoff?new Date(game.kickoff).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Time TBD";
  $("game-status").textContent=`Week ${game.week} · ${time} · ${display.label}`;
  $("game-status").classList.remove("stale");
  const content=$("game-stats");
  if(!bundle){
    content.replaceChildren(el("p","Box score pending. Team and player stats will appear here when the source publishes them."));
    return;
  }
  const {teams,players}=unpackStats(bundle,gameId);
  $("game-status").textContent+=` · Stats updated ${new Date(bundle.updated_at).toLocaleString()}`;
  const nextSignature=bundle.content_sha256;
  if(signature===nextSignature)return;
  const open=new Set([...content.querySelectorAll("details[open]")].map(node=>node.dataset.group));
  const first=signature===null;signature=nextSignature;
  const nodes=[],teamSection=el("section");
  teamSection.append(el("h2","Team comparison"),teamTable(teams,game,TEAM_SUMMARY.filter(key=>bundle.team_columns.includes(key)),"Team comparison"));
  nodes.push(teamSection);
  const all=el("details");all.dataset.group="teams";all.open=open.has("teams");
  all.append(el("summary","All available team statistics"),teamTable(teams,game,bundle.team_columns.filter(key=>!ID_FIELDS.has(key)),"All team statistics"));nodes.push(all);
  nodes.push(el("h2","Player box score"));
  for(const [name,keys] of statGroups(bundle.player_columns)){
    const rows=activeStatRows(players,keys);if(!rows.length)continue;
    const section=el("details");section.dataset.group=name;section.open=open.has(name)||(first&&name==="Passing");
    const values=rows.map(row=>[row.player_id?(row.player_display_name||row.player_name||row.player_id):"Uncredited team events",row.team,row.position||"—",...keys.map(key=>statValue(row[key]))]);
    section.append(el("summary",name),table(["Player","Team","Position",...keys.map(statLabel)],values,`${name} player statistics`));nodes.push(section);
  }
  const unavailable=el("p","Possession time, third/fourth-down conversions, snap counts and play-by-play are not available from this feed.");
  const download=el("a","Download game data","game-download");download.href=`data/game_stats/${bundle.season}/${gameId}.json`;download.download=`${gameId}.json`;
  nodes.push(unavailable,download);content.replaceChildren(...nodes);
}

async function jsonResponse(url) {
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(response.status===404)return null;
  if(!response.ok)throw new Error("Data unavailable");
  return response.json();
}

async function load() {
  if(busy||document.hidden)return;
  if(!validGameId(gameId)){$("game-status").textContent="Choose a game from NFL scores.";return;}
  busy=true;lastAttempt=Date.now();
  try{
    const [scoreResult,statsResult]=await Promise.allSettled([jsonResponse("data/scores.json"),jsonResponse(`data/game_stats/${gameId.slice(0,4)}/${gameId}.json`)]);
    const board=scoreResult.status==="fulfilled"?scoreResult.value:null;
    let bundle=statsResult.status==="fulfilled"?statsResult.value:lastBundle;
    let statsFailed=statsResult.status==="rejected";
    try{if(bundle)unpackStats(bundle,gameId);}catch{bundle=lastBundle;statsFailed=true;}
    const game=(Array.isArray(board?.games)?board.games.find(row=>row?.game_id===gameId):null)||bundle?.game;
    if(!game||!TEAM_NAMES[game.home]||!TEAM_NAMES[game.away])throw new Error("Unknown game");
    if(lastBundle&&!bundle)throw new Error("Previously available box score missing");
    render(game,bundle);lastGame=game;lastBundle=bundle;
    if(scoreResult.status==="rejected"||statsFailed){
      $("game-status").textContent+=" · Some data could not refresh";
      $("game-status").classList.add("stale");
      if(!bundle&&statsFailed)$("game-stats").replaceChildren(el("p","Box score temporarily unavailable. The score remains available above."));
    }
  }catch{
    if(lastGame){render(lastGame,lastBundle);$("game-status").textContent+=" · Refresh unavailable";}
    else $("game-status").textContent="Game data temporarily unavailable. Return to NFL scores to choose a game.";
    $("game-status").classList.add("stale");
  }finally{busy=false;}
}
setInterval(load,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-lastAttempt>=60000)load();});
load();
