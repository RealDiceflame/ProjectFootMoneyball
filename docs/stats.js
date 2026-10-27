import {TEAM_NAMES, scoreDisplay} from "./scores-data.mjs?v=20260915-weather1";
import {teamMark} from "./team-logos.mjs?v=20260915-games1";
import {statsSummary, defaultStatsWeek, selectedGames, coverageText, periodOverview, periodSpotlights, metricUnit, statsFreshness} from "./stats-data.mjs?v=20261027-stats-editorial1";
const $ = id=>document.getElementById(id);
const el = (tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const query = new URLSearchParams(location.search), leaders = query.get("view") === "leaders";
let summary=null, requestId=0, busy=false, lastAttempt=0, refreshFailed=false, resultsSignature="", contextSignature="";
let categoryChoice=query.get("category") || "";

function options(node, values, selected) {
  node.replaceChildren(...values.map(([value,label])=>{const option=el("option",label);option.value=String(value);return option;}));
  node.value=String(selected);node.disabled=false;
}
function gameCard(game) {
  const card=el("a",undefined,"stats-card stats-game");card.href=`game.html?game=${encodeURIComponent(game.game_id)}`;
  const date=Date.parse(game.kickoff), display=scoreDisplay(game);
  const meta=el("header",undefined,"stats-game-meta"), time=el("time",Number.isFinite(date)?new Date(date).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):"Time unavailable","stats-game-time");
  if(Number.isFinite(date))time.dateTime=game.kickoff;
  meta.append(el("p",`Week ${game.week}`,"stats-game-week"),time);card.append(meta);
  for(const side of ["away","home"]){
    const row=el("div",undefined,"stats-game-team");
    const name=el("span",TEAM_NAMES[game[side]],"stats-game-name");
    name.append(el("small",side==="home"?"Home":"Away","stats-game-location"));
    row.append(teamMark(game[side]),name,el("strong",display[side]));card.append(row);
  }
  const footer=el("div",undefined,"stats-game-footer");
  footer.append(el("p",display.label,"stats-game-status"),el("p",game.stats_available?"Player & team box score →":"Box score pending · View game →","stats-game-link"));
  card.append(footer);
  return card;
}
function leaderCard(metric, rows) {
  const card=el("section",undefined,"stats-card stats-leader-card"), heading=el("header",undefined,"stats-card-heading");
  heading.append(el("p",metric.group,"stats-eyebrow"),el("h3",metric.label),el("small",`${metricUnit(metric)} · ${metric.key.endsWith("_long")?"Longest recorded, not a sum":"Available box scores only"}`,"stats-leader-unit"));card.append(heading);
  if(!rows.length){card.append(el("p","No nonzero totals recorded yet.","stats-empty"));return card;}
  const table=el("table"),head=el("thead"),labels=el("tr"),body=el("tbody");
  table.setAttribute("aria-label",`Top 10 · ${metric.label}`);
  for(const text of ["Rank","Player",metricUnit(metric)]){const th=el("th",text);th.scope="col";labels.append(th);}head.append(labels);
  for(const row of rows){
    const tr=el("tr"),player=el("th",row.player);player.scope="row";
    player.append(el("span",`${row.teams.join(" / ")} · ${row.position}`,"stats-player-team"));
    const rank=el("td",String(row.rank),"stats-rank");
    if(rows.filter(other=>other.rank===row.rank).length>1)rank.setAttribute("aria-label",`Joint rank ${row.rank}`);
    tr.append(rank,player,el("td",row.value.toLocaleString(undefined,{maximumFractionDigits:2}),"stats-leader-value"));body.append(tr);
  }
  table.append(head,body);card.append(table);return card;
}

