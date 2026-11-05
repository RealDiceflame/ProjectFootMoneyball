import {scoreDisplay, gameConditions} from "./scores-data.mjs?v=20260915-weather1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
import {ID_FIELDS, TEAM_SUMMARY, validGameId, validGameIdentity, gameTeamName, gameSnapshotTime, unpackStats, statGroups, statLabel, statValue, activeStatRows} from "./game-data.mjs?v=20261030-historical1";
import {validateSnapCounts, snapValue, snapRowsForTeam} from "./snap-data.mjs?v=20261030-snaps1";
const $ = id=>document.getElementById(id);
const el = (tag,text,className) => {const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const gameId = new URLSearchParams(location.search).get("game");
let busy=false,lastAttempt=0,lastBundle=null,lastGame=null,signature=null,historicalView=false;
let lastSnaps=null,snapSignature=null;

function gameMark(team) {
  if (!historicalView && !["OAK","SD","STL"].includes(team)) return teamMark(team);
  // Preserve historical franchise codes without presenting a modern logo as an
  // era-specific asset, or requesting a nonexistent null image URL.
  const mark=el("span",team,"team-logo");mark.setAttribute("aria-hidden","true");return mark;
}
const teamName = team => gameTeamName(team,Number(gameId?.slice(0,4)));

function table(headers, rows, caption) {
  const wrapper=el("div",undefined,"game-table-wrap");wrapper.tabIndex=0;wrapper.setAttribute("role","region");wrapper.setAttribute("aria-label",caption);
  const grid=el("table"),head=el("thead"),headRow=el("tr"),body=el("tbody");
  for(const label of headers){const cell=el("th",label);cell.scope="col";headRow.append(cell);}head.append(headRow);
  for(const values of rows){const row=el("tr");values.forEach((value,i)=>{const cell=el(i===0?"th":"td",value);if(i===0)cell.scope="row";row.append(cell);});body.append(row);}
  grid.append(head,body);wrapper.append(grid);return wrapper;
}

function teamTable(teams, game, keys, caption) {
  const byTeam=Object.fromEntries(teams.map(row=>[row.team,row]));
  return table(["Statistic",`Away · ${teamName(game.away)}`,`Home · ${teamName(game.home)}`],
    keys.map(key=>[statLabel(key),statValue(byTeam[game.away]?.[key]),statValue(byTeam[game.home]?.[key])]),caption);
}

function playerTeamPanel(rows, keys, game, side, category) {
  const team=game[side], label=side==="away"?"Away":"Home";
  const panel=el("section",undefined,"game-stat-team");panel.dataset.team=team;panel.dataset.side=side;
  const heading=el("h4",undefined,"game-stat-team-heading");
  heading.append(gameMark(team),el("span",`${label} · ${teamName(team)}`));
  panel.append(heading);
  // Partition source rows by team, never by name: names need not be unique.
  const teamRows=rows.filter(row=>row.team===team);
  if(!teamRows.length){
    panel.append(el("p","No recorded player stats in this category.","game-stat-empty"));
    return panel;
  }
  const values=teamRows.map(row=>[row.player_id?(row.player_display_name||row.player_name||row.player_id):"Uncredited team events",
    row.position||"—",...keys.map(key=>statValue(row[key]))]);
  panel.append(table(["Player","Position",...keys.map(statLabel)],values,`${label} ${teamName(team)} · ${category}`));
  return panel;
}

function render(game, bundle) {
  historicalView=bundle?.historical===true;
  const context=new URLSearchParams({season:gameId.slice(0,4),week:String(game.week)});
  $("game-results-link").href=`stats.html?${context}`;
  context.set("view","leaders");$("game-leaders-link").href=`stats.html?${context}`;
  const title=`${teamName(game.away)} at ${teamName(game.home)}`;
  $("game-heading").textContent=title;document.title=`${title} · OutlierBaseline`;
  const display=scoreDisplay(game), summary=$("game-summary");
  summary.replaceChildren(...["away","home"].map(side=>{
    const row=el("div",undefined,"game-team"),mark=gameMark(game[side]);mark.width=48;mark.height=48;
    const name=el("div",undefined,"game-team-name");
    name.append(el("small",side==="away"?"Away":"Home"),el("span",teamName(game[side])));
    row.append(mark,name,el("strong",display[side]));return row;
  }));
  const time=game.kickoff?new Date(game.kickoff).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Time TBD";
  const historical=bundle?.historical===true;
  $("game-status").textContent=`${historical?`${bundle.season} historical regular-season archive · `:""}Week ${game.week} · ${time} · ${display.label}`;
  $("game-status").classList.remove("stale");
  const conditions=gameConditions(game);
  $("game-conditions").textContent=[game.stadium,conditions.location,conditions.weather].filter(Boolean).join(" · ");
  const content=$("game-stats");
  if(!bundle){
    content.replaceChildren(el("p","Box score pending. Team and player stats will appear here when the source publishes them."));
    return;
  }
  const {teams,players}=unpackStats(bundle,gameId);
  const statsTime=gameSnapshotTime(bundle.updated_at);
  $("game-status").textContent+=statsTime.valid?` · ${historical?"Archive snapshot":"Stats updated"} ${new Date(bundle.updated_at).toLocaleString()}`:" · Stats update time unavailable";
  if(historical)$("game-status").textContent+=" · Historical statistics may be corrected";
  if(!statsTime.valid)$("game-status").classList.add("stale");
  const nextSignature=bundle.content_sha256 || JSON.stringify([bundle.team_columns,bundle.player_columns,bundle.teams,bundle.players]);
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
  const unavailable=el("p","Possession time and third/fourth-down conversions are not available from this box-score feed. Snap counts and 2025 regular-season play-by-play are reported separately below.");
  const download=el("a","Download game data","game-download");download.href=`data/game_stats/${bundle.season}/${gameId}.json`;download.download=`${gameId}.json`;
  nodes.push(unavailable,download);content.replaceChildren(...nodes);
}

function renderSnaps(game, bundle, failed=false) {
  const status=$("game-snaps-status"), content=$("game-snaps-tables");
  $("game-snaps-issues").textContent="";
  status.classList.remove("stale");
  if(failed)status.classList.add("stale");
  if(!bundle){
    status.textContent=failed?"Snap counts could not refresh. Box scores remain available.":"Snap counts are not yet available for this game.";
    content.replaceChildren();snapSignature=null;return;
  }
  const unlinked=bundle.players.filter(row=>!row.player_id).length;
  const issuePlayers=bundle.players.filter(row=>row.data_issues?.length).length;
  if(issuePlayers)$("game-snaps-issues").textContent=`${issuePlayers} ${issuePlayers===1?"player has":"players have"} a source issue: an inconsistent source percentage is shown as unavailable (—). Reported snap counts are retained; the original value is included in the download.`;
  const reportedTeams=new Set(bundle.players.map(row=>row.team)).size;
  const stamp=gameSnapshotTime(bundle.updated_at);
  status.textContent=`${bundle.players.length} reported players · ${reportedTeams} of 2 teams · ${unlinked} NFL IDs unlinked · `+
    (stamp.valid?`Snapshot ${new Date(bundle.updated_at).toLocaleString()}`:"Snapshot time unavailable")+
    (failed?" · Refresh unavailable; showing the last successful snapshot":"");
  if(!stamp.valid)status.classList.add("stale");
  const nextSignature=JSON.stringify(bundle.players);
  if(nextSignature===snapSignature)return;
  snapSignature=nextSignature;
  const sides=el("div",undefined,"game-stat-sides game-snap-sides");
  for(const side of ["away","home"]){
    const team=game[side],label=side==="away"?"Away":"Home";
    const panel=el("section",undefined,"game-stat-team");panel.dataset.side=side;panel.dataset.team=team;
    const heading=el("h3",undefined,"game-stat-team-heading");
    heading.append(gameMark(team),el("span",`${label} · ${teamName(team)}`));panel.append(heading);
    const rows=snapRowsForTeam(bundle,team);
    if(rows.length){
      panel.append(table(["Player","Pos.","Offense","Defense","Special teams"],rows.map(row=>[
        `${row.player_name}${row.player_id?"":" · ID unlinked"}${row.data_issues?.length?" · Source issue":""}`,row.position||"—",
        ...["offense","defense","st"].map(group=>snapValue(row[`${group}_snaps`],row[`${group}_pct`]))
      ]),`${label} ${teamName(team)} snap counts and percentages`));
    }else panel.append(el("p","No participation records reported for this team. This does not mean zero snaps.","game-stat-empty"));
    sides.append(panel);
  }
  const download=el("a","Download snap-count data","game-download");
  download.href=`data/snap_counts/${bundle.season}/${gameId}.json`;download.download=`${gameId}-snaps.json`;
  content.replaceChildren(sides,download);
}

async function jsonResponse(url) {
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(response.status===404)return null;
  if(!response.ok)throw new Error("Data unavailable");
  return response.json();
}

async function load() {
  if(busy||document.hidden)return;
  if(!validGameId(gameId)){
    $("game-status").textContent="Choose a game from NFL scores.";
    $("game-snaps-status").textContent="Choose a game to view participation.";
    $("game-stats").replaceChildren(el("p","Open a game from NFL stats or scores to view its published box score."));return;
  }
  busy=true;lastAttempt=Date.now();
  try{
    const [scoreResult,statsResult,snapResult]=await Promise.allSettled([jsonResponse("data/scores.json"),jsonResponse(`data/game_stats/${gameId.slice(0,4)}/${gameId}.json`),jsonResponse(`data/snap_counts/${gameId.slice(0,4)}/${gameId}.json`)]);
    const board=scoreResult.status==="fulfilled"?scoreResult.value:null;
    let bundle=statsResult.status==="fulfilled"?statsResult.value:lastBundle;
    let statsFailed=statsResult.status==="rejected";
    try{if(bundle)unpackStats(bundle,gameId);}catch{bundle=lastBundle;statsFailed=true;}
    if(lastBundle&&!bundle){bundle=lastBundle;statsFailed=true;}
    const scoreGame=Array.isArray(board?.games)?board.games.find(row=>validGameIdentity(row,gameId)):null;
    const historical=bundle?.historical===true;
    const scoreFailed=!historical && (scoreResult.status==="rejected" || !scoreGame);
    const game=(historical?bundle.game:scoreGame||bundle?.game)||lastGame;
    if(!validGameIdentity(game,gameId))throw new Error("Unknown game");
    render(game,bundle);lastGame=game;lastBundle=bundle;
    let snaps=snapResult.status==="fulfilled"?snapResult.value:lastSnaps;
    let snapsFailed=snapResult.status==="rejected";
    try{if(snaps)validateSnapCounts(snaps,gameId);}catch{snaps=lastSnaps;snapsFailed=true;}
    if(lastSnaps&&!snaps){snaps=lastSnaps;snapsFailed=true;}
    renderSnaps(game,snaps,snapsFailed);lastSnaps=snaps;
    if(scoreGame&&!historical){
      const checked=gameSnapshotTime(board.checked_at);
      if(checked.stale){
        $("game-status").textContent+=checked.valid?" · Score refresh is delayed":" · Score check time unavailable";
        $("game-status").classList.add("stale");
      }
    }
    if(scoreFailed||statsFailed){
      $("game-status").textContent+=" · Some data could not refresh";
      $("game-status").classList.add("stale");
      if(!bundle&&statsFailed)$("game-stats").replaceChildren(el("p","Box score temporarily unavailable. The score remains available above."));
    }
  }catch{
    if(lastGame){render(lastGame,lastBundle);renderSnaps(lastGame,lastSnaps,true);$("game-status").textContent+=" · Refresh unavailable";}
    else {$("game-status").textContent="Game data temporarily unavailable. Return to NFL scores to choose a game.";$("game-snaps-status").textContent="Participation unavailable until this game can be identified.";}
    $("game-status").classList.add("stale");
  }finally{busy=false;}
}
setInterval(load,60000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden&&Date.now()-lastAttempt>=60000)load();});
load();
