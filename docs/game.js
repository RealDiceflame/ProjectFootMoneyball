import {TEAM_NAMES, scoreDisplay, gameConditions} from "./scores-data.mjs?v=20260915-weather1";
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
  return table(["Statistic",`Away · ${TEAM_NAMES[game.away]}`,`Home · ${TEAM_NAMES[game.home]}`],
    keys.map(key=>[statLabel(key),statValue(byTeam[game.away]?.[key]),statValue(byTeam[game.home]?.[key])]),caption);
}

function playerTeamPanel(rows, keys, game, side, category) {
  const team=game[side], label=side==="away"?"Away":"Home";
  const panel=el("section",undefined,"game-stat-team");panel.dataset.team=team;panel.dataset.side=side;
  const heading=el("h4",undefined,"game-stat-team-heading");
  heading.append(teamMark(team),el("span",`${label} · ${TEAM_NAMES[team]}`));
  panel.append(heading);
  // Partition source rows by team, never by name: names need not be unique.
  const teamRows=rows.filter(row=>row.team===team);
  if(!teamRows.length){
    panel.append(el("p","No recorded player stats in this category.","game-stat-empty"));
    return panel;
  }
  const values=teamRows.map(row=>[row.player_id?(row.player_display_name||row.player_name||row.player_id):"Uncredited team events",
    row.position||"—",...keys.map(key=>statValue(row[key]))]);
  panel.append(table(["Player","Position",...keys.map(statLabel)],values,`${label} ${TEAM_NAMES[team]} · ${category}`));
  return panel;
}

function render(game, bundle) {
  const title=`${TEAM_NAMES[game.away]} at ${TEAM_NAMES[game.home]}`;
  $("game-heading").textContent=title;document.title=`${title} · OutlierBaseline`;
  const display=scoreDisplay(game), summary=$("game-summary");
  summary.replaceChildren(...["away","home"].map(side=>{
    const row=el("div",undefined,"game-team"),mark=teamMark(game[side]);mark.width=48;mark.height=48;
    const name=el("div",undefined,"game-team-name");
    name.append(el("small",side==="away"?"Away":"Home"),el("span",TEAM_NAMES[game[side]]));
    row.append(mark,name,el("strong",display[side]));return row;
  }));
  const time=game.kickoff?new Date(game.kickoff).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Time TBD";
  $("game-status").textContent=`Week ${game.week} · ${time} · ${display.label}`;
  $("game-status").classList.remove("stale");
  const conditions=gameConditions(game);
  $("game-conditions").textContent=[game.stadium,conditions.location,conditions.weather].filter(Boolean).join(" · ");
  const content=$("game-stats");
  if(!bundle){
    content.replaceChildren(el("p","Box score pending. Team and player stats will appear here when the source publishes them."));
    return;
  }
  const {teams,players}=unpackStats(bundle,gameId);
  $("game-status").textContent+=` · Stats updated ${new Date(bundle.updated_at).toLocaleString()}`;
  const nextSignature=bundle.content_sha256;
  if(signature===nextSignature)return;
  signature=nextSignature;
  const nodes=[],teamSection=el("section");
  teamSection.append(el("h2","Team comparison"),teamTable(teams,game,TEAM_SUMMARY.filter(key=>bundle.team_columns.includes(key)),"Team comparison"));
  nodes.push(teamSection);
  nodes.push(el("h2","Player box score"));
  for(const [name,keys] of statGroups(bundle.player_columns)){
    const rows=activeStatRows(players,keys);if(!rows.length)continue;
    const section=el("section",undefined,"game-stat-category");section.dataset.group=name;
    const heading=el("h3",name);heading.id=`stat-${name.toLowerCase()}`;
    section.setAttribute("aria-labelledby",heading.id);
    const sides=el("div",undefined,"game-stat-sides");
    sides.append(...["away","home"].map(side=>playerTeamPanel(rows,keys,game,side,name)));
    section.append(heading,sides);nodes.push(section);
  }
  const all=el("section");all.dataset.group="teams";
  all.append(el("h2","All available team statistics"),
    teamTable(teams,game,bundle.team_columns.filter(key=>!ID_FIELDS.has(key)),"All team statistics"));
  nodes.push(all);
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
