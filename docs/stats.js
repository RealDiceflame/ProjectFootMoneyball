import {TEAM_NAMES, scoreDisplay} from "./scores-data.mjs?v=20260915-weather1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
import {statsSummary, defaultStatsWeek, selectedGames, coverageText} from "./stats-data.mjs?v=20260915-stats1";
const $ = id=>document.getElementById(id);
const el = (tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const query = new URLSearchParams(location.search), leaders = query.get("view") === "leaders";
let summary=null, requestId=0, busy=false, lastAttempt=0;

function options(node, values, selected) {
  node.replaceChildren(...values.map(([value,label])=>{const option=el("option",label);option.value=String(value);return option;}));
  node.value=String(selected);node.disabled=false;
}
function gameCard(game) {
  const card=el("a",undefined,"stats-card stats-game");card.href=`game.html?game=${encodeURIComponent(game.game_id)}`;
  const date=Date.parse(game.kickoff), display=scoreDisplay(game);
  card.append(el("p",`Week ${game.week} · ${Number.isFinite(date)?new Date(date).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Time unavailable"}`));
  for(const side of ["away","home"]){
    const row=el("div",undefined,"stats-game-team");
    row.append(teamMark(game[side]),el("span",`${TEAM_NAMES[game[side]]}${side==="home"?" · Home":""}`),el("strong",display[side]));card.append(row);
  }
  card.append(el("p",game.stats_available?"Player & team box score →":"Box score pending · View game →","stats-game-link"));
  return card;
}
function leaderCard(metric, rows) {
  const card=el("section",undefined,"stats-card");card.append(el("h2",metric.label));
  if(!rows.length){card.append(el("p","No nonzero totals recorded yet.","stats-empty"));return card;}
  const table=el("table"),head=el("thead"),labels=el("tr"),body=el("tbody");
  table.setAttribute("aria-label",`Top 10 · ${metric.label}`);
  for(const text of ["Rank","Player",metric.key.endsWith("_long")?"Yards":"Total"]){const th=el("th",text);th.scope="col";labels.append(th);}head.append(labels);
  for(const row of rows){
    const tr=el("tr"),player=el("th",row.player);player.scope="row";
    player.append(el("span",`${row.teams.join(" / ")} · ${row.position}`,"stats-player-team"));
    tr.append(el("td",String(row.rank)),player,el("td",row.value.toLocaleString(undefined,{maximumFractionDigits:2})));body.append(tr);
  }
  table.append(head,body);card.append(table);return card;
}
function render() {
  if(!summary)return;
  const week=$("stats-week").value, results=$("stats-results");
  results.className="stats-grid";
  $("stats-status").textContent=coverageText(summary,week);
  $("stats-status").classList.remove("stale");
  const stale=Date.now()-Date.parse(summary.checked_at)>7*3600000;
  if(stale){$("stats-status").textContent+=" · Latest stats refresh is delayed";$("stats-status").classList.add("stale");}
  const cards=leaders
    ? summary.metrics.filter(metric=>metric.group===$("stats-category").value).map(metric=>leaderCard(metric,summary.periods[week]?.leaders[metric.key] || []))
    : selectedGames(summary,week).map(gameCard);
  results.replaceChildren(...(cards.length?cards:[el("p","No published game results for this selection yet.","stats-empty")]));
  for(const view of ["games","leaders"]){
    const params=new URLSearchParams({season:String(summary.season),week});
    if(view==="leaders")params.set("view",view);
    $("view-"+view).href="stats.html?"+params;
  }
}
async function fetchJson(path) {
  const response=await fetch(path,{cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error("Stats unavailable");
  return response.json();
}
async function loadSeason(preferredWeek) {
  const token=++requestId, season=Number($("stats-season").value);
  busy=true;lastAttempt=Date.now();
  const changed=summary?.season!==season;
  if(changed){summary=null;$("stats-results").replaceChildren();$("stats-week").disabled=true;$("stats-category").disabled=true;}
  $("stats-status").textContent="Loading stats…";
  try{
    const next=statsSummary(await fetchJson(`data/game_stats/${season}/summary.json`),season);
    if(token!==requestId)return;
    summary=next;
    const weeks=[...new Set(summary.games.map(game=>game.week))].sort((a,b)=>a-b);
    const wanted=preferredWeek || defaultStatsWeek(summary,leaders);
    options($("stats-week"),[["all",leaders?"Season totals":"All played games"],...weeks.map(week=>[week,`Week ${week}`])],
      wanted==="all" || weeks.includes(Number(wanted))?wanted:defaultStatsWeek(summary,leaders));
    const groups=[...new Set(summary.metrics.map(metric=>metric.group))], category=$("stats-category").value || query.get("category");
    options($("stats-category"),groups.map(group=>[group,group]),groups.includes(category)?category:groups[0]);
    render();
  }catch{
    if(token!==requestId)return;
    if(summary)render();
    $("stats-status").textContent=summary?"Refresh unavailable · Showing the last loaded stats":"Stats are temporarily unavailable for this season. Try another season or reload.";
    $("stats-status").classList.add("stale");
  }finally{if(token===requestId)busy=false;}
}
async function start() {
  busy=true;lastAttempt=Date.now();
  $("view-"+(leaders?"leaders":"games")).setAttribute("aria-current","page");
  $("stats-category-label").hidden=!leaders;
  document.title=`${leaders?"League leaders":"Game results"} · OutlierBaseline`;
  try{
    const catalogue=await fetchJson("data/game_stats/index.json");
    const seasons=catalogue.seasons.filter(season=>Number.isInteger(season)&&season>=2000&&season<=2100);
    if(!seasons.length)throw new Error("No seasons");
    const wanted=Number(query.get("season"));
    options($("stats-season"),seasons.map(season=>[season,season]),seasons.includes(wanted)?wanted:seasons[0]);
    await loadSeason(query.get("week"));
  }catch{$("stats-status").textContent="Game stats are temporarily unavailable. Please reload to try again.";}
  finally{busy=false;}
}
$("stats-season").addEventListener("change",()=>loadSeason());
$("stats-week").addEventListener("change",render);
$("stats-category").addEventListener("change",render);
async function refresh(){
  if(busy||document.hidden||Date.now()-lastAttempt<300000)return;
  if(!$("stats-season").value)await start();
  else await loadSeason($("stats-week").value);
}
setInterval(refresh,300000);
document.addEventListener("visibilitychange",refresh);
start();