function periodName(week) {return week==="all"?"Season totals":`Week ${week}`;}
function viewUrl(view, week, category=$("stats-category").value, season=Number($("stats-season").value)) {
  const params=new URLSearchParams({season:String(season),week});
  if(view==="leaders")params.set("view",view);
  if(category)params.set("category",category);
  return "stats.html?"+params;
}
function overviewItem(label,value,note) {
  const item=el("div",undefined,"stats-overview-item");
  item.append(el("dt",label),el("dd",String(value)),el("small",note));return item;
}
function renderContext(week) {
  const overview=periodOverview(summary,week),freshness=statsFreshness(overview.checked_at);
  const checked=freshness.valid?new Date(overview.checked_at).toLocaleString(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}):"Time unavailable";
  $("stats-overview").replaceChildren(
    overviewItem("Published games",overview.published,`${periodName(week)} · Results in the saved feed`),
    overviewItem("Box scores available",overview.archived,overview.pending?`${overview.pending} reported game${overview.pending===1?"":"s"} awaiting stats`:overview.archived?"Player and team statistics archived":"No archived stats for this selection"),
    overviewItem("Weeks with box scores",overview.weeks.length,overview.coverage),
    overviewItem("Archive checked",checked,"Check time, not every game's update time"),
  );
  const spotlights=periodSpotlights(summary,week), signature=JSON.stringify({season:summary.season,week,
    archived:overview.archived,pending:overview.pending,spotlights});
  if(signature===contextSignature)return;
  contextSignature=signature;
  const cards=spotlights.map(({metric,rows,rank})=>{
    const card=el("section",undefined,"stats-spotlight"),link=el("a",`View ${metric.group.toLowerCase()} leaders →`,"stats-context-link");
    link.href=viewUrl("leaders",week,metric.group);
    const teams=[...new Set(rows.flatMap(row=>row.teams))].join(" / ");
    card.append(el("p",metric.label,"stats-eyebrow"),el("h3",rows.map(row=>row.player).join(" / ")),
      el("strong",`${rows[0].value.toLocaleString()} ${metricUnit(metric).toLowerCase()}`,"stats-spotlight-value"),
      el("p",`${rows.length>1?"Joint leader":"Rank "+rank} · ${teams}`,"stats-small"),link);return card;
  });
  $("stats-context").replaceChildren(el("p",`${summary.season} · ${periodName(week)}`,"stats-context-period"),
    ...(cards.length?cards:[el("p","No passing, rushing or receiving leaders recorded for this selection yet.","stats-empty")]),
    el("p",`Based on ${overview.archived} available game box score${overview.archived===1?"":"s"}. ${overview.pending?"Pending box scores are not included in leader totals.":"Statistics can arrive late or be corrected."}`,"stats-context-note"));
}
function render() {
  if(!summary)return;
  const week=$("stats-week").value, results=$("stats-results");
  results.className=leaders?"stats-grid stats-leaders-grid":"stats-grid stats-games-grid";
  $("stats-status").textContent=coverageText(summary,week);
  $("stats-status").classList.remove("stale");
  const freshness=statsFreshness(summary.checked_at);
  if(freshness.stale){$("stats-status").textContent+=freshness.valid?" · Latest stats refresh is delayed":" · Archive check time unavailable";$("stats-status").classList.add("stale");}
  if(refreshFailed){$("stats-status").textContent+=" · Refresh unavailable · Showing the last loaded stats";$("stats-status").classList.add("stale");}
  renderContext(week);
  $("stats-results-heading").textContent=`${periodName(week)} · ${leaders?$("stats-category").value+" leaders":"Game results"}`;
  const games=selectedGames(summary,week),metrics=summary.metrics.filter(metric=>metric.group===$("stats-category").value);
  $("stats-results-count").textContent=leaders?`${metrics.length} leaderboards · Up to 10 players per metric · Equal values share a rank`:`${games.length} published game${games.length===1?"":"s"} · Open a game for player and team stats`;
  const signature=JSON.stringify({week,category:$("stats-category").value,games:leaders?null:games,
    metrics:leaders?metrics:null,period:leaders?summary.periods[week]:null});
  if(signature!==resultsSignature){
    const cards=leaders?metrics.map(metric=>leaderCard(metric,summary.periods[week]?.leaders[metric.key] || [])):games.map(gameCard);
    results.replaceChildren(...(cards.length?cards:[el("p","No published game results for this selection yet.","stats-empty")]));
    resultsSignature=signature;
  }
  results.setAttribute("aria-busy","false");
  for(const view of ["games","leaders"]){
    $("view-"+view).href=viewUrl(view,week);
  }
  globalThis.history?.replaceState(null,"",viewUrl(leaders?"leaders":"games",week)+(location.hash || ""));
}
async function fetchJson(path) {
  const response=await fetch(path,{cache:"no-store",signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error("Stats unavailable");
  return response.json();
}
async function loadSeason(preferredWeek) {
  const token=++requestId, season=Number($("stats-season").value);
  busy=true;lastAttempt=Date.now();
  // Tabs and the address must follow the attempted season even if its snapshot
  // is unavailable. Never leave links pointing at the last successful season.
  const candidate=String(preferredWeek || $("stats-week").value || "all");
  const requestedWeek=candidate==="all" || /^(?:[1-9]|1[0-8])$/.test(candidate)?candidate:"all";
  const category=categoryChoice || $("stats-category").value;
  for(const view of ["games","leaders"])$("view-"+view).href=viewUrl(view,requestedWeek,category,season);
  globalThis.history?.replaceState(null,"",viewUrl(leaders?"leaders":"games",requestedWeek,category,season)+(location.hash || ""));
  const changed=summary?.season!==season;
  if(changed){
    summary=null;resultsSignature="";contextSignature="";refreshFailed=false;
    $("stats-results").replaceChildren(el("p","Loading this season’s saved results…","stats-empty"));
    $("stats-overview").replaceChildren();
    $("stats-context").replaceChildren(el("p","Loading this season’s coverage and leaders…","stats-empty"));
    $("stats-results-heading").textContent=`${season} · Loading ${leaders?"leaders":"game results"}`;
    $("stats-results-count").textContent="";
    $("stats-week").replaceChildren();$("stats-week").disabled=true;$("stats-category").disabled=true;
  }
  $("stats-results").setAttribute("aria-busy","true");
  $("stats-status").textContent="Loading stats…";
  try{
    const next=statsSummary(await fetchJson(`data/game_stats/${season}/summary.json`),season);
    if(token!==requestId)return;
    summary=next;refreshFailed=false;
    const weeks=[...new Set(summary.games.map(game=>game.week))].sort((a,b)=>a-b);
    const wanted=(!changed && $("stats-week").value) || preferredWeek || defaultStatsWeek(summary,leaders);
    options($("stats-week"),[["all","All weeks"],...weeks.map(week=>[week,`Week ${week}`])],
      wanted==="all" || weeks.includes(Number(wanted))?wanted:defaultStatsWeek(summary,leaders));
    const groups=[...new Set(summary.metrics.map(metric=>metric.group))], category=categoryChoice || $("stats-category").value;
    options($("stats-category"),groups.map(group=>[group,group]),groups.includes(category)?category:groups[0]);
    categoryChoice=$("stats-category").value;
    render();
  }catch{
    if(token!==requestId)return;
    if(summary){refreshFailed=true;render();}
    else {
      $("stats-status").textContent="Stats are temporarily unavailable for this season. Try another season or reload.";
      $("stats-results").replaceChildren(el("p","Saved results could not be loaded. Try another season or retry later.","stats-empty"));
      $("stats-context").replaceChildren(el("p","Selected-season coverage and leaders are unavailable.","stats-empty"));
      $("stats-results-heading").textContent=`${season} · Results unavailable`;
    }
    $("stats-status").classList.add("stale");
  }finally{if(token===requestId){busy=false;$("stats-results").setAttribute("aria-busy","false");}}
}
async function start() {
  busy=true;lastAttempt=Date.now();
  $("view-"+(leaders?"leaders":"games")).setAttribute("aria-current","page");
  $("stats-category-label").hidden=!leaders;
  $("stats-heading").textContent=leaders?"NFL league leaders":"NFL game results";
  $("stats-description").textContent=leaders?"Follow the players setting the pace. Explore top recorded totals by season, week and statistical category.":"Every published result, with the numbers behind it. Browse reported scores and open archived player and team box scores.";
  document.title=`${leaders?"League leaders":"Game results"} · OutlierBaseline`;
  try{
    const catalogue=await fetchJson("data/game_stats/index.json");
    const seasons=[...new Set((Array.isArray(catalogue?.seasons)?catalogue.seasons:[]).filter(season=>Number.isInteger(season)&&season>=2000&&season<=2100))].sort((a,b)=>b-a);
    if(!seasons.length)throw new Error("No seasons");
    const wanted=Number(query.get("season"));
    options($("stats-season"),seasons.map(season=>[season,season]),seasons.includes(wanted)?wanted:seasons[0]);
    await loadSeason(query.get("week"));
  }catch{
    $("stats-status").textContent="Game stats are temporarily unavailable. Please reload to try again.";
    $("stats-status").classList.add("stale");
    $("stats-results").replaceChildren(el("p","The saved stats catalogue is unavailable. Retrying automatically.","stats-empty"));
    $("stats-context").replaceChildren(el("p","Coverage and leaders will appear when the archive is available.","stats-empty"));
  }
  finally{busy=false;$("stats-results").setAttribute("aria-busy","false");}
}
$("stats-season").addEventListener("change",()=>loadSeason());
$("stats-week").addEventListener("change",render);
$("stats-category").addEventListener("change",()=>{categoryChoice=$("stats-category").value;render();});
$("stats-sidebar").addEventListener("click",event=>{
  if(!event.target.closest("a[href='#stats-source-notes']"))return;
  const notes=$("stats-source-notes");
  event.preventDefault();notes.open=true;notes.querySelector("summary").focus();
  if(summary)globalThis.history?.replaceState(null,"",viewUrl(leaders?"leaders":"games",$("stats-week").value)+"#stats-source-notes");
});
async function refresh(){
  if(busy||document.hidden||Date.now()-lastAttempt<300000)return;
  if(!$("stats-season").value)await start();
  else await loadSeason($("stats-week").value);
}
setInterval(refresh,300000);
document.addEventListener("visibilitychange",refresh);
start();
